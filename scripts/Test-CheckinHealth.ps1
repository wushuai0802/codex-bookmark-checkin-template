[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
trap {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'health_check_error'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('healthCheckExecution')
        error = $_.Exception.Message
        checks = [ordered]@{ healthCheckExecution = $false }
    } | ConvertTo-Json -Depth 5
    exit 3
}

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'not_initialized'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('configPresent')
        checks = [ordered]@{ configPresent = $false }
    } | ConvertTo-Json -Depth 5
    exit 2
}
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$latestPath = Join-Path $root 'logs\latest.json'
$statePath = Join-Path $root 'data\site-state.json'
$currentPlanPath = Join-Path $root 'data\last-valid-bookmark-plan.json'
$notificationQuarantinePath = Join-Path $root 'data\notification-outbox\quarantine'
$notificationQuarantinedCount = @(Get-ChildItem -LiteralPath $notificationQuarantinePath -Filter '*.invalid.json' -File -ErrorAction SilentlyContinue).Count
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$runKeyName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$runValue = try {
    $runProperties = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
    [string]$runProperties.$runKeyName
} catch { $null }
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$runKeyName.lnk"
$startupEntryPresent = [bool]$runValue -or (Test-Path -LiteralPath $startupShortcutPath -PathType Leaf)
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$watchdogScript = Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'
$supervisorScript = Join-Path $PSScriptRoot 'UserSchedulerSupervisor.vbs'
$schedulerCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$schedulerScript*"
}).Count
$watchdogCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$watchdogScript*"
}).Count
$supervisorCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'wscript.exe' -and $_.CommandLine -like "*$supervisorScript*"
}).Count
$latest = if (Test-Path -LiteralPath $latestPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json } else { $null }
$schedulerStatePath = Join-Path $root 'data\scheduler-state.json'
$schedulerState = if (Test-Path -LiteralPath $schedulerStatePath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $schedulerStatePath | ConvertFrom-Json } catch { $null } } else { $null }
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$heartbeat = if (Test-Path -LiteralPath $heartbeatPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $heartbeatPath | ConvertFrom-Json } else { $null }
$heartbeatMaxAgeMinutes = if ($heartbeat -and [string]$heartbeat.phase -eq 'running_checkin') { ([int]$config.taskTimeoutMinutes) + 10 } else { 5 }
$heartbeatFresh = $heartbeat -and ((Get-Date) - [datetime]$heartbeat.updatedAt) -lt [timespan]::FromMinutes($heartbeatMaxAgeMinutes)
$siteState = if (Test-Path -LiteralPath $statePath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null } } else { $null }
$currentPlan = if (Test-Path -LiteralPath $currentPlanPath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $currentPlanPath | ConvertFrom-Json } catch { $null } } else { $null }
$problemCount = if ($latest) { @($latest.results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') }).Count } else { $null }
$minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
$latestRunToday = $latest -and [string]$latest.runId -like "$(Get-Date -Format 'yyyyMMdd')-*"
$plannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
$processedTotal = if ($latest -and $null -ne $latest.processedTotal) { [int]$latest.processedTotal } else { 0 }
$supplementalAccounts = @(@($config.supplementalOAuthAccounts) | Where-Object { $null -ne $_ })
$currentBookmarkPlannedTotal = if ($currentPlan -and $null -ne $currentPlan.targetCount) { [int]$currentPlan.targetCount } elseif ($currentPlan) { @($currentPlan.targets).Count } else { $null }
$currentPlannedTotal = if ($null -ne $currentBookmarkPlannedTotal) { $currentBookmarkPlannedTotal + $supplementalAccounts.Count } else { $null }

function Get-PlanTargetIdentity([object]$Target, [bool]$ApplyConfiguredAccountIdentity) {
    $origin = try { ([uri][string]$Target.origin).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/') } catch { $null }
    if (-not $origin) { return $null }
    $accountKey = [string]$Target.accountKey
    if (-not $accountKey -and $ApplyConfiguredAccountIdentity -and $null -ne $config.oauthAccountIdentities) {
        $identityProperty = $config.oauthAccountIdentities.PSObject.Properties[$origin]
        if ($null -ne $identityProperty) { $accountKey = [string]$identityProperty.Value.accountKey }
    }
    if ($accountKey) { return "$origin#account=$accountKey" }
    return $origin
}

$currentPlanIdentities = if ($currentPlan) { @(
    @($currentPlan.targets) | ForEach-Object { Get-PlanTargetIdentity $_ $true }
    $supplementalAccounts | ForEach-Object { Get-PlanTargetIdentity $_ $false }
) | Where-Object { $_ } | Sort-Object -Unique } else { @() }
$latestPlanTargets = if ($latest -and $latest.bookmarkSummary) { @($latest.bookmarkSummary.targets) } else { @() }
$latestPlanIdentities = @($latestPlanTargets | ForEach-Object { Get-PlanTargetIdentity $_ $false } | Where-Object { $_ } | Sort-Object -Unique)
$currentPlanIdentityReady = $null -ne $currentPlannedTotal -and $currentPlanIdentities.Count -eq $currentPlannedTotal
$latestPlanIdentityReady = $latest -and $latestPlanIdentities.Count -eq $plannedTotal
$latestMatchesCurrentPlan = $currentPlanIdentityReady `
    -and $latestPlanIdentityReady `
    -and $currentPlannedTotal -eq $plannedTotal `
    -and @(Compare-Object -ReferenceObject $currentPlanIdentities -DifferenceObject $latestPlanIdentities).Count -eq 0
$latestResultValid = $latestRunToday `
    -and [string]$latest.runState -eq 'final' `
    -and $latest.isComplete -eq $true `
    -and $plannedTotal -ge $minimumTargets `
    -and $processedTotal -ge $plannedTotal `
    -and @($latest.results).Count -ge $plannedTotal
$notificationReady = $config.notification.mode -in @($null, '', 'none') -or (
    $config.notification.mode -eq 'command' -and
    ((Test-Path -LiteralPath ([string]$config.notification.executable)) -or (Get-Command ([string]$config.notification.executable) -ErrorAction SilentlyContinue))
)
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$dataPrefix = $dataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$supplementalProfiles = @($supplementalAccounts | ForEach-Object {
    $raw = [string]$_.automationUserDataDir
    $resolved = if ($raw) {
        if ([System.IO.Path]::IsPathRooted($raw)) { [System.IO.Path]::GetFullPath($raw) }
        else { [System.IO.Path]::GetFullPath((Join-Path $root $raw)) }
    } else { $null }
    $valid = $resolved -and $resolved.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    [pscustomobject]@{
        accountKey = [string]$_.accountKey
        path = $resolved
        valid = [bool]$valid
        present = $valid -and (Test-Path -LiteralPath (Join-Path $resolved 'Local State'))
    }
})
$checks = [ordered]@{
    configPresent = $true
    bookmarksReadable = Test-Path -LiteralPath ([string]$config.bookmarksPath)
    chromeExecutablePresent = Test-Path -LiteralPath ([string]$config.chromeExecutable)
    automationProfilePresent = Test-Path -LiteralPath (Join-Path ([string]$config.automationUserDataDir) 'Local State')
    supplementalProfilesPresent = @($supplementalProfiles | Where-Object { -not $_.present }).Count -eq 0
    notificationReady = [bool]$notificationReady
    notificationOutboxClean = $notificationQuarantinedCount -eq 0
    schedulerReady = [bool]$scheduledTask -or $startupEntryPresent
    schedulerUnique = if ($scheduledTask) { $true } else { $schedulerCount -eq 1 -and $watchdogCount -eq 1 -and $supervisorCount -eq 1 }
    schedulerHeartbeatFresh = [bool]$heartbeatFresh
    latestResultPresent = [bool]$latest
    latestResultValid = [bool]$latestResultValid
    latestMatchesCurrentPlan = [bool]$latestMatchesCurrentPlan
    latestResultConfirmed = $latestResultValid -and $problemCount -eq 0
    latestResultComplete = $latestResultValid -and $problemCount -eq 0
    siteStatePresent = $null -ne $siteState
}
$failedChecks = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value } | ForEach-Object { [string]$_.Key })
$healthy = $failedChecks.Count -eq 0
$result = [ordered]@{
    schemaVersion = 1
    healthy = $healthy
    reason = if ($healthy) { 'ok' } else { 'checks_failed' }
    checkedAt = (Get-Date).ToString('o')
    failedChecks = $failedChecks
    schedule = [string]$config.schedule
    schedulerMode = if ($scheduledTask) { 'windows_task' } elseif ($startupEntryPresent) { 'user_scheduler' } else { 'none' }
    schedulerRunKeyPresent = [bool]$runValue
    schedulerStartupShortcutPresent = Test-Path -LiteralPath $startupShortcutPath -PathType Leaf
    schedulerProcessCount = $schedulerCount
    watchdogProcessCount = $watchdogCount
    supervisorProcessCount = $supervisorCount
    schedulerHeartbeat = $heartbeat
    latestRunId = if ($latest) { [string]$latest.runId } else { $null }
    latestSiteCount = if ($latest) { @($latest.results).Count } else { $null }
    currentPlannedTotal = $currentPlannedTotal
    latestPlannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { $null }
    currentPlanMatchesLatest = [bool]$latestMatchesCurrentPlan
    currentPlanIdentityCount = $currentPlanIdentities.Count
    latestPlanIdentityCount = $latestPlanIdentities.Count
    latestProblemCount = $problemCount
    schedulerAttemptsToday = if ($schedulerState) { [int]$schedulerState.attemptsToday } else { 0 }
    schedulerNextEligibleAt = if ($schedulerState -and $schedulerState.nextEligibleAt) { try { ([datetime]$schedulerState.nextEligibleAt).ToString('o') } catch { [string]$schedulerState.nextEligibleAt } } else { $null }
    schedulerReportComplete = if ($schedulerState) { [bool]$schedulerState.reportComplete } else { $false }
    notificationQuarantinedCount = $notificationQuarantinedCount
    trackedSiteCount = if ($siteState -and $siteState.sites) { @($siteState.sites.PSObject.Properties).Count } else { 0 }
    supplementalProfiles = $supplementalProfiles
    checks = $checks
}
$result | ConvertTo-Json -Depth 6
if (-not $healthy) { exit 2 }
