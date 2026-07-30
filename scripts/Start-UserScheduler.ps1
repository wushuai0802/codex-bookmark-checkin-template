[CmdletBinding()]
param([switch]$Once)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$initialConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$statePath = Join-Path $root 'data\scheduler-state.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$schedulerLogPath = Join-Path $root 'logs\scheduler.log'
$outboxScript = Join-Path $PSScriptRoot 'Invoke-CheckinNotificationOutbox.ps1'
$mutexCreated = $false
$mutexName = if ($initialConfig.schedulerMutexName) { [string]$initialConfig.schedulerMutexName } else { 'Local\CodexBookmarkDailyCheckinScheduler' }
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Write-SchedulerLog([string]$message) {
    Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding UTF8
}

function Write-SchedulerHeartbeat([string]$phase) {
    $value = [ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o'); phase = $phase }
    $temporary = "$heartbeatPath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $heartbeatPath -Force
}

function Read-SchedulerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return [pscustomobject]@{} }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    catch { return [pscustomobject]@{} }
}

function Get-LatestReportState([datetime]$now, $config, [Nullable[datetime]]$notBefore = $null) {
    $latestPath = Join-Path $root 'logs\latest.json'
    $empty = [pscustomobject]@{
        Valid = $false; Complete = $false; NextEligibleAt = $null; RunId = $null
        ProblemCount = $null; RunState = $null; PlannedTotal = 0; ProcessedTotal = 0
    }
    if (-not (Test-Path -LiteralPath $latestPath)) { return $empty }
    try {
        if ($null -ne $notBefore -and (Get-Item -LiteralPath $latestPath).LastWriteTime -lt ([datetime]$notBefore).AddSeconds(-2)) { return $empty }
        $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        $results = @($latest.results)
        $runState = [string]$latest.runState
        $plannedTotal = if ($null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
        $processedTotal = if ($null -ne $latest.processedTotal) { [int]$latest.processedTotal } else { $results.Count }
        $valid = [string]$latest.runId -like "$($now.ToString('yyyyMMdd'))-*" `
            -and $runState -eq 'final' `
            -and $results.Count -ge $minimumTargets `
            -and $plannedTotal -ge $minimumTargets
        if (-not $valid) { return $empty }
        $contractComplete = $latest.isComplete -eq $true `
            -and $processedTotal -ge $plannedTotal `
            -and $results.Count -ge $plannedTotal
        $problems = @($results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
        $missingCount = [Math]::Max(0, $plannedTotal - $processedTotal)
        $retryTimes = @($problems | Where-Object { $_.status -eq 'deferred' -and $_.nextEligibleAt } | ForEach-Object {
            try { [datetime]$_.nextEligibleAt } catch { }
        } | Where-Object { $_ -gt $now })
        return [pscustomobject]@{
            Valid = $true
            Complete = $contractComplete -and $problems.Count -eq 0
            NextEligibleAt = if ($retryTimes.Count -gt 0) { @($retryTimes | Sort-Object)[0] } else { $null }
            RunId = [string]$latest.runId
            ProblemCount = $problems.Count + $missingCount
            RunState = $runState
            PlannedTotal = $plannedTotal
            ProcessedTotal = $processedTotal
        }
    }
    catch { return $empty }
}

function Test-SchedulerWaiting($state, [datetime]$now, $config) {
    $today = $now.ToString('yyyy-MM-dd')
    if ([string]$state.lastRunDate -eq $today -and $state.reportComplete -eq $true) { return $true }
    $maxAttempts = if ($null -ne $config.schedulerMaxDailyAttempts) { [int]$config.schedulerMaxDailyAttempts } else { 3 }
    $maxAttempts = [Math]::Max(1, [Math]::Min(6, $maxAttempts))
    if ([string]$state.lastAttemptDate -eq $today -and [int]$state.attemptsToday -ge $maxAttempts) { return $true }
    if ([string]$state.phase -eq 'running' -and $state.lastAttemptStartedAt) {
        $claimMaxAge = (if ($null -ne $config.taskTimeoutMinutes) { [int]$config.taskTimeoutMinutes } else { 25 }) + 15
        try {
            if ($now - [datetime]$state.lastAttemptStartedAt -lt [timespan]::FromMinutes($claimMaxAge)) { return $true }
        }
        catch { }
    }
    if ($state.nextEligibleAt) {
        try { if ([datetime]$state.nextEligibleAt -gt $now) { return $true } } catch { }
    }
    return $false
}

function Write-SchedulerClaim([datetime]$startedAt) {
    $state = Read-SchedulerState
    $today = $startedAt.ToString('yyyy-MM-dd')
    $attemptsToday = if ([string]$state.lastAttemptDate -eq $today) { [int]$state.attemptsToday + 1 } else { 1 }
    $value = [ordered]@{
        phase = 'running'
        lastAttemptDate = $today
        attemptsToday = $attemptsToday
        lastAttemptStartedAt = $startedAt.ToString('o')
        lastRunDate = $state.lastRunDate
        lastFinishedAt = $state.lastFinishedAt
        lastExitCode = $state.lastExitCode
        reportValid = $state.reportValid
        reportComplete = $state.reportComplete
        lastRunId = $state.lastRunId
        nextEligibleAt = $null
    }
    $temporary = "$statePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Write-SchedulerState([datetime]$finishedAt, [int]$exitCode, $reportState, $config) {
    $state = Read-SchedulerState
    $failureDelay = if ($null -ne $config.schedulerFailureRetryMinutes) { [int]$config.schedulerFailureRetryMinutes } else { 60 }
    $failureDelay = [Math]::Max(5, [Math]::Min(360, $failureDelay))
    $nextEligibleAt = $null
    if (-not $reportState.Complete) {
        $nextEligibleAt = if ($null -ne $reportState.NextEligibleAt) {
            ([datetime]$reportState.NextEligibleAt).ToString('o')
        } else {
            $finishedAt.AddMinutes($failureDelay).ToString('o')
        }
    }
    $value = [ordered]@{
        phase = 'finished'
        lastAttemptDate = $finishedAt.ToString('yyyy-MM-dd')
        attemptsToday = [Math]::Max(1, [int]$state.attemptsToday)
        lastAttemptStartedAt = $state.lastAttemptStartedAt
        lastRunDate = if ($reportState.Complete) { $finishedAt.ToString('yyyy-MM-dd') } else { $null }
        lastFinishedAt = $finishedAt.ToString('o')
        lastExitCode = $exitCode
        reportValid = [bool]$reportState.Valid
        reportComplete = [bool]$reportState.Complete
        lastRunId = $reportState.RunId
        problemCount = $reportState.ProblemCount
        reportRunState = $reportState.RunState
        plannedTotal = $reportState.PlannedTotal
        processedTotal = $reportState.ProcessedTotal
        nextEligibleAt = $nextEligibleAt
    }
    $temporary = "$statePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

try {
    Write-SchedulerLog "调度器启动（PID=$PID）。"
    while ($true) {
        try {
            Write-SchedulerHeartbeat 'idle'
            $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
            try {
                Write-SchedulerHeartbeat 'flushing_notifications'
                $outboxResult = (& $outboxScript | Select-Object -Last 1) | ConvertFrom-Json
                if ([int]$outboxResult.processed -gt 0 -or [int]$outboxResult.invalid -gt 0) {
                    Write-SchedulerLog "通知 outbox：处理=$($outboxResult.processed)，送达=$($outboxResult.delivered)，延后=$($outboxResult.deferred)，无效=$($outboxResult.invalid)，隔离=$($outboxResult.quarantined)。"
                }
            }
            catch {
                $outboxMessage = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
                Write-SchedulerLog "通知 outbox 可恢复异常：$outboxMessage"
            }
            Write-SchedulerHeartbeat 'idle'
            $schedule = [string]$config.schedule
            if ($schedule -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw "无效签到时间：$schedule" }
            $now = Get-Date
            $scheduledToday = [datetime]::ParseExact("$($now.ToString('yyyy-MM-dd')) $schedule", 'yyyy-MM-dd HH:mm', $null)
            $state = Read-SchedulerState
            $latestReportState = Get-LatestReportState $now $config
            if ($latestReportState.Complete `
                -and ([string]$state.lastRunDate -ne $now.ToString('yyyy-MM-dd') -or $state.reportComplete -ne $true)) {
                Write-SchedulerState $now 0 $latestReportState $config
                $state = Read-SchedulerState
                Write-SchedulerLog "已接收外部续跑完成报告：runId=$($latestReportState.RunId)。"
            }
            if ($now -ge $scheduledToday -and -not (Test-SchedulerWaiting $state $now $config)) {
                Write-SchedulerHeartbeat 'running_checkin'
                $attemptNumber = if ([string]$state.lastAttemptDate -eq $now.ToString('yyyy-MM-dd')) { [int]$state.attemptsToday + 1 } else { 1 }
                Write-SchedulerLog "开始第 $attemptNumber 次签到尝试。"
                $runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
                $runStartedAt = Get-Date
                Write-SchedulerClaim $runStartedAt
                $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
                $process = Start-Process -FilePath $shell -ArgumentList @(
                    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                    '-ExecutionPolicy', 'Bypass', '-File', $runScript
                ) -WindowStyle Hidden -PassThru
                while (-not $process.HasExited) {
                    Write-SchedulerHeartbeat 'running_checkin'
                    Start-Sleep -Seconds 15
                    $process.Refresh()
                }
                $finishedAt = Get-Date
                $reportState = Get-LatestReportState $finishedAt $config $runStartedAt
                Write-SchedulerState $finishedAt $process.ExitCode $reportState $config
                Write-SchedulerLog "签到结束：退出码=$($process.ExitCode)，报告有效=$($reportState.Valid)，完整=$($reportState.Complete)，进度=$($reportState.ProcessedTotal)/$($reportState.PlannedTotal)，异常=$($reportState.ProblemCount)。"
            }
        }
        catch {
            $message = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
            Write-Warning "后台调度循环发生可恢复异常：$message"
            Write-SchedulerLog "可恢复异常：$message"
        }
        if ($Once) { break }
        Start-Sleep -Seconds 60
    }
}
finally {
    try { Write-SchedulerLog "调度器退出（PID=$PID）。" } catch { }
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
