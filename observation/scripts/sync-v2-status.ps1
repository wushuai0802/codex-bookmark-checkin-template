[CmdletBinding(SupportsShouldProcess)]
param([string]$SshTarget='',[string]$NasDataDir='/volume3/docker/checkin-fabric-v2/nas-data')
$ErrorActionPreference='Stop';$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Sync-Transport.ps1')

function New-StatusSshArguments([string]$Target, [string]$RemoteCommand) {
  return @('-T','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',$Target,$RemoteCommand)
}

function Invoke-StatusSsh([string]$SshPath, [string]$Target, [string]$RemoteCommand, [string]$Phase, [string]$InputFile = '', [int]$TimeoutSeconds = 15) {
  return Invoke-BoundedSyncProcess $SshPath (New-StatusSshArguments $Target $RemoteCommand) $Phase $InputFile $TimeoutSeconds
}

function Invoke-StatusSshWithRetry([string]$SshPath, [string]$Target, [string]$RemoteCommand, [string]$Phase, [string]$InputFile = '', [int]$TimeoutSeconds = 15, [int]$MaxAttempts = 2) {
  $MaxAttempts=[Math]::Max(1,[Math]::Min(3,$MaxAttempts))
  for($attempt=1;$attempt -le $MaxAttempts;$attempt++){
    $result=Invoke-StatusSsh $SshPath $Target $RemoteCommand $Phase $InputFile $TimeoutSeconds
    if($result.exitCode -eq 0 -or $attempt -eq $MaxAttempts -or $result.failure -notmatch 'cause=(connection_timeout|connection_interrupted|ssh_transport_failed)\)'){return $result}
    Start-Sleep -Seconds ([Math]::Min(3,$attempt))
  }
}
if(-not $SshTarget){
  $SshTarget=$env:CHECKIN_NAS_SSH_TARGET
  if(-not $SshTarget){try{
    $runtime=Get-Content -Raw -LiteralPath (Join-Path $root 'config/runtime.local.json')|ConvertFrom-Json
    $binding=Get-Content -Raw -LiteralPath (Join-Path $runtime.legacyRoot 'data/v2-integration.json')|ConvertFrom-Json
    $SshTarget=[string]$binding.harvestPtGate.sshTarget
  }catch{}}
  if(-not $SshTarget){$SshTarget='nas-checkin'}
}
if($SshTarget -notmatch '^[A-Za-z0-9_.-]+$'){throw 'SshTarget is invalid'}
if($NasDataDir -notmatch '^/volume3/docker/[A-Za-z0-9_.-]+/nas-data$'){throw 'NasDataDir is invalid'}
if(-not $PSCmdlet.ShouldProcess($NasDataDir,'Sync redacted V2 canary status')){Write-Output 'WhatIf: no status files changed.';return}
$ssh=(Get-Command ssh.exe,ssh -ErrorAction SilentlyContinue|Select-Object -First 1).Source;if(-not $ssh){throw 'ssh is required'}
& node (Join-Path $PSScriptRoot 'export-dashboard-status.mjs')
if($LASTEXITCODE -ne 0){throw 'Dashboard status export failed'}
$files=@(Get-Item -LiteralPath (Join-Path $root 'outputs\dashboard-runtime.json'))
$nasProject=$NasDataDir.Substring(0,$NasDataDir.Length-'/nas-data'.Length)
$stage="$nasProject/.v2-status-$([guid]::NewGuid().ToString('N'))"
try {
  $preflight=Invoke-StatusSshWithRetry $ssh $SshTarget "sudo -n find '$nasProject' -maxdepth 1 -type d -name '.v2-status-*' -mmin +120 -exec rm -rf -- {} +; install -d -m 0700 '$stage' && sudo -n test -d '$NasDataDir'" 'status_preflight' '' 15 1
  if($preflight.exitCode -ne 0){throw $preflight.failure}
  foreach($file in $files){
    $upload=Invoke-StatusSshWithRetry $ssh $SshTarget "cat > '$stage/$($file.Name)'" 'status_upload' $file.FullName 15 2
    if($upload.exitCode -ne 0){throw $upload.failure}
  }
  foreach($file in $files){
    $remote="$stage/$($file.Name)";$target="$NasDataDir/$($file.Name)"
    $install=Invoke-StatusSshWithRetry $ssh $SshTarget "sudo -n install -o 1000 -g 1000 -m 0644 '$remote' '$target.tmp' && sudo -n mv '$target.tmp' '$target' && rm -f '$remote'" 'status_install' '' 15 1
    if($install.exitCode -ne 0){throw $install.failure}
  }
  Write-Output "Synced $($files.Count) redacted V2 status files."
} finally {
  $cleanup=Invoke-StatusSsh $ssh $SshTarget "rm -f '$stage/dashboard-runtime.json'; rmdir -- '$stage'" 'status_cleanup' '' 10
  if($cleanup.exitCode -ne 0){Write-Verbose 'Status sync cleanup did not complete; the next bounded preflight will remove stale temporary directories.'}
}
