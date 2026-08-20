[CmdletBinding()]
param(
    [string]$OutboxPath,

    # 外部通知投递程序，按部署环境不同而不同。
    # 可用 CHECKIN_STATION_PATH 环境变量指定，或调用时显式传入 -StationPath。
    [string]$StationPath = $env:CHECKIN_STATION_PATH,

    [ValidateRange(1, 100)]
    [int]$MaxItems = 20,

    [switch]$ForceDue,

    [datetime]$NowUtc = [datetime]::MinValue,

    [ValidateRange(1, 60)]
    [int]$BaseRetryMinutes = 2,

    [ValidateRange(5, 1440)]
    [int]$MaxRetryMinutes = 360,

    [ValidateRange(1, 3650)]
    [int]$RetentionDays = 30,

    [ValidateRange(1, 600)]
    [int]$TimeoutSeconds = 60,

    [string[]]$StationArgumentPrefix = @(),

    [string]$MutexName = 'Local\ChromeDailyCheckinNotificationOutbox'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutboxPath) { $OutboxPath = Join-Path $root 'data\notification-outbox' }
[System.IO.Directory]::CreateDirectory($OutboxPath) | Out-Null
$now = if ($NowUtc -eq [datetime]::MinValue) { [datetime]::UtcNow } else { $NowUtc.ToUniversalTime() }

function Write-OutboxItemAtomic {
    param([string]$Path, [object]$Value)
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 5), [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
}

function Get-StationAcknowledgement {
    param([object[]]$Output)
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

function Get-RetryDelayMinutes {
    param([int]$Attempts)
    $exponent = [Math]::Min(10, [Math]::Max(0, $Attempts - 1))
    $delay = [double]$BaseRetryMinutes * [Math]::Pow(2, $exponent)
    return [int][Math]::Min($MaxRetryMinutes, [Math]::Ceiling($delay))
}

function Get-PayloadHash {
    param([object]$Item)
    $material = @(
        [string]$Item.eventKey, [string]$Item.taskId, [string]$Item.name,
        [string]$Item.source, [string]$Item.status, [string]$Item.summary
    ) -join "`n"
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($material)
    $hash = [System.Security.Cryptography.SHA256]::HashData($bytes)
    return [System.Convert]::ToHexString($hash).ToLowerInvariant()
}

function Quarantine-OutboxFile {
    param([System.IO.FileInfo]$File)
    $quarantine = Join-Path $OutboxPath 'quarantine'
    [System.IO.Directory]::CreateDirectory($quarantine) | Out-Null
    $destination = Join-Path $quarantine "$($File.BaseName).$([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')).invalid.json"
    try {
        Move-Item -LiteralPath $File.FullName -Destination $destination -Force -ErrorAction Stop
        $script:quarantined++
    }
    catch { }
}

function Invoke-StationCommand {
    param([string]$Executable, [string[]]$Arguments)
    $process = $null
    try {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $Executable
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add([string]$argument) }
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

function Get-OutboxLogicalScope {
    param([object]$Item)
    $match = [regex]::Match([string]$Item.eventKey, ':(\d{4}-\d{2}-\d{2})(?::|$)')
    if (-not $match.Success) { return [string]$Item.eventKey }
    return "$([string]$Item.source)|$([string]$Item.taskId)|$($match.Groups[1].Value)"
}

$mutexCreated = $false
$mutex = [System.Threading.Mutex]::new($true, $MutexName, [ref]$mutexCreated)
if (-not $mutexCreated) {
    [pscustomobject]@{ processed = 0; delivered = 0; deferred = 0; pruned = 0; busy = $true } | ConvertTo-Json -Compress
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
            $computedPayloadHash = Get-PayloadHash $item
            $storedPayloadHash = [string]$item.payloadHash
            if ($storedPayloadHash -notmatch '^[a-f0-9]{64}$' -or $storedPayloadHash -ne $computedPayloadHash) {
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

        if ([string]::IsNullOrWhiteSpace($StationPath) -or -not (Test-Path -LiteralPath $StationPath)) {
            $failureCode = 'station_not_found'
        }
        elseif ([System.IO.Path]::GetExtension($StationPath).ToLowerInvariant() -notin @('.exe', '.com')) {
            $failureCode = 'station_not_application'
        }
        else {
            try {
                $stationArguments = @($StationArgumentPrefix) + @(
                    'checkin-report', '--task-id', [string]$item.taskId,
                    '--name', [string]$item.name, '--source', [string]$item.source,
                    '--status', [string]$item.status, '--event-key', [string]$item.eventKey,
                    '--summary', [string]$item.summary
                )
                $invocation = Invoke-StationCommand $StationPath $stationArguments
                if ($invocation.TimedOut) {
                    $failureCode = 'timeout'
                    $stationOutput = @()
                    $stationExitCode = 124
                }
                else {
                    $stationOutput = @($invocation.Output + $invocation.Error)
                    $stationExitCode = $invocation.ExitCode
                }
                if ($invocation.TimedOut) {
                    # Keep the explicit timeout reason; do not rewrite it as exit_code_124.
                }
                elseif ($stationExitCode -eq 0) {
                    $acknowledgement = Get-StationAcknowledgement $stationOutput
                    if (-not $acknowledgement) { $failureCode = 'acknowledgement_missing' }
                }
                else {
                    $failureCode = "exit_code_$stationExitCode"
                }
            }
            catch { $failureCode = 'invocation_failed' }
        }

        if ($acknowledgement.accepted -eq $true -or $acknowledgement.duplicate -eq $true) {
            $item.delivered = $true
            $item.deliveredAt = $now.ToString('o')
            $item.disposition = if ($acknowledgement.duplicate -eq $true) { 'duplicate' } else { 'accepted' }
            $item.nextAttemptAt = $null
            $item.lastError = $null
            $delivered++
        }
        else {
            $retryDelay = Get-RetryDelayMinutes ([int]$item.attempts)
            $item.delivered = $false
            $item.nextAttemptAt = $now.AddMinutes($retryDelay).ToString('o')
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
    processed = $processed
    delivered = $delivered
    deferred = $deferred
    invalid = $invalid
    quarantined = $quarantined
    superseded = $superseded
    pruned = $pruned
    busy = $false
} | ConvertTo-Json -Compress
