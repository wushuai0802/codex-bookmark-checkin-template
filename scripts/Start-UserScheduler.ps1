[CmdletBinding()]
param([switch]$Once)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$initialConfig = try { Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json } catch { $null }
$lastGoodConfig = $initialConfig
$runtimeResolverScript = Join-Path $PSScriptRoot 'Resolve-Runtime.ps1'
. (Join-Path $PSScriptRoot 'ResultIdentity.ps1')
. (Join-Path $PSScriptRoot 'ResultContract.ps1')
$statePath = Join-Path $root 'data\scheduler-state.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$schedulerLogPath = Join-Path $root 'logs\scheduler.log'
$latestReportPath = Join-Path $root 'logs\latest.json'
$outboxScript = Join-Path $PSScriptRoot 'Invoke-CheckinNotificationOutbox.ps1'
$reporterScript = Join-Path $PSScriptRoot 'Submit-UnifiedCheckinReport.ps1'
$mutexCreated = $false
$mutexName = if ($null -ne $initialConfig -and $initialConfig.schedulerMutexName) { [string]$initialConfig.schedulerMutexName } else { 'Local\CodexBookmarkDailyCheckinScheduler' }
$mutex = [System.Threading.Mutex]::new($true, $mutexName, [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Write-SchedulerLog([string]$message) {
    Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message" -Encoding UTF8
}

function Write-AtomicTextFile([string]$destination, [string]$content) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    $nonce = [guid]::NewGuid().ToString('N')
    $temporary = "$destination.$PID.$nonce.tmp"
    $backup = "$destination.$PID.$nonce.bak"
    try {
        [System.IO.File]::WriteAllText($temporary, $content, [System.Text.UTF8Encoding]::new($false))
        for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
            try {
                if ([System.IO.File]::Exists($destination)) {
                    [System.IO.File]::Replace($temporary, $destination, $backup, $true)
                } else {
                    [System.IO.File]::Move($temporary, $destination)
                }
                return
            }
            catch {
                if ($attempt -ge 7) { throw }
                Start-Sleep -Milliseconds ([int](50 * [math]::Pow(2, $attempt)))
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
}

function Write-SchedulerHeartbeat([string]$phase) {
    $value = [ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o'); phase = $phase }
    Write-AtomicTextFile $heartbeatPath ($value | ConvertTo-Json)
}

function Read-SchedulerState {
    if (-not (Test-Path -LiteralPath $statePath)) { return [pscustomobject]@{} }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    catch { return [pscustomobject]@{} }
}

function Write-SchedulerStateDocument([object]$value) {
    Write-AtomicTextFile $statePath ($value | ConvertTo-Json -Depth 6)
}

function Get-NormalizedDeferredWakeTokens([object]$value) {
    $normalized = @()
    foreach ($candidate in @($value)) {
        $token = ([string]$candidate).Trim()
        if (-not $token) { continue }
        $parts = @($token -split '\|', 4)
        if ($parts.Count -ne 4) { continue }
        try {
            $originValue = ([string]$parts[0] -split '#account=', 2)[0]
            $originUri = [uri]$originValue
            if (-not $originUri.IsAbsoluteUri -or $originUri.Scheme -ne 'https') { continue }
        }
        catch { continue }
        $nextEligible = [datetimeoffset]::MinValue
        if (-not [datetimeoffset]::TryParse([string]$parts[1], [ref]$nextEligible)) { continue }
        $sequence = 0
        if (-not [int]::TryParse([string]$parts[2], [ref]$sequence) -or $sequence -lt 0) { continue }
        if ([string]$parts[3] -notmatch '^[a-z0-9_.-]+$') { continue }
        $normalized += $token
    }
    return @($normalized | Select-Object -Unique)
}

function Repair-SchedulerWakeTokens {
    $state = Read-SchedulerState
    $raw = @($state.deferredWakeTokens | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
    $normalized = @(Get-NormalizedDeferredWakeTokens $state.deferredWakeTokens)
    if ($raw.Count -eq $normalized.Count -and @(Compare-Object -ReferenceObject $raw -DifferenceObject $normalized).Count -eq 0) { return }
    $state | Add-Member -NotePropertyName deferredWakeTokens -NotePropertyValue @($normalized) -Force
    Write-SchedulerStateDocument $state
    Write-SchedulerLog '已迁移旧版延迟重试令牌；损坏条目已丢弃。'
}

function Compress-SchedulerError([object]$value) {
    $text = ([string]$value -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    $text = $text -replace '(?i)\b(password|passwd|pwd|token|cookie|secret|api[-_ ]?key)\b\s*[:=]\s*[^\s,;，；]+', '$1=[REDACTED]'
    if ($text.Length -gt 240) { $text = $text.Substring(0, 240) }
    return $text
}

function Get-SchedulerErrorHash([string]$message) {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($message)
        $hex = [System.BitConverter]::ToString($algorithm.ComputeHash($bytes)) -replace '-', ''
        return $hex.Substring(0, 16).ToLowerInvariant()
    }
    finally { $algorithm.Dispose() }
}

function Write-SchedulerFailureState([string]$message, $config, [bool]$claimed) {
    $state = Read-SchedulerState
    $now = Get-Date
    $safeMessage = Compress-SchedulerError $message
    $errorHash = Get-SchedulerErrorHash $safeMessage
    $failureDelay = if ($null -ne $config -and $null -ne $config.schedulerFailureRetryMinutes) { [int]$config.schedulerFailureRetryMinutes } else { 60 }
    $failureDelay = [Math]::Max(5, [Math]::Min(360, $failureDelay))
    $cooldown = if ($null -ne $config -and $null -ne $config.schedulerErrorNotificationCooldownMinutes) { [int]$config.schedulerErrorNotificationCooldownMinutes } else { 60 }
    $cooldown = [Math]::Max(5, [Math]::Min(1440, $cooldown))
    $notifiedAt = try { [datetime]$state.lastSchedulerErrorNotifiedAt } catch { $null }
    $sameError = [string]$state.lastSchedulerErrorHash -eq $errorHash
    $sameDay = $null -ne $notifiedAt -and $notifiedAt.Date -eq $now.Date
    $cooldownElapsed = $null -eq $notifiedAt -or ($now - $notifiedAt).TotalMinutes -ge $cooldown
    $shouldNotify = -not $sameError -or -not $sameDay -or $cooldownElapsed
    $wakeDate = $now.ToString('yyyy-MM-dd')
    $wakeTokens = if ([string]$state.deferredWakeDate -eq $wakeDate) { @(Get-NormalizedDeferredWakeTokens $state.deferredWakeTokens) } else { @() }
    $value = [ordered]@{
        phase = 'error'
        lastAttemptDate = $state.lastAttemptDate
        attemptsToday = [int]$state.attemptsToday
        lastAttemptStartedAt = $state.lastAttemptStartedAt
        lastRunDate = $null
        lastFinishedAt = $now.ToString('o')
        lastExitCode = 1
        reportValid = $false
        reportComplete = $false
        reportExecutionComplete = $false
        reportBusinessComplete = $false
        lastRunId = $state.lastRunId
        problemCount = 1
        reportRunState = 'scheduler_error'
        plannedTotal = 0
        processedTotal = 0
        planFingerprint = $state.planFingerprint
        nextEligibleAt = if ($claimed) { $now.AddMinutes($failureDelay).ToString('o') } else { $state.nextEligibleAt }
        deferredWakeDate = $wakeDate
        deferredWakeTokens = @($wakeTokens)
        lastSchedulerError = $safeMessage
        lastSchedulerErrorHash = $errorHash
        lastSchedulerErrorAt = $now.ToString('o')
        lastSchedulerErrorNotifiedAt = $state.lastSchedulerErrorNotifiedAt
    }
    Write-SchedulerStateDocument $value
    return [pscustomobject]@{ Hash = $errorHash; At = $now; Message = $safeMessage; ShouldNotify = [bool]$shouldNotify }
}

function Reset-SchedulerForPlanChange($state, [string]$newPlanFingerprint) {
    # A bookmark/account change is a new execution plan, even when its target
    # count is unchanged.  Do not carry yesterday's completion, retry claims,
    # cooldown or attempt budget into the new plan.
    $state | Add-Member -NotePropertyName phase -NotePropertyValue 'idle' -Force
    $state | Add-Member -NotePropertyName planFingerprint -NotePropertyValue $newPlanFingerprint -Force
    $state | Add-Member -NotePropertyName lastAttemptDate -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName attemptsToday -NotePropertyValue 0 -Force
    $state | Add-Member -NotePropertyName lastAttemptStartedAt -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName lastRunDate -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName lastFinishedAt -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName lastExitCode -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName reportValid -NotePropertyValue $false -Force
    $state | Add-Member -NotePropertyName reportComplete -NotePropertyValue $false -Force
    $state | Add-Member -NotePropertyName reportExecutionComplete -NotePropertyValue $false -Force
    $state | Add-Member -NotePropertyName reportBusinessComplete -NotePropertyValue $false -Force
    $state | Add-Member -NotePropertyName lastRunId -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName problemCount -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName automaticRetryCount -NotePropertyValue 0 -Force
    $state | Add-Member -NotePropertyName reportRunState -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName plannedTotal -NotePropertyValue 0 -Force
    $state | Add-Member -NotePropertyName processedTotal -NotePropertyValue 0 -Force
    $state | Add-Member -NotePropertyName nextEligibleAt -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName deferredWakeDate -NotePropertyValue $null -Force
    $state | Add-Member -NotePropertyName deferredWakeTokens -NotePropertyValue @() -Force
    return $state
}

function Set-SchedulerFailureNotified([string]$errorHash, [datetime]$notifiedAt) {
    $state = Read-SchedulerState
    if ([string]$state.lastSchedulerErrorHash -ne $errorHash) { return }
    $state | Add-Member -NotePropertyName lastSchedulerErrorNotifiedAt -NotePropertyValue $notifiedAt.ToString('o') -Force
    Write-SchedulerStateDocument $state
}

function Invoke-SchedulerFailureNotification([string]$message, $config, [bool]$enqueue) {
    if ($null -eq $config -or $null -eq $config.notification) { return $false }
    $temporaryConfig = Join-Path $root "tmp\scheduler-failure-notification.$PID.json"
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $temporaryConfig)) | Out-Null
    $minimalConfig = [ordered]@{
        notification = $config.notification
        logicalCheckinGroups = if ($null -ne $config.logicalCheckinGroups) { $config.logicalCheckinGroups } else { [pscustomobject]@{} }
    }
    try {
        [System.IO.File]::WriteAllText($temporaryConfig, ($minimalConfig | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
        if ($enqueue) {
            & $reporterScript -RunnerStatus failed -RunnerMessage "后台调度器准备签到失败：$message" -ConfigPath $temporaryConfig | Out-Null
        }
        & $outboxScript -ConfigPath $temporaryConfig | Out-Null
        return $true
    }
    finally { Remove-Item -LiteralPath $temporaryConfig -Force -ErrorAction SilentlyContinue }
}

function Get-LatestReportState([datetime]$now, $config, $currentPlan, [Nullable[datetime]]$notBefore = $null) {
    $empty = [pscustomobject]@{
        Valid = $false; Complete = $false; ExecutionComplete = $false; BusinessComplete = $false
        NextEligibleAt = $null; RunId = $null
        ProblemCount = $null; RunState = $null; PlannedTotal = 0; ProcessedTotal = 0; DeferredWakeups = @()
        PlanFingerprint = $null; PlanMatches = $false
    }
    if (-not (Test-Path -LiteralPath $latestReportPath)) { return $empty }
    try {
        if ($null -ne $notBefore -and (Get-Item -LiteralPath $latestReportPath).LastWriteTime -lt ([datetime]$notBefore).AddSeconds(-2)) { return $empty }
        $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestReportPath | ConvertFrom-Json
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        $results = @($latest.results)
        $runState = [string]$latest.runState
        $plannedTotal = if ($null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
        $processedTotal = if ($null -ne $latest.processedTotal) { [int]$latest.processedTotal } else { $results.Count }
        $reportPlanFingerprint = [string]$latest.bookmarkSummary.planFingerprint
        $latestIdentities = @($latest.bookmarkSummary.targets | ForEach-Object {
            try { Get-CanonicalResultIdentity $_ } catch { }
        } | Sort-Object -Unique)
        $planMatches = $null -ne $currentPlan `
            -and [int]$currentPlan.targetCount -eq $plannedTotal `
            -and @($currentPlan.identities).Count -eq $latestIdentities.Count `
            -and @(Compare-Object -ReferenceObject @($currentPlan.identities) -DifferenceObject $latestIdentities).Count -eq 0
        $resultIdentities = @($results | ForEach-Object { Get-CanonicalResultIdentity $_ })
        $uniqueResultIdentities = @($resultIdentities | Sort-Object -Unique)
        $resultIdentitiesMatch = $resultIdentities.Count -eq $plannedTotal `
            -and $uniqueResultIdentities.Count -eq $resultIdentities.Count `
            -and @($currentPlan.identities).Count -eq $uniqueResultIdentities.Count `
            -and @(Compare-Object -ReferenceObject @($currentPlan.identities) -DifferenceObject $uniqueResultIdentities).Count -eq 0
        # Reports without a fingerprint predate execution-plan validation.
        # Identity equality alone cannot prove that account bindings, login
        # strategy, candidate URLs and profile routing are unchanged.
        $planMatchesByFingerprint = if ($reportPlanFingerprint) {
            [string]$currentPlan.planFingerprint -eq $reportPlanFingerprint
        } else {
            $false
        }
        $valid = [string]$latest.runId -like "$($now.ToString('yyyyMMdd'))-*" `
            -and $runState -eq 'final' `
            -and $results.Count -ge $minimumTargets `
            -and $plannedTotal -ge $minimumTargets `
            -and $planMatchesByFingerprint `
            -and $resultIdentitiesMatch
        if (-not $valid) {
            $empty.PlanFingerprint = if ($reportPlanFingerprint) { $reportPlanFingerprint } else { $null }
            $empty.PlanMatches = [bool]$planMatchesByFingerprint
            return $empty
        }
        $contractComplete = $latest.isComplete -eq $true `
            -and $processedTotal -ge $plannedTotal `
            -and $results.Count -ge $plannedTotal
        $problems = @($results | Where-Object { -not (Test-TerminalCheckinResult $_) })
        $automaticRetryProblems = @($problems | Where-Object {
            $_.status -in @('error', 'login_required', 'interactive_challenge', 'managed_challenge_timeout', 'no_action', 'deferred', 'not_available') `
                -and $_.retryable -ne $false `
                -and $_.submissionAttempted -ne $true `
                -and -not ($_.status -eq 'deferred' -and $_.retryExhaustedForDay -eq $true)
        })
        $missingCount = [Math]::Max(0, $plannedTotal - $processedTotal)
        $nowOffset = [datetimeoffset]$now
        $deferredWakeups = @($problems | Where-Object { $_.status -eq 'deferred' -and $_.nextEligibleAt } | ForEach-Object {
            $next = try { [datetimeoffset]$_.nextEligibleAt } catch { return }
            $identity = Get-CanonicalResultIdentity $_
            $sequence = [Math]::Max(0, [int]$_.retrySequence)
            [pscustomobject]@{
                Identity = $identity
                NextEligibleAt = $next
                RetrySequence = $sequence
                RetryExhaustedForDay = $_.retryExhaustedForDay -eq $true
                Token = "$identity|$($next.ToUniversalTime().ToString('o'))|$sequence|$([string]$_.retryCause)"
            }
        })
        $retryTimes = @($deferredWakeups | Where-Object { $_.NextEligibleAt -gt $nowOffset } | ForEach-Object { $_.NextEligibleAt })
        return [pscustomobject]@{
            Valid = $true
            Complete = $contractComplete -and $problems.Count -eq 0
            ExecutionComplete = $contractComplete
            BusinessComplete = $contractComplete -and $problems.Count -eq 0
            NextEligibleAt = if ($retryTimes.Count -gt 0) { @($retryTimes | Sort-Object)[0] } else { $null }
            RunId = [string]$latest.runId
            ProblemCount = $problems.Count + $missingCount
            AutomaticRetryCount = $automaticRetryProblems.Count + $missingCount
            RunState = $runState
            PlannedTotal = $plannedTotal
            ProcessedTotal = $processedTotal
            DeferredWakeups = $deferredWakeups
            PlanFingerprint = $reportPlanFingerprint
            PlanMatches = $true
        }
    }
    catch { return $empty }
}

function Get-UnclaimedDeferredWakeups($state, $reportState, [datetime]$now, $config) {
    if ($null -eq $reportState -or $reportState.Valid -ne $true) { return @() }
    $today = $now.ToString('yyyy-MM-dd')
    $claimed = if ([string]$state.deferredWakeDate -eq $today) { @(Get-NormalizedDeferredWakeTokens $state.deferredWakeTokens) } else { @() }
    $perIdentityLimit = if ($null -ne $config.schedulerMaxDailyAttempts) { [int]$config.schedulerMaxDailyAttempts } else { 3 }
    $perIdentityLimit = [Math]::Max(1, [Math]::Min(6, $perIdentityLimit))
    $nowOffset = [datetimeoffset]$now
    return @($reportState.DeferredWakeups | Where-Object {
        $_.NextEligibleAt -le $nowOffset `
            -and $_.RetryExhaustedForDay -ne $true `
            -and [int]$_.RetrySequence -lt $perIdentityLimit `
            -and $claimed -notcontains [string]$_.Token
    })
}

function Test-SchedulerWaiting($state, [datetime]$now, $config, [object[]]$deferredWakeups) {
    $today = $now.ToString('yyyy-MM-dd')
    if ([string]$state.lastRunDate -eq $today -and $state.reportComplete -eq $true) { return $true }
    $attemptedToday = [string]$state.lastAttemptDate -eq $today
    $hasAttempt = [int]$state.attemptsToday -ge 1
    $automaticRetryCount = if ($null -ne $state.automaticRetryCount) { [int]$state.automaticRetryCount } else { 0 }
    $hasDeferredWakeups = @($deferredWakeups).Count -gt 0
    if ($attemptedToday -and $hasAttempt -and $automaticRetryCount -eq 0 -and -not $hasDeferredWakeups) { return $true }
    $maxAttempts = if ($null -ne $config.schedulerMaxDailyAttempts) { [int]$config.schedulerMaxDailyAttempts } else { 3 }
    $maxAttempts = [Math]::Max(1, [Math]::Min(6, $maxAttempts))
    # schedulerMaxDailyAttempts is a hard whole-process ceiling. A per-site
    # wakeup may bypass time cooldowns, but never the global process budget.
    if ($attemptedToday -and [int]$state.attemptsToday -ge $maxAttempts) { return $true }
    if ([string]$state.phase -eq 'running' -and $state.lastAttemptStartedAt) {
        $claimMaxAge = (if ($null -ne $config.taskTimeoutMinutes) { [int]$config.taskTimeoutMinutes } else { 25 }) + 15
        try {
            if ($now - [datetime]$state.lastAttemptStartedAt -lt [timespan]::FromMinutes($claimMaxAge)) { return $true }
        }
        catch { }
    }
    if ($state.nextEligibleAt) {
        # A global cooldown is only a fallback for the whole run.  An already
        # due per-site deferred wakeup must bypass it, otherwise one delayed
        # site (for example an upstream outage) can starve unrelated sites.
        try {
            if ([datetimeoffset]$state.nextEligibleAt -gt [datetimeoffset]$now -and -not $hasDeferredWakeups) { return $true }
        } catch { }
    }
    return $false
}

function Test-SchedulerShouldRun($state, [datetime]$now, $config, [object[]]$deferredWakeups, [bool]$manualAttentionOnly, [datetime]$scheduledToday) {
    if ($now -lt $scheduledToday -or $manualAttentionOnly) { return $false }
    if ([bool](Test-SchedulerWaiting $state $now $config $deferredWakeups)) { return $false }
    # This duplicates the most important cooldown invariant at the exact
    # side-effect boundary. Future cooldowns can only be bypassed by a due,
    # unclaimed per-site wakeup.
    if ($state.nextEligibleAt -and @($deferredWakeups).Count -eq 0) {
        try {
            if ([datetimeoffset]$state.nextEligibleAt -gt [datetimeoffset]$now) { return $false }
        }
        catch { }
    }
    return $true
}

function Write-SchedulerClaim([datetime]$startedAt, [object[]]$deferredWakeups = @()) {
    $state = Read-SchedulerState
    $today = $startedAt.ToString('yyyy-MM-dd')
    $attemptsToday = if ([string]$state.lastAttemptDate -eq $today) { [int]$state.attemptsToday + 1 } else { 1 }
    $wakeTokens = if ([string]$state.deferredWakeDate -eq $today) { @(Get-NormalizedDeferredWakeTokens $state.deferredWakeTokens) } else { @() }
    # Keep tokens as an actual JSON array. In PowerShell, adding an object[] to
    # a scalar string can silently concatenate the values into one token and
    # prevent other deferred sites from receiving their scheduled retry.
    $wakeTokens = @(
        @(
            @($wakeTokens)
            @($deferredWakeups | ForEach-Object { [string]$_.Token })
        ) | Where-Object { $_ } | Select-Object -Unique
    )
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
        reportExecutionComplete = $state.reportExecutionComplete
        reportBusinessComplete = $state.reportBusinessComplete
        lastRunId = $state.lastRunId
        problemCount = $state.problemCount
        automaticRetryCount = $state.automaticRetryCount
        reportRunState = $state.reportRunState
        plannedTotal = $state.plannedTotal
        processedTotal = $state.processedTotal
        planFingerprint = $state.planFingerprint
        nextEligibleAt = $null
        deferredWakeDate = $today
        deferredWakeTokens = @($wakeTokens)
    }
    Write-AtomicTextFile $statePath ($value | ConvertTo-Json)
}

function Write-SchedulerState([datetime]$finishedAt, [int]$exitCode, $reportState, $config) {
    $state = Read-SchedulerState
    $finishedDate = $finishedAt.ToString('yyyy-MM-dd')
    $attemptsToday = if ([string]$state.lastAttemptDate -eq $finishedDate) {
        [Math]::Max(1, [int]$state.attemptsToday)
    } else {
        # An externally completed report does not consume a scheduler claim.
        # Never carry yesterday's exhausted attempt counter into a new day.
        0
    }
    $wakeTokens = if ([string]$state.deferredWakeDate -eq $finishedDate) { @(Get-NormalizedDeferredWakeTokens $state.deferredWakeTokens) } else { @() }
    $failureDelay = if ($null -ne $config.schedulerFailureRetryMinutes) { [int]$config.schedulerFailureRetryMinutes } else { 60 }
    $failureDelay = [Math]::Max(5, [Math]::Min(360, $failureDelay))
    $nextEligibleAt = $null
    if (-not $reportState.Complete) {
        $nextEligibleAt = if ($reportState.AutomaticRetryCount -eq 0) {
            $null
        } elseif ($null -ne $reportState.NextEligibleAt) {
            ([datetimeoffset]$reportState.NextEligibleAt).ToLocalTime().ToString('o')
        } else {
            $finishedAt.AddMinutes($failureDelay).ToString('o')
        }
    }
    $value = [ordered]@{
        phase = 'finished'
        lastAttemptDate = $finishedDate
        attemptsToday = $attemptsToday
        lastAttemptStartedAt = $state.lastAttemptStartedAt
        lastRunDate = if ($reportState.ExecutionComplete) { $finishedDate } else { $null }
        lastFinishedAt = $finishedAt.ToString('o')
        lastExitCode = $exitCode
        reportValid = [bool]$reportState.Valid
        reportComplete = [bool]$reportState.Complete
        reportExecutionComplete = [bool]$reportState.ExecutionComplete
        reportBusinessComplete = [bool]$reportState.BusinessComplete
        lastRunId = $reportState.RunId
        problemCount = $reportState.ProblemCount
        automaticRetryCount = $reportState.AutomaticRetryCount
        reportRunState = $reportState.RunState
        plannedTotal = $reportState.PlannedTotal
        processedTotal = $reportState.ProcessedTotal
        planFingerprint = $state.planFingerprint
        nextEligibleAt = $nextEligibleAt
        deferredWakeDate = $finishedDate
        deferredWakeTokens = @($wakeTokens)
    }
    Write-AtomicTextFile $statePath ($value | ConvertTo-Json)
}

try {
    Repair-SchedulerWakeTokens
    Write-SchedulerLog "调度器启动（PID=$PID）。"
    while ($true) {
        $claimedThisLoop = $false
        $process = $null
        $config = $null
        try {
            Write-SchedulerHeartbeat 'idle'
            $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
            $lastGoodConfig = $config
            if (-not (Get-Command Resolve-CheckinNode -CommandType Function -ErrorAction SilentlyContinue)) {
                . $runtimeResolverScript
            }
            $node = Resolve-CheckinNode $config
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
            $currentPlanText = & $node (Join-Path $root 'src\current-plan.mjs') | Select-Object -Last 1
            if ($LASTEXITCODE -ne 0) { throw "当前书签计划检查失败（退出码 $LASTEXITCODE）。" }
            try { $currentPlan = $currentPlanText | ConvertFrom-Json }
            catch { throw '当前书签计划检查未返回有效 JSON。' }
            if ($null -eq $currentPlan -or $null -eq $currentPlan.identities -or
                [string]::IsNullOrWhiteSpace([string]$currentPlan.planFingerprint)) {
                throw '当前书签计划检查结果不完整。'
            }
            $latestReportState = Get-LatestReportState $now $config $currentPlan
            $currentPlanFingerprint = [string]$currentPlan.planFingerprint
            $statePlanFingerprint = [string]$state.planFingerprint
            $statePlanChanged = $statePlanFingerprint -and $statePlanFingerprint -ne $currentPlanFingerprint
            $reportPlanChanged = [string]$latestReportState.PlanFingerprint -and
                [string]$latestReportState.PlanFingerprint -ne $currentPlanFingerprint
            if ($statePlanChanged -or $reportPlanChanged) {
                $previousPlanFingerprint = if ($statePlanFingerprint) { $statePlanFingerprint } else { [string]$latestReportState.PlanFingerprint }
                $state = Reset-SchedulerForPlanChange $state $currentPlanFingerprint
                Write-SchedulerStateDocument $state
                Write-SchedulerLog "签到计划指纹已变化，已清除旧完成/重试状态（旧=$previousPlanFingerprint，新=$currentPlanFingerprint）。"
            } elseif (-not $statePlanFingerprint) {
                # A legacy state cannot establish which execution plan produced
                # its completion claim. Reset once and seed the current plan.
                $state = Reset-SchedulerForPlanChange $state $currentPlanFingerprint
                Write-SchedulerStateDocument $state
                Write-SchedulerLog '已迁移旧版调度状态；为验证当前账号与登录策略，今天将重新执行一次。'
            }
            if ($state.reportComplete -eq $true -and -not $latestReportState.Valid) {
                $state.reportComplete = $false
                $state.lastRunDate = $null
                $state.nextEligibleAt = $null
            }
            $hasNewExternalReport = $latestReportState.Valid `
                -and $latestReportState.RunId `
                -and ([string]$state.lastRunId -ne [string]$latestReportState.RunId `
                    -or $state.reportValid -ne $true)
            $reportStateNeedsSync = $latestReportState.Valid `
                -and $latestReportState.RunId `
                -and ([string]$state.lastRunId -ne [string]$latestReportState.RunId `
                    -or $state.reportValid -ne $true `
                    -or [int]$state.automaticRetryCount -ne [int]$latestReportState.AutomaticRetryCount `
                    -or $state.reportComplete -ne $latestReportState.Complete `
                    -or $state.reportExecutionComplete -ne $latestReportState.ExecutionComplete `
                    -or $state.reportBusinessComplete -ne $latestReportState.BusinessComplete `
                    -or ($latestReportState.AutomaticRetryCount -eq 0 -and $null -ne $state.nextEligibleAt))
            if ($reportStateNeedsSync) {
                $externalExitCode = if ($latestReportState.Complete) { 0 } else { 2 }
                Write-SchedulerState $now $externalExitCode $latestReportState $config
                $state = Read-SchedulerState
                if ($hasNewExternalReport) {
                    Write-SchedulerLog "已接收外部续跑报告：runId=$($latestReportState.RunId)，完整=$($latestReportState.Complete)，异常=$($latestReportState.ProblemCount)。"
                    try { & $reporterScript -RunnerStatus completed -RunnerMessage '后台调度器已接收外部续跑报告。' -ReportPath $latestReportPath | Out-Null }
                    catch { Write-SchedulerLog "外部续跑报告入通知队列异常：$(Compress-SchedulerError $_.Exception.Message)" }
                    try { & $outboxScript | Out-Null }
                    catch { Write-SchedulerLog "外部续跑报告通知暂未送达：$(Compress-SchedulerError $_.Exception.Message)" }
                } else {
                    Write-SchedulerLog "已同步外部报告状态：runId=$($latestReportState.RunId)，自动重试=$($latestReportState.AutomaticRetryCount)，下次执行=$($state.nextEligibleAt)。"
                }
            }
            # Write-SchedulerState can change retry eligibility. Re-read the persisted
            # state before making the run decision so a restarted scheduler cannot
            # act on stale in-memory metadata from an older schema.
            $state = Read-SchedulerState
            # Run one due identity at a time. This keeps a local outage from
            # turning a per-site wakeup into another full 22-site pass.
            $deferredWakeups = @(Get-UnclaimedDeferredWakeups $state $latestReportState $now $config |
                Sort-Object NextEligibleAt, Identity | Select-Object -First 1)
            $manualAttentionOnly = $latestReportState.Valid -and $latestReportState.AutomaticRetryCount -eq 0 -and -not $latestReportState.Complete
            if ($manualAttentionOnly) {
                $state = Read-SchedulerState
                if ($state.nextEligibleAt) {
                    $state.nextEligibleAt = $null
                    Write-SchedulerStateDocument $state
                }
            }
            $shouldRun = [bool](Test-SchedulerShouldRun $state $now $config $deferredWakeups $manualAttentionOnly $scheduledToday)
            if ($shouldRun) {
                Write-SchedulerHeartbeat 'running_checkin'
                $attemptNumber = if ([string]$state.lastAttemptDate -eq $now.ToString('yyyy-MM-dd')) { [int]$state.attemptsToday + 1 } else { 1 }
                Write-SchedulerLog "开始第 $attemptNumber 次签到尝试。"
                $runScript = Join-Path $PSScriptRoot 'Run-Checkin.ps1'
                $runStartedAt = Get-Date
                Write-SchedulerClaim $runStartedAt $deferredWakeups
                $claimedThisLoop = $true
                $shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
                $runArguments = @(
                    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
                    '-ExecutionPolicy', 'Bypass', '-File', "`"$runScript`""
                )
                if ($deferredWakeups.Count -eq 1) {
                    $wakeIdentity = [string]$deferredWakeups[0].Identity
                    $identityParts = @($wakeIdentity -split '#account=', 2)
                    if ($identityParts.Count -eq 2) {
                        $wakeAccountKey = [uri]::UnescapeDataString([string]$identityParts[1])
                        if (-not $wakeAccountKey -or $wakeAccountKey.Length -gt 80 -or $wakeAccountKey -notmatch '^[A-Za-z0-9._-]+$') {
                            throw '延迟重试账号标识无效。'
                        }
                        $runArguments += @('-AccountKeys', $wakeAccountKey)
                    }
                    else {
                        $wakeOrigin = [uri]$wakeIdentity
                        if (-not $wakeOrigin.IsAbsoluteUri -or $wakeOrigin.Scheme -ne 'https' -or $wakeOrigin.UserInfo) {
                            throw '延迟重试站点来源无效。'
                        }
                        $runArguments += @('-Origins', $wakeOrigin.GetLeftPart([System.UriPartial]::Authority))
                    }
                }
                $process = Start-Process -FilePath $shell -ArgumentList $runArguments -WindowStyle Hidden -PassThru
                while (-not $process.HasExited) {
                    Write-SchedulerHeartbeat 'running_checkin'
                    Start-Sleep -Seconds 15
                    $process.Refresh()
                }
                $finishedAt = Get-Date
                $reportState = Get-LatestReportState $finishedAt $config $currentPlan $runStartedAt
                Write-SchedulerState $finishedAt $process.ExitCode $reportState $config
                $claimedThisLoop = $false
                Write-SchedulerLog "签到结束：退出码=$($process.ExitCode)，报告有效=$($reportState.Valid)，完整=$($reportState.Complete)，进度=$($reportState.ProcessedTotal)/$($reportState.PlannedTotal)，异常=$($reportState.ProblemCount)。"
                if ($process.ExitCode -ne 0 -and -not $reportState.Valid) {
                    $exitMessage = "签到子进程异常退出（退出码 $($process.ExitCode)），且未生成有效 final 报告。"
                    try { [void](Invoke-SchedulerFailureNotification $exitMessage $config $true) }
                    catch { Write-SchedulerLog "签到子进程失败通知异常：$(Compress-SchedulerError $_.Exception.Message)" }
                }
            }
        }
        catch {
            $message = Compress-SchedulerError $_.Exception.Message
            if ($claimedThisLoop) {
                if ($null -ne $process) {
                    try { if (-not $process.HasExited) { $process.Kill($true) } } catch { try { $process.Kill() } catch { } }
                }
            }
            try { Write-SchedulerHeartbeat 'error' } catch { }
            $failureConfig = if ($null -ne $config) { $config } elseif ($null -ne $lastGoodConfig) { $lastGoodConfig } else { $initialConfig }
            $failureRecord = $null
            try { $failureRecord = Write-SchedulerFailureState $message $failureConfig $claimedThisLoop }
            catch { Write-SchedulerLog "调度器失败状态写入异常：$(Compress-SchedulerError $_.Exception.Message)" }
            if ($null -ne $failureRecord) {
                try {
                    $notificationHandled = Invoke-SchedulerFailureNotification $failureRecord.Message $failureConfig $failureRecord.ShouldNotify
                    if ($notificationHandled -and $failureRecord.ShouldNotify) {
                        Set-SchedulerFailureNotified $failureRecord.Hash $failureRecord.At
                    }
                }
                catch { Write-SchedulerLog "调度器失败通知异常：$(Compress-SchedulerError $_.Exception.Message)" }
            }
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
