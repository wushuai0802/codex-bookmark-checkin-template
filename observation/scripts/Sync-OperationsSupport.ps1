# Shared by the private Windows sync scheduler; dot-source after loading its config.
# The caller supplies Write-SchedulerLog. Notification retries never run a sync.
$syncTransportPath = Join-Path $PSScriptRoot 'Sync-Transport.ps1'
if (Test-Path -LiteralPath $syncTransportPath -PathType Leaf) { . $syncTransportPath }

function Get-SyncNotificationValues([string]$Status, [string]$Summary, [string]$EventKey) {
    if ($Status -eq 'completed') { $Status = 'success' }
    if ($Status -notin @('success', 'failed')) { throw 'Unsupported sync notification status' }
    if ($EventKey -notmatch '^[A-Za-z0-9._:-]{1,160}$') { throw 'Invalid sync notification event key' }
    $Summary = $Summary.Replace('V2 影子同步', '面板数据同步').Replace('v1 签到执行', '签到执行层')
    return [ordered]@{
        # Retain the existing task identity and queued event keys for deduplication.
        taskId = 'checkin-fabric-v2-shadow-sync'
        name = '签到面板数据同步'
        source = 'checkin-fabric'
        status = $Status
        eventKey = $EventKey
        summary = $Summary
    }
}

function Test-SyncNotificationAcknowledgement([object[]]$Output, [int]$ExitCode) {
    if ($ExitCode -ne 0) { return $false }
    $text = ($Output | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    $lines = @($Output | Select-Object -Last 20)
    [array]::Reverse($lines)
    # Also accept pretty-printed JSON; a transport exit code alone is insufficient.
    $candidates = @($text) + $lines
    foreach ($candidate in $candidates) {
        try { $ack = [string]$candidate | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($null -ne $ack.accepted -or $null -ne $ack.duplicate) {
            return [bool](($ack.accepted -is [bool] -and $ack.accepted) -or ($ack.duplicate -is [bool] -and $ack.duplicate))
        }
    }
    return $false
}

function Send-SyncNotification([string]$LegacyRoot, [string]$Status, [string]$Summary, [string]$EventKey) {
    try {
        $legacyConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $LegacyRoot 'config/config.json') | ConvertFrom-Json
        $localPath = Join-Path $LegacyRoot 'config/config.local.json'
        if (Test-Path -LiteralPath $localPath -PathType Leaf) {
            $localConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $localPath | ConvertFrom-Json
            if ($localConfig.notification) {
                if (-not $legacyConfig.notification) { $legacyConfig | Add-Member -NotePropertyName notification -NotePropertyValue ([pscustomobject]@{}) -Force }
                foreach ($property in $localConfig.notification.PSObject.Properties) {
                    $legacyConfig.notification | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value -Force
                }
            }
        }
        if ([string]$legacyConfig.notification.mode -ne 'command') { return $false }
        $executable = [string]$legacyConfig.notification.executable
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { return $false }
        if ([IO.Path]::GetExtension($executable).ToLowerInvariant() -notin @('.exe', '.com')) { return $false }
        $values = Get-SyncNotificationValues $Status $Summary $EventKey
        $arguments = @($legacyConfig.notification.arguments | ForEach-Object {
            $value = [string]$_
            foreach ($entry in $values.GetEnumerator()) { $value = $value.Replace("{$($entry.Key)}", [string]$entry.Value) }
            $value
        })
        . (Join-Path $LegacyRoot 'scripts/Invoke-BoundedCommand.ps1')
        $timeoutSeconds = if ($legacyConfig.notification.timeoutSeconds) { [int]$legacyConfig.notification.timeoutSeconds } else { 60 }
        $timeoutSeconds = [Math]::Max(1, [Math]::Min(600, $timeoutSeconds))
        $command = Invoke-BoundedCommand $executable $arguments $timeoutSeconds
        $output = @($command.Output)
        $code = $command.ExitCode
        $accepted = Test-SyncNotificationAcknowledgement $output $code
        if (-not $accepted) {
            $cause = if ($command.TimedOut) { 'notifier_timeout' } elseif ($code -eq 0) { 'acknowledgement_missing_or_rejected' } else { 'notifier_command_failed' }
            Write-SchedulerLog "Notification not acknowledged (event=$EventKey; exit=$code; cause=$cause)."
        }
        return $accepted
    } catch {
        # Do not put notifier output, command arguments or configuration in logs.
        Write-SchedulerLog "Notification preparation failed (event=$EventKey; cause=$($_.Exception.GetType().Name))."
        return $false
    }
}

function New-PendingNotification([string]$Status, [string]$Summary, [string]$EventKey, [datetime]$Now) {
    $values = Get-SyncNotificationValues $Status $Summary $EventKey
    return [ordered]@{
        status = $values.status
        summary = $values.summary
        eventKey = $EventKey
        queuedAt = $Now.ToString('o')
        attemptCount = 0
        nextAttemptAt = $Now.ToString('o')
    }
}

function Set-SyncAttemptOutcome([System.Collections.IDictionary]$State, $Previous, [int]$ExitCode, [datetime]$Finished,
    [string]$DailyTime, [string]$SourceFingerprint, [string]$V2Fingerprint, [string]$FailureCause = '') {
    $State['lastAttemptAt'] = $Finished.ToString('o')
    $State['lastExitCode'] = $ExitCode
    $State['lastFailureCause'] = if ($ExitCode -eq 0) { $null } else { $FailureCause }
    if ($ExitCode -eq 0) {
        $State['lastSuccessAt'] = $Finished.ToString('o')
        $State['lastSuccessDate'] = $Finished.ToString('yyyy-MM-dd')
        $State['failureCount'] = 0
        $State['nextRetryAt'] = $null
        $State['lastSourceFingerprint'] = $SourceFingerprint
        $State['lastV2Fingerprint'] = $V2Fingerprint
        Write-SchedulerLog 'Scheduled panel sync succeeded.'
        if ($Previous.syncFailureNotificationSent -eq $true) {
            $State['pendingNotification'] = New-PendingNotification 'success' '面板数据同步已恢复，签到状态与日历已更新。' "fabric-sync-recovered-$($Finished.ToString('yyyyMMdd-HHmmssfff'))" $Finished
        }
        $State['syncFailureNotificationSent'] = $false
        return
    }
    $failureCount = [Math]::Min(8, [int]$Previous.failureCount + 1)
    $delayMinutes = [Math]::Min(240, 15 * [Math]::Pow(2, [Math]::Max(0, $failureCount - 1)))
    $nextRetry = $Finished.AddMinutes($delayMinutes)
    if ($failureCount -ge 8) {
        $nextRetry = [datetime]::ParseExact("$($Finished.Date.AddDays(1).ToString('yyyy-MM-dd')) $DailyTime", 'yyyy-MM-dd HH:mm', $null)
    }
    $State['failureCount'] = $failureCount
    $State['nextRetryAt'] = $nextRetry.ToString('o')
    Write-SchedulerLog "Scheduled panel sync failed (exit=$ExitCode; cause=$FailureCause); next probe=$($nextRetry.ToString('o'))."
    # A single transport blip is retried silently. Notify only after three
    # consecutive failures, then send one recovery notice on the next success.
    if ($failureCount -ge 3 -and $Previous.syncFailureNotificationSent -ne $true) {
        $State['pendingNotification'] = New-PendingNotification 'failed' '面板数据同步暂时失败，后台将自动重试；签到执行任务继续按原计划运行。' "fabric-sync-failed-$($Finished.ToString('yyyyMMdd-HHmmssfff'))" $Finished
        $State['syncFailureNotificationSent'] = $true
    }
}

function Invoke-PendingNotification([System.Collections.IDictionary]$State, [string]$LegacyRoot, [datetime]$Now) {
    $pending = $State['pendingNotification']
    if (-not $pending) { return $false }
    if ([string]$pending.status -eq 'completed') {
        # Repair the old invalid payload in place and retry it once on this probe.
        # Its stable key prevents a second delivery if the acknowledgement was lost.
        $values = Get-SyncNotificationValues $pending.status $pending.summary $pending.eventKey
        $pending.status = $values.status
        $pending.summary = $values.summary
        $pending.attemptCount = 0
        $pending.nextAttemptAt = $Now.ToString('o')
        Write-SchedulerLog 'Migrated pending sync recovery notification to the supported success status.'
    }
    $nextAttemptAt = try { [datetime]$pending.nextAttemptAt } catch { $Now }
    if ($Now -lt $nextAttemptAt) { return $false }
    $accepted = Send-SyncNotification $LegacyRoot ([string]$pending.status) ([string]$pending.summary) ([string]$pending.eventKey)
    if ($accepted) {
        Write-SchedulerLog "Pending notification accepted (event=$([string]$pending.eventKey))."
        $State['pendingNotification'] = $null
        return $true
    }
    $attemptCount = [Math]::Min(12, [int]$pending.attemptCount + 1)
    $delayMinutes = [Math]::Min(240, 5 * [Math]::Pow(2, [Math]::Max(0, $attemptCount - 1)))
    $pending.attemptCount = $attemptCount
    $pending.nextAttemptAt = $Now.AddMinutes($delayMinutes).ToString('o')
    $State['pendingNotification'] = $pending
    Write-SchedulerLog "Pending notification was not accepted (event=$([string]$pending.eventKey)); retry in $delayMinutes minutes."
    return $true
}

function Get-SyncTransportFailure([string]$Phase, [int]$ExitCode, [object[]]$Output) {
    $text = ($Output | ForEach-Object { [string]$_ }) -join "`n"
    $cause = if ($text -match '(?i)timed out|timeout') { 'connection_timeout' }
        elseif ($text -match '(?i)connection reset|connection closed|broken pipe|connection aborted') { 'connection_interrupted' }
        elseif ($text -match '(?i)permission denied|authentication failed') { 'authentication_failed' }
        elseif ($text -match '(?i)host key verification failed|host identification has changed') { 'host_key_verification_failed' }
        elseif ($text -match '(?i)could not resolve|name or service not known') { 'name_resolution_failed' }
        elseif ($text -match '(?i)no space left on device') { 'remote_storage_full' }
        elseif ($ExitCode -eq 255) { 'ssh_transport_failed' }
        else { 'remote_command_failed' }
    # Report useful error categories without leaking SSH paths, hosts or credentials.
    return "$Phase failed (exit=$ExitCode; cause=$cause)"
}

function Invoke-SyncRemoteCommand([string]$Executable, [string[]]$Arguments, [string]$Phase) {
    if (-not (Get-Command Invoke-BoundedSyncProcess -CommandType Function -ErrorAction SilentlyContinue)) {
        return [pscustomobject]@{ exitCode = -1; failure = "$Phase failed (exit=-1; cause=transport_helper_missing)" }
    }
    $result = Invoke-BoundedSyncProcess $Executable $Arguments $Phase '' 45
    return [pscustomobject]@{
        exitCode = $result.exitCode
        failure = if ($result.exitCode -ne 0) { $result.failure } else { $null }
    }
}

function Invoke-SyncUploadWithRetry([string]$Executable, [string[]]$Arguments, [int]$MaxAttempts = 3, [int]$RetryDelaySeconds = 2, [scriptblock]$Invoke) {
    $MaxAttempts = [Math]::Max(1, [Math]::Min(3, $MaxAttempts))
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $result = if ($Invoke) { & $Invoke $Executable $Arguments } else { Invoke-SyncRemoteCommand $Executable $Arguments 'nas_upload' }
        if ($result.exitCode -eq 0 -or $attempt -eq $MaxAttempts -or
            $result.failure -notmatch 'cause=(connection_timeout|connection_interrupted|ssh_transport_failed)\)') { return $result }
        $message = "NAS upload transport interrupted; retry $($attempt + 1)/$MaxAttempts."
        if (Get-Command Write-Log -CommandType Function -ErrorAction SilentlyContinue) { Write-Log $message | Out-Null }
        elseif (Get-Command Write-SchedulerLog -CommandType Function -ErrorAction SilentlyContinue) { Write-SchedulerLog $message | Out-Null }
        if ($RetryDelaySeconds -gt 0) { Start-Sleep -Seconds ([Math]::Min(5, $RetryDelaySeconds)) }
    }
}
