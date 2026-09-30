# Shared native command runner. Importing this file has no process side effects.
function ConvertTo-WindowsCommandLineArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [System.Text.StringBuilder]::new()
    $quote = [char]34
    $slash = [char]92
    [void]$builder.Append($quote)
    $backslashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq $slash) {
            $backslashes++
            continue
        }
        if ($character -eq $quote) {
            [void]$builder.Append((('\' * ($backslashes * 2 + 1)) -join ''))
            [void]$builder.Append($quote)
            $backslashes = 0
            continue
        }
        if ($backslashes -gt 0) { [void]$builder.Append((('\' * $backslashes) -join '')) }
        [void]$builder.Append($character)
        $backslashes = 0
    }
    if ($backslashes -gt 0) { [void]$builder.Append((('\' * ($backslashes * 2)) -join '')) }
    [void]$builder.Append($quote)
    return $builder.ToString()
}

function Invoke-BoundedCommand([string]$ExecutablePath, [string[]]$Arguments, [ValidateRange(1,600)][int]$TimeoutSeconds = 60) {
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $ExecutablePath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $startInfo.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $startInfo.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
        if ($null -ne $startInfo.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
        }
        else {
            $startInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) })) -join ' '
        }
        $process = [System.Diagnostics.Process]::new()
        $process.StartInfo = $startInfo
        if (-not $process.Start()) { throw '通知进程未能启动。' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $finished = $process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $finished) {
            try { $process.Kill($true) } catch { try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch { } }
            [void]$process.WaitForExit(5000)
            return [pscustomobject]@{
                TimedOut = $true
                ExitCode = 124
                Output = @($(if ($stdoutTask.Wait(2000)) { $stdoutTask.GetAwaiter().GetResult() } else { '' }))
                Error = @($(if ($stderrTask.Wait(2000)) { $stderrTask.GetAwaiter().GetResult() } else { '' }))
            }
        }
        return [pscustomobject]@{
            TimedOut = $false
            ExitCode = $process.ExitCode
            Output = @($(if ($stdoutTask.Wait(2000)) { $stdoutTask.GetAwaiter().GetResult() } else { '' }))
            Error = @($(if ($stderrTask.Wait(2000)) { $stderrTask.GetAwaiter().GetResult() } else { '' }))
        }
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}
