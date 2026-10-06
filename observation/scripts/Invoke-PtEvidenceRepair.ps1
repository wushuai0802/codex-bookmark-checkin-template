[CmdletBinding()]
param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot),[Parameter(Mandatory)][string]$CatalogFile,[ValidateRange(1,4)][int]$MaxSites=1,[ValidateRange(30,600)][int]$TimeoutSeconds=240)
$ErrorActionPreference='Stop'
if(-not (Test-Path -LiteralPath $CatalogFile -PathType Leaf)){return}
$runtime=Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot 'config/runtime.local.json')|ConvertFrom-Json
$config=Get-Content -Raw -LiteralPath (Join-Path $runtime.legacyRoot 'config/config.json')|ConvertFrom-Json
. (Join-Path $runtime.legacyRoot 'scripts/Resolve-Runtime.ps1')
. (Join-Path $ProjectRoot 'scripts/Sync-Transport.ps1')
$node=Resolve-CheckinNode $config
$worker=Join-Path $ProjectRoot 'scripts/reconcile-pt-evidence.mjs'
$process=Start-Process -FilePath $node -ArgumentList @('"'+$worker+'"','"'+[IO.Path]::GetFullPath($CatalogFile)+'"',[string]$MaxSites) -WorkingDirectory $ProjectRoot -WindowStyle Hidden -PassThru
try {
  if(-not $process.WaitForExit($TimeoutSeconds*1000)) {
    Stop-SyncProcessTree $process
    throw "PT evidence worker timed out after $TimeoutSeconds seconds"
  }
  if($process.ExitCode -ne 0){ throw "PT evidence worker failed with exit code $($process.ExitCode)" }
} finally {
  try { $process.Dispose() } catch { }
}
