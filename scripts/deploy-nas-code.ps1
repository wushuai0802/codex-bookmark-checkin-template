[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$SshTarget='ugreen-nas-cpa',
  [string]$RemoteRoot='/volume3/docker/checkin-fabric-v2',
  [string]$BundleDir='outputs/nas-bundle-deploy'
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
if(-not $PSCmdlet.ShouldProcess($RemoteRoot,'Deploy V2 dashboard code')){ Write-Output 'WhatIf: no NAS files or containers changed.'; return }
if($SshTarget -notmatch '^[A-Za-z0-9_.-]+$'){throw 'SshTarget is invalid'}
if($RemoteRoot -notmatch '^/volume3/docker/[A-Za-z0-9_.-]+$'){throw 'RemoteRoot is invalid'}
$ssh=(Get-Command ssh.exe,ssh -ErrorAction SilentlyContinue|Select-Object -First 1).Source
$scp=(Get-Command scp.exe,scp -ErrorAction SilentlyContinue|Select-Object -First 1).Source
if(-not $ssh -or -not $scp){throw 'ssh and scp are required'}
$bundle=Join-Path $root $BundleDir
& node (Join-Path $root 'scripts\export-nas-bundle.mjs') --out $bundle | Out-Null
if(-not (Test-Path -LiteralPath (Join-Path $bundle 'src') -PathType Container)){throw 'NAS bundle is incomplete'}
$stamp=Get-Date -Format 'yyyyMMdd-HHmmss';$stage="/home/wushuai0802/checkin-fabric-v2-deploy-$stamp";$remoteBackup="$RemoteRoot/backups/code-$stamp.tar.gz"
& $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "mkdir -p '$stage' && sudo -n test -d '$RemoteRoot' && sudo -n mkdir -p '$RemoteRoot/backups'";if($LASTEXITCODE -ne 0){throw 'NAS preflight failed'}
$items=@('Dockerfile','compose.nas.yaml','compose.worker.yaml','.dockerignore','package.json','package-lock.json','src','public','TRANSFER-MANIFEST.txt')
foreach($item in $items){
  & $scp -q -r -o BatchMode=yes -o ConnectTimeout=15 (Join-Path $bundle $item) ("${SshTarget}:$stage/")
  if($LASTEXITCODE -ne 0){throw "NAS bundle upload failed for $item"}
}
if($PSCmdlet.ShouldProcess($RemoteRoot,'Backup and deploy V2 code')){
  & $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "sudo -n tar -czf '$remoteBackup' -C '$RemoteRoot' src public package.json package-lock.json Dockerfile compose.nas.yaml compose.worker.yaml .dockerignore";if($LASTEXITCODE -ne 0){throw 'NAS code backup failed'}
  $deploy="set -eu; sudo -n cp -a '$stage/src/.' '$RemoteRoot/src/'; sudo -n cp -a '$stage/public/.' '$RemoteRoot/public/'; sudo -n install -m 0644 '$stage/package.json' '$RemoteRoot/package.json'; sudo -n install -m 0644 '$stage/package-lock.json' '$RemoteRoot/package-lock.json'; sudo -n install -m 0644 '$stage/Dockerfile' '$RemoteRoot/Dockerfile'; sudo -n install -m 0644 '$stage/compose.nas.yaml' '$RemoteRoot/compose.nas.yaml'; sudo -n docker compose -f '$RemoteRoot/compose.nas.yaml' -f '$RemoteRoot/compose.worker.yaml' up -d --build --force-recreate checkin-fabric-dashboard; sudo -n rm -rf '$stage'"
  & $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget $deploy;if($LASTEXITCODE -ne 0){throw "NAS deployment failed; backup=$remoteBackup"}
  $healthy=$false
  for($attempt=0;$attempt -lt 18;$attempt++){
    $health=& $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "sudo -n docker inspect --format '{{.State.Health.Status}}' checkin-fabric-dashboard";
    if($LASTEXITCODE -eq 0 -and ([string]$health).Trim() -eq 'healthy'){$healthy=$true;break}
    Start-Sleep -Seconds 5
  }
  if(-not $healthy){throw "NAS health is not healthy; backup=$remoteBackup"}
  Write-Output "NAS V2 code deployed; backup=$remoteBackup"
}
else { Write-Output "WhatIf: bundle uploaded to $stage; no deployment performed." }
