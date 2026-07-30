[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$watchdogScript = Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'
$supervisorScript = Join-Path $PSScriptRoot 'UserSchedulerSupervisor.vbs'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$valueName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$valueName.lnk"
$shell = (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
$command = "wscript.exe `"$supervisorScript`" `"$shell`" primary"

if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey | Out-Null }
New-ItemProperty -Path $runKey -Name $valueName -Value $command -PropertyType String -Force | Out-Null
$shortcutShell = New-Object -ComObject WScript.Shell
$shortcut = $shortcutShell.CreateShortcut($startupShortcutPath)
$shortcut.TargetPath = (Get-Command wscript.exe -ErrorAction Stop).Source
$shortcut.Arguments = "`"$supervisorScript`" `"$shell`" fallback"
$shortcut.WorkingDirectory = $root
$shortcut.WindowStyle = 7
$shortcut.Save()

$statePath = Join-Path $root 'data\scheduler-state.json'
if (-not (Test-Path -LiteralPath $statePath)) {
    $state = [ordered]@{
        lastRunDate = (Get-Date).ToString('yyyy-MM-dd')
        lastFinishedAt = (Get-Date).ToString('o')
        lastExitCode = 0
        initializedFromCompletedCalibration = $true
    }
    [System.IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
}

$ownedScripts = @($schedulerScript, $watchdogScript)
Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and @($ownedScripts | Where-Object { $commandLine -like "*-File*$_*" }).Count -gt 0
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object {
    [string]$_.CommandLine -like "*$supervisorScript*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

Start-Process -FilePath 'wscript.exe' -ArgumentList @("`"$supervisorScript`"", "`"$shell`"", 'primary') -WindowStyle Hidden

Write-Output '用户级后台调度器已安装并启动；注册表与启动文件夹双入口会恢复独立守护、看门狗和签到调度器。'
