[CmdletBinding()]
param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot),[Parameter(Mandatory)][string]$SshTarget)
$ErrorActionPreference='Stop'
if($SshTarget -notmatch '^[A-Za-z0-9._@-]{1,120}$'){throw 'Invalid SSH target'}
$runtime=Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'config/runtime.local.json')|ConvertFrom-Json
$config=Get-Content -Raw -LiteralPath (Join-Path $runtime.legacyRoot 'config/config.json')|ConvertFrom-Json
. (Join-Path $runtime.legacyRoot 'scripts/Resolve-Runtime.ps1')
$node=Resolve-CheckinNode $config
$worker=Join-Path $ProjectRoot 'scripts/process-dashboard-operations.mjs'
Start-Process -FilePath $node -ArgumentList @('"'+$worker+'"','--ssh-target',$SshTarget) -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
