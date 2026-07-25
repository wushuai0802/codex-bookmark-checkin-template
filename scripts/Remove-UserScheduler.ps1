[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json } else { $null }
$valueName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $valueName -ErrorAction SilentlyContinue
$scriptPaths = @((Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'), (Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'))
$supervisorScript = Join-Path $PSScriptRoot 'UserSchedulerSupervisor.vbs'
Get-CimInstance Win32_Process | Where-Object {
    $commandLine = [string]$_.CommandLine
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and @($scriptPaths | Where-Object { $commandLine -like "*-File*$_*" }).Count -gt 0
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='wscript.exe'" | Where-Object {
    [string]$_.CommandLine -like "*$supervisorScript*"
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output '已移除用户级后台调度器的登录启动项，并停止独立守护、调度器与看门狗。'
