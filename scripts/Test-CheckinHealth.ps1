[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [ordered]@{ healthy = $false; reason = 'not_initialized'; checks = @{ configPresent = $false } } | ConvertTo-Json -Depth 5
    return
}
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$latestPath = Join-Path $root 'logs\latest.json'
$statePath = Join-Path $root 'data\site-state.json'
$notificationQuarantinePath = Join-Path $root 'data\notification-outbox\quarantine'
$notificationQuarantinedCount = @(Get-ChildItem -LiteralPath $notificationQuarantinePath -Filter '*.invalid.json' -File -ErrorAction SilentlyContinue).Count
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$runKeyName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$runValue = try {
    $runProperties = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
    [string]$runProperties.$runKeyName
} catch { $null }
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
$problemCount = if ($latest) { @($latest.results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') }).Count } else { $null }
$notificationReady = $config.notification.mode -in @($null, '', 'none') -or (
    $config.notification.mode -eq 'command' -and
    ((Test-Path -LiteralPath ([string]$config.notification.executable)) -or (Get-Command ([string]$config.notification.executable) -ErrorAction SilentlyContinue))
)
$checks = [ordered]@{
    configPresent = $true
    bookmarksReadable = Test-Path -LiteralPath ([string]$config.bookmarksPath)
    chromeExecutablePresent = Test-Path -LiteralPath ([string]$config.chromeExecutable)
    automationProfilePresent = Test-Path -LiteralPath (Join-Path ([string]$config.automationUserDataDir) 'Local State')
    notificationReady = [bool]$notificationReady
    notificationOutboxClean = $notificationQuarantinedCount -eq 0
    schedulerReady = [bool]$scheduledTask -or [bool]$runValue
    schedulerUnique = if ($scheduledTask) { $true } else { $schedulerCount -eq 1 -and $watchdogCount -eq 1 -and $supervisorCount -eq 1 }
    schedulerHeartbeatFresh = [bool]$heartbeatFresh
    latestResultPresent = [bool]$latest
    latestResultConfirmed = $null -ne $problemCount -and $problemCount -eq 0
    latestResultComplete = $null -ne $problemCount -and $problemCount -eq 0
    siteStatePresent = Test-Path -LiteralPath $statePath
}
[ordered]@{
    healthy = -not ($checks.Values -contains $false)
    schedule = [string]$config.schedule
    schedulerMode = if ($scheduledTask) { 'windows_task' } elseif ($runValue) { 'user_scheduler' } else { 'none' }
    schedulerProcessCount = $schedulerCount
    watchdogProcessCount = $watchdogCount
    supervisorProcessCount = $supervisorCount
    latestRunId = if ($latest) { [string]$latest.runId } else { $null }
    latestSiteCount = if ($latest) { @($latest.results).Count } else { $null }
    latestProblemCount = $problemCount
    schedulerAttemptsToday = if ($schedulerState) { [int]$schedulerState.attemptsToday } else { 0 }
    schedulerNextEligibleAt = if ($schedulerState -and $schedulerState.nextEligibleAt) { try { ([datetime]$schedulerState.nextEligibleAt).ToString('o') } catch { [string]$schedulerState.nextEligibleAt } } else { $null }
    schedulerReportComplete = if ($schedulerState) { [bool]$schedulerState.reportComplete } else { $false }
    notificationQuarantinedCount = $notificationQuarantinedCount
    checks = $checks
} | ConvertTo-Json -Depth 6
