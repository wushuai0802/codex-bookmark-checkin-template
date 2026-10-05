# Shared bounded native transport for the private observation sync scripts.
# Native SSH is driven through System.Diagnostics.Process instead of a
# PowerShell/cmd pipeline so stdin is binary-safe and every phase is bounded.

function ConvertTo-SyncWindowsCommandLineArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [System.Text.StringBuilder]::new()
    $quote = [char]34
    $slash = [char]92
    [void]$builder.Append($quote)
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq $slash) { $backslashes++; continue }
        if ($character -eq $quote) {
            [void]$builder.Append((('\\' * ($backslashes * 2 + 1)) -join ''))
            [void]$builder.Append($quote)
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append((('\\' * $backslashes) -join '')) }
        [void]$builder.Append($character)
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$builder.Append((('\\' * ($backslashes * 2)) -join '')) }
    [void]$builder.Append($quote)
    return $builder.ToString()
}

function Get-SyncRemainingMilliseconds([datetime]$Deadline) {
    $milliseconds = [int][Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
    return [Math]::Max(1, [Math]::Min([int]::MaxValue, $milliseconds))
}

function Stop-SyncProcessTree([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) { $Process.Kill($true) }
    }
    catch {
        # Windows PowerShell/.NET Framework has no Kill(Boolean) overload.
        try { & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null } catch { }
    }
    try { [void]$Process.WaitForExit(5000) } catch { }
}

function Get-SyncTransportFailureCause([int]$ExitCode, [string]$ErrorText, [bool]$TimedOut) {
    if ($TimedOut) { return 'connection_timeout' }
    if ($ErrorText -match '(?i)timed out|timeout') { return 'connection_timeout' }
    if ($ErrorText -match '(?i)connection reset|connection closed|broken pipe|connection aborted') { return 'connection_interrupted' }
    if ($ErrorText -match '(?i)permission denied|authentication failed') { return 'authentication_failed' }
    if ($ErrorText -match '(?i)host key verification failed|host identification has changed') { return 'host_key_verification_failed' }
    if ($ErrorText -match '(?i)could not resolve|name or service not known') { return 'name_resolution_failed' }
    if ($ErrorText -match '(?i)no space left on device') { return 'remote_storage_full' }
    if ($ExitCode -eq 255) { return 'ssh_transport_failed' }
    if ($ExitCode -eq 124) { return 'connection_timeout' }
    return 'remote_command_failed'
}

function Invoke-BoundedSyncProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Phase,
        [string]$InputFile = '',
        [ValidateRange(1, 180)][int]$TimeoutSeconds = 30
    )

    $process = $null; $inputStream = $null; $copyCancellation = $null
    $copyTask = $null; $stdoutTask = $null; $stderrTask = $null
    $timedOut = $false; $errorText = ''; $exitCode = -1
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    try {
        if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
            return [pscustomobject]@{exitCode=-1;failure="$Phase failed (exit=-1; cause=executable_missing)";output='';error='';timedOut=$false}
        }
        if ($InputFile -and -not (Test-Path -LiteralPath $InputFile -PathType Leaf)) {
            return [pscustomobject]@{exitCode=-1;failure="$Phase failed (exit=-1; cause=input_missing)";output='';error='';timedOut=$false}
        }
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Executable; $startInfo.UseShellExecute = $false; $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardInput = $true; $startInfo.RedirectStandardOutput = $true; $startInfo.RedirectStandardError = $true
        if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
        } else {
            $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-SyncWindowsCommandLineArgument ([string]$_) }) -join ' ')
        }
        $process = [System.Diagnostics.Process]::new(); $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw 'native process could not start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync(); $stderrTask = $process.StandardError.ReadToEndAsync()
        if ($InputFile) {
            $inputStream = [System.IO.File]::OpenRead($InputFile)
            $copyCancellation = [System.Threading.CancellationTokenSource]::new()
            $copyTask = $inputStream.CopyToAsync($process.StandardInput.BaseStream, 65536, $copyCancellation.Token)
            if (-not $copyTask.Wait((Get-SyncRemainingMilliseconds $deadline))) { $timedOut=$true; throw 'stdin copy timed out' }
            $copyTask.GetAwaiter().GetResult()
        }
        # EOF is required for `cat > file` and must also be sent for commands
        # that do not consume stdin, otherwise ssh can wait indefinitely.
        try { $process.StandardInput.Close() } catch { }
        if (-not $process.WaitForExit((Get-SyncRemainingMilliseconds $deadline))) { $timedOut=$true; throw 'native process timed out' }
        $exitCode = $process.ExitCode
        $stdout = if ($stdoutTask.Wait(2000)) { $stdoutTask.GetAwaiter().GetResult() } else { '' }
        $errorText = if ($stderrTask.Wait(2000)) { $stderrTask.GetAwaiter().GetResult() } else { '' }
        $failure = if ($exitCode -ne 0) { "$Phase failed (exit=$exitCode; cause=$(Get-SyncTransportFailureCause $exitCode $errorText $false))" } else { $null }
        return [pscustomobject]@{exitCode=$exitCode;failure=$failure;output=[string]$stdout;error=[string]$errorText;timedOut=$false}
    }
    catch {
        if ($timedOut) { $exitCode=124 } elseif ($process -and $process.HasExited) { $exitCode=$process.ExitCode }
        $cause = Get-SyncTransportFailureCause $exitCode $errorText $timedOut
        return [pscustomobject]@{exitCode=$exitCode;failure="$Phase failed (exit=$exitCode; cause=$cause)";output='';error='';timedOut=$timedOut}
    }
    finally {
        if ($copyCancellation) { try { $copyCancellation.Cancel() } catch { } }
        if ($inputStream) { try { $inputStream.Dispose() } catch { } }
        if ($process) {
            try { $process.StandardInput.Close() } catch { }
            try { if (-not $process.HasExited) { Stop-SyncProcessTree $process } } catch { Stop-SyncProcessTree $process }
            try { $process.Dispose() } catch { }
        }
        if ($copyCancellation) { try { $copyCancellation.Dispose() } catch { } }
    }
}
