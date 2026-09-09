[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$AccountKey = 'api42-20603',
  [string]$DailyTime = '07:50',
  [datetime]$RunDate = (Get-Date).Date.AddDays(1),
  [string]$TaskName = 'CodexCheckinFabricV2Canary'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if($DailyTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$'){throw 'DailyTime must be HH:mm'}
$runAt=[datetime]::ParseExact("$($RunDate.ToString('yyyy-MM-dd')) $DailyTime",'yyyy-MM-dd HH:mm',$null)
if($runAt -le (Get-Date)){throw 'RunDate/DailyTime must be in the future'}
$node=(Get-Command node.exe -ErrorAction SilentlyContinue|Select-Object -First 1).Source
if(-not $node){$node='C:\Program Files\nodejs\node.exe'}
if(-not (Test-Path -LiteralPath $node)){throw 'Node.js executable not found'}
$script=Join-Path $root 'scripts\run-v2-daily.mjs'
if(-not (Test-Path -LiteralPath $script)){throw 'V2 daily runner is missing'}
$existing=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($existing){
  $action=@($existing.Actions)[0]
  if([string]$action.Execute -ne $node -or [string]$action.Arguments -notlike "*run-v2-daily.mjs*--account-key*$AccountKey*"){throw "Existing task $TaskName is not owned by V2 canary runner"}
  if(-not $PSCmdlet.ShouldProcess($TaskName,'Replace existing V2 canary task')){ return }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$args="`"$script`" --execute --account-key $AccountKey"
$action=New-ScheduledTaskAction -Execute $node -Argument $args -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -Once -At $runAt
$principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -StartWhenAvailable:$false -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
if($PSCmdlet.ShouldProcess($TaskName,"Register one-time V2 canary for $AccountKey at $runAt")){
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'V2 single-account canary; V1 remains fallback until authoritative success.' | Out-Null
  Write-Output "Registered $TaskName for $runAt ($AccountKey)."
}
