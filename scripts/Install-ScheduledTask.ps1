[CmdletBinding()]
param(
    [string]$Time,
    [switch]$AllowUserSchedulerFallback
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$schedule = if ($Time) { $Time } else { [string]$config.schedule }

if ($schedule -notmatch '^([01]\d|2[0-3]):[0-5]\d$') {
    throw "无效时间：$schedule，应为 HH:mm。"
}

$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$schedulerScript`" -Once"
$action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $root
$scheduleTime = [datetime]::ParseExact($schedule, 'HH:mm', $null)
$probeInterval = if ($null -ne $config.schedulerProbeIntervalMinutes) { [int]$config.schedulerProbeIntervalMinutes } else { 60 }
$probeInterval = [Math]::Max(30, [Math]::Min(180, $probeInterval))
$startMinutes = $scheduleTime.Hour * 60 + $scheduleTime.Minute
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$trigger = @(
    New-ScheduledTaskTrigger -AtLogOn -User $identity
    for ($minute = $startMinutes; $minute -lt 24 * 60; $minute += $probeInterval) {
        New-ScheduledTaskTrigger -Daily -At $scheduleTime.Date.AddMinutes($minute)
    }
)
$taskRunAttempts = [Math]::Max(1, [Math]::Min(3, [int]$config.taskRunAttempts))
$taskTimeoutMinutes = [Math]::Max(5, [Math]::Min(55, [int]$config.taskTimeoutMinutes))
$taskRetryDelayMinutes = [Math]::Max(0, [Math]::Min(30, [int]$config.taskRetryDelayMinutes))
$executionLimitMinutes = $taskRunAttempts * $taskTimeoutMinutes + ($taskRunAttempts - 1) * $taskRetryDelayMinutes + 15
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -WakeToRun `
    -Hidden `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $executionLimitMinutes) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description '后台读取 Chrome 的签到与公益站书签，使用独立无界面浏览器每日签到。'

try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null
    $registeredTask = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($null -eq $registeredTask) { throw '计划任务注册后无法读取。' }
}
catch {
    $registrationError = $_.Exception.Message
    if (-not $AllowUserSchedulerFallback) {
        throw "当前权限无法注册 Windows 计划任务。用户明确接受回退方案后，使用 -AllowUserSchedulerFallback 重试。原因：$registrationError"
    }
    # A stale task may still exist with an older trigger cadence.  Disable it
    # before handing ownership to the user-level supervisor, so both schedulers
    # cannot keep waking the project indefinitely.
    try {
        if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
            Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null
        }
    }
    catch {
        Write-Warning "无法停用旧的 Windows 计划任务，将由运行锁阻止重复签到：$($_.Exception.Message)"
    }
    Write-Warning "当前权限无法注册 Windows 计划任务，回退到已获用户同意的隐藏调度器：$registrationError"
    & (Join-Path $PSScriptRoot 'Install-UserScheduler.ps1')
    return
}

# The scheduled task replaces the legacy long-running login scheduler.  Keep
# only one owner of the daily run so no duplicate browser/profile access occurs.
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runKeyName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$supervisorScript = Join-Path $PSScriptRoot 'UserSchedulerSupervisor.vbs'
$shortcutShell = New-Object -ComObject WScript.Shell
$legacyRunNames = @($runKeyName, 'CodexBookmarkDailyCheckin', 'ChromeDailyCheckin') | Sort-Object -Unique
foreach ($legacyName in $legacyRunNames) {
    $runValue = $null
    try {
        $runProperties = Get-ItemProperty -Path $runKey -ErrorAction Stop
        $runValue = [string]$runProperties.PSObject.Properties[$legacyName].Value
    } catch { $runValue = $null }
    if ($runValue -and $runValue.IndexOf($supervisorScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Remove-ItemProperty -Path $runKey -Name $legacyName -ErrorAction SilentlyContinue
    }
    $shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$legacyName.lnk"
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $shortcut = $shortcutShell.CreateShortcut($shortcutPath)
        $shortcutCommand = "$( [string]$shortcut.TargetPath ) $( [string]$shortcut.Arguments )"
        if ($shortcutCommand.IndexOf($supervisorScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
        }
    }
}
$schedulerScripts = @($schedulerScript, (Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'))
Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and @($schedulerScripts | Where-Object { $commandLine -like "*-File*$_*" }).Count -gt 0
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object {
    [string]$_.CommandLine -like "*$supervisorScript*"
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Output "计划任务已安装：$taskName；登录时执行补偿探测，并从每天 $schedule 起每 $probeInterval 分钟探测一次，仅在需要时执行或补跑。"
