[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\config.json'
$config = if (Test-Path -LiteralPath $configPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json } else { $null }
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "已删除计划任务：$taskName"
} else {
    Write-Output "未找到计划任务：$taskName"
}
