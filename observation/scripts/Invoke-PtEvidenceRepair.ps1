[CmdletBinding()]
param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot),[Parameter(Mandatory)][string]$CatalogFile,[ValidateRange(1,4)][int]$MaxSites=1)
$ErrorActionPreference='Stop'
if(-not (Test-Path -LiteralPath $CatalogFile -PathType Leaf)){return}
$runtime=Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'config/runtime.local.json')|ConvertFrom-Json
$config=Get-Content -Raw -LiteralPath (Join-Path $runtime.legacyRoot 'config/config.json')|ConvertFrom-Json
. (Join-Path $runtime.legacyRoot 'scripts/Resolve-Runtime.ps1')
$node=Resolve-CheckinNode $config
$worker=Join-Path $ProjectRoot 'scripts/reconcile-pt-evidence.mjs'
Start-Process -FilePath $node -ArgumentList @('"'+$worker+'"','"'+[IO.Path]::GetFullPath($CatalogFile)+'"',[string]$MaxSites) -WorkingDirectory $ProjectRoot -WindowStyle Hidden | Out-Null
