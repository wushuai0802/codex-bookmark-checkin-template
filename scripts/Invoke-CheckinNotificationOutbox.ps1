[CmdletBinding()]
param(
    [string]$OutboxPath,
    [string]$ConfigPath,
    [int]$MaxItems = 0,
    [datetime]$NowUtc = [datetime]::MinValue,
    [int]$BaseRetryMinutes = 0,
    [int]$MaxRetryMinutes = 0,
    [int]$RetentionDays = 0,
    [int]$TimeoutSeconds = 0,
    [switch]$ForceDue,
    [string]$MutexName = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$localConfigPath = Join-Path $root 'config\config.json'
$defaultsPath = Join-Path $root 'config\defaults.json'
$effectiveConfigPath = if ($ConfigPath) { $ConfigPath } elseif (Test-Path -LiteralPath $localConfigPath) { $localConfigPath } else { $defaultsPath }
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $effectiveConfigPath | ConvertFrom-Json
$notification = $config.notification
$mode = if ($notification.mode) { [string]$notification.mode } else { 'none' }
if ($mode -eq 'none') {
    [pscustomobject]@{ processed = 0; delivered = 0; deferred = 0; invalid = 0; disabled = $true; busy = $false } | ConvertTo-Json -Compress
    exit 0
}
if ($mode -ne 'command') { throw "不支持的通知模式：$mode" }

$executable = [string]$notification.executable
if (-not $executable) { throw '命令型通知缺少 executable。' }
if (-not (Test-Path -LiteralPath $executable)) {
    $command = Get-Command $executable -ErrorAction SilentlyContinue
    if (-not $command) { throw "通知程序不存在：$executable" }
    $executable = $command.Source
}
$executableExtension = [System.IO.Path]::GetExtension($executable).ToLowerInvariant()
if ($executableExtension -notin @('.exe', '.com')) {
    throw '通知 executable 必须是原生 .exe/.com；脚本请通过 pwsh.exe -File 或 node.exe 作为参数调用。'
}

if (-not $OutboxPath) { $OutboxPath = Join-Path $root 'data\notification-outbox' }
[System.IO.Directory]::CreateDirectory($OutboxPath) | Out-Null
$now = if ($NowUtc -eq [datetime]::MinValue) { [datetime]::UtcNow } else { $NowUtc.ToUniversalTime() }
if ($MaxItems -le 0) { $MaxItems = if ($notification.outboxMaxItems) { [int]$notification.outboxMaxItems } else { 20 } }
if ($BaseRetryMinutes -le 0) { $BaseRetryMinutes = if ($notification.retryBaseMinutes) { [int]$notification.retryBaseMinutes } else { 2 } }
if ($MaxRetryMinutes -le 0) { $MaxRetryMinutes = if ($notification.retryMaxMinutes) { [int]$notification.retryMaxMinutes } else { 360 } }
if ($RetentionDays -le 0) { $RetentionDays = if ($notification.outboxRetentionDays) { [int]$notification.outboxRetentionDays } else { 30 } }
if ($TimeoutSeconds -le 0) { $TimeoutSeconds = if ($notification.timeoutSeconds) { [int]$notification.timeoutSeconds } else { 60 } }
if (-not $MutexName) { $MutexName = if ($notification.outboxMutexName) { [string]$notification.outboxMutexName } else { 'Local\CodexBookmarkCheckinNotificationOutbox' } }
$MaxItems = [Math]::Max(1, [Math]::Min(100, $MaxItems))
$BaseRetryMinutes = [Math]::Max(1, [Math]::Min(1440, $BaseRetryMinutes))
$MaxRetryMinutes = [Math]::Max($BaseRetryMinutes, [Math]::Min(10080, $MaxRetryMinutes))
$RetentionDays = [Math]::Max(1, [Math]::Min(3650, $RetentionDays))
$TimeoutSeconds = [Math]::Max(1, [Math]::Min(600, $TimeoutSeconds))

function Write-OutboxItemAtomic([string]$Path, [object]$Value) {
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-CommandAcknowledgement([object[]]$Output) {
    $raw = ($Output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    try {
        $candidate = $raw | ConvertFrom-Json
        if ($null -ne $candidate.accepted -or $null -ne $candidate.duplicate) { return $candidate }
    }
    catch { }
    foreach ($line in @($Output | Select-Object -Last 10)) {
        try {
            $candidate = ([string]$line) | ConvertFrom-Json
            if ($null -ne $candidate.accepted -or $null -ne $candidate.duplicate) { return $candidate }
        }
        catch { }
    }
    return $null
}

function Get-PayloadHash([object]$Item) {
    $material = @(
        [string]$Item.eventKey, [string]$Item.taskId, [string]$Item.name,
        [string]$Item.source, [string]$Item.status, [string]$Item.summary
    ) -join "`n"
    $hash = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($material))
    return [System.Convert]::ToHexString($hash).ToLowerInvariant()
}

function Get-RetryDelayMinutes([int]$Attempts) {
    $exponent = [Math]::Min(10, [Math]::Max(0, $Attempts - 1))
    return [int][Math]::Min($MaxRetryMinutes, [Math]::Ceiling($BaseRetryMinutes * [Math]::Pow(2, $exponent)))
}

function Quarantine-OutboxFile([System.IO.FileInfo]$File) {
    $quarantine = Join-Path $OutboxPath 'quarantine'
    [System.IO.Directory]::CreateDirectory($quarantine) | Out-Null
    $destination = Join-Path $quarantine "$($File.BaseName).$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).invalid.json"
    try {
        Move-Item -LiteralPath $File.FullName -Destination $destination -Force -ErrorAction Stop
        $script:quarantined++
    }
    catch { }
}

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

function Invoke-NotificationCommand([string]$ExecutablePath, [string[]]$Arguments) {
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $ExecutablePath
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
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
                Output = @($stdoutTask.GetAwaiter().GetResult())
                Error = @($stderrTask.GetAwaiter().GetResult())
            }
        }
        return [pscustomobject]@{
            TimedOut = $false
            ExitCode = $process.ExitCode
            Output = @($stdoutTask.GetAwaiter().GetResult())
            Error = @($stderrTask.GetAwaiter().GetResult())
        }
    }
    finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function Get-OutboxLogicalScope([object]$Item) {
    $match = [regex]::Match([string]$Item.eventKey, ':(\d{4}-\d{2}-\d{2}):[^:]+$')
    if (-not $match.Success) { return [string]$Item.eventKey }
    return "$([string]$Item.source)|$([string]$Item.taskId)|$($match.Groups[1].Value)"
}

$mutexCreated = $false
$mutex = [System.Threading.Mutex]::new($true, $MutexName, [ref]$mutexCreated)
if (-not $mutexCreated) {
    [pscustomobject]@{ processed = 0; delivered = 0; deferred = 0; invalid = 0; pruned = 0; disabled = $false; busy = $true } | ConvertTo-Json -Compress
    exit 0
}

$processed = 0
$delivered = 0
$deferred = 0
$invalid = 0
$quarantined = 0
$superseded = 0
$pruned = 0
try {
    $pendingItems = [System.Collections.Generic.List[object]]::new()
    $dueItems = [System.Collections.Generic.List[object]]::new()
    foreach ($file in @(Get-ChildItem -LiteralPath $OutboxPath -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        try {
            $item = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName | ConvertFrom-Json
            if ($item.delivered -eq $true) {
                $deliveredAt = if ($item.deliveredAt) {
                    try { ([datetimeoffset]$item.deliveredAt).ToUniversalTime() } catch { [datetimeoffset]$file.LastWriteTimeUtc }
                } else { [datetimeoffset]$file.LastWriteTimeUtc }
                if ($deliveredAt -le [datetimeoffset]$now.AddDays(-$RetentionDays)) {
                    Remove-Item -LiteralPath $file.FullName -Force
                    $pruned++
                }
                continue
            }
            $computedHash = Get-PayloadHash $item
            $storedHash = [string]$item.payloadHash
            if ($storedHash -notmatch '^[a-f0-9]{64}$' -or $storedHash -ne $computedHash) {
                $invalid++
                Quarantine-OutboxFile $file
                continue
            }
            $dueAt = if ($item.nextAttemptAt) { ([datetime]$item.nextAttemptAt).ToUniversalTime() } else { [datetime]::MinValue }
            $createdAt = try { ([datetimeoffset]$item.createdAt).ToUniversalTime() } catch { [datetimeoffset]$file.LastWriteTimeUtc }
            $pendingItems.Add([pscustomobject]@{
                File = $file
                Item = $item
                DueAt = $dueAt
                CreatedAt = $createdAt
                Scope = Get-OutboxLogicalScope $item
            })
        }
        catch { $invalid++; Quarantine-OutboxFile $file }
    }

    foreach ($group in @($pendingItems | Group-Object Scope)) {
        $ordered = @($group.Group | Sort-Object CreatedAt, @{ Expression = { $_.File.Name } } -Descending)
        $latest = $ordered | Select-Object -First 1
        foreach ($stale in @($ordered | Select-Object -Skip 1)) {
            $stale.Item.delivered = $true
            $stale.Item.deliveredAt = $now.ToString('o')
            $stale.Item.updatedAt = $now.ToString('o')
            $stale.Item.disposition = 'superseded'
            $stale.Item.nextAttemptAt = $null
            $stale.Item.lastError = $null
            Write-OutboxItemAtomic $stale.File.FullName $stale.Item
            $superseded++
        }
        if ($null -ne $latest -and ($ForceDue -or $latest.DueAt -le $now)) { $dueItems.Add($latest) }
    }

    foreach ($entry in @($dueItems | Sort-Object DueAt, @{ Expression = { $_.File.Name } } | Select-Object -First $MaxItems)) {
        $item = $entry.Item
        $item.attempts = [int]$item.attempts + 1
        $item.updatedAt = $now.ToString('o')
        $acknowledgement = $null
        $failureCode = $null

        try {
            $values = @{
                '{status}' = [string]$item.status; '{summary}' = [string]$item.summary;
                '{taskId}' = [string]$item.taskId; '{name}' = [string]$item.name;
                '{source}' = [string]$item.source; '{eventKey}' = [string]$item.eventKey
            }
            $arguments = @($notification.arguments | ForEach-Object {
                $value = [string]$_
                foreach ($replacement in $values.GetEnumerator()) { $value = $value.Replace($replacement.Key, $replacement.Value) }
                $value
            })
            $invocation = Invoke-NotificationCommand $executable $arguments
            if ($invocation.TimedOut) {
                $failureCode = 'timeout'
                $commandOutput = @()
                $exitCode = 124
            }
            else {
                $commandOutput = @($invocation.Output + $invocation.Error)
                $exitCode = $invocation.ExitCode
            }
            if ($invocation.TimedOut) {
                # Keep the explicit timeout reason; do not rewrite it as exit_code_124.
            }
            elseif ($exitCode -eq 0) {
                $acknowledgement = Get-CommandAcknowledgement $commandOutput
                if (-not $acknowledgement) { $failureCode = 'acknowledgement_missing' }
            }
            else { $failureCode = "exit_code_$exitCode" }
        }
        catch { $failureCode = 'invocation_failed' }

        if ($acknowledgement.accepted -eq $true -or $acknowledgement.duplicate -eq $true) {
            $item.delivered = $true
            $item.deliveredAt = $now.ToString('o')
            $item.disposition = if ($acknowledgement.duplicate -eq $true) { 'duplicate' } else { 'accepted' }
            $item.nextAttemptAt = $null
            $item.lastError = $null
            $delivered++
        }
        else {
            $item.delivered = $false
            $item.nextAttemptAt = $now.AddMinutes((Get-RetryDelayMinutes ([int]$item.attempts))).ToString('o')
            $item.lastError = if ($failureCode) { $failureCode } else { 'acknowledgement_rejected' }
            $deferred++
        }
        Write-OutboxItemAtomic $entry.File.FullName $item
        $processed++
    }
}
finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}

[pscustomobject]@{
    processed = $processed; delivered = $delivered; deferred = $deferred;
    invalid = $invalid; quarantined = $quarantined; superseded = $superseded;
    pruned = $pruned;
    disabled = $false; busy = $false
} | ConvertTo-Json -Compress
