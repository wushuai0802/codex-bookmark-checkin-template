[CmdletBinding(SupportsShouldProcess)]
param([string]$SshTarget='nas-checkin',[string]$NasDataDir='/volume3/docker/checkin-fabric-v2/nas-data')
$ErrorActionPreference='Stop';$root=Split-Path -Parent $PSScriptRoot
if($SshTarget -notmatch '^[A-Za-z0-9_.-]+$'){throw 'SshTarget is invalid'}
if($NasDataDir -notmatch '^/volume3/docker/[A-Za-z0-9_.-]+/nas-data$'){throw 'NasDataDir is invalid'}
if(-not $PSCmdlet.ShouldProcess($NasDataDir,'Sync redacted V2 canary status')){Write-Output 'WhatIf: no status files changed.';return}
$ssh=(Get-Command ssh.exe,ssh -ErrorAction SilentlyContinue|Select-Object -First 1).Source;if(-not $ssh){throw 'ssh is required'}
& node (Join-Path $PSScriptRoot 'export-dashboard-status.mjs')
if($LASTEXITCODE -ne 0){throw 'Dashboard status export failed'}
$files=@(Get-Item -LiteralPath (Join-Path $root 'outputs\dashboard-runtime.json'))
$stage="/tmp/checkin-fabric-status-$([guid]::NewGuid().ToString('N'))"; & $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "umask 077 && mkdir -m 0700 '$stage' && sudo -n test -d '$NasDataDir'";if($LASTEXITCODE -ne 0){throw 'NAS status preflight failed'}
try {
  foreach($file in $files){$cmd=Join-Path $root 'outputs\status-upload.cmd';$text="@echo off`r`n`"$ssh`" -o BatchMode=yes -o ConnectTimeout=15 $SshTarget `"cat > '$stage/$($file.Name)'`" < `"$($file.FullName)`"`r`nexit /b %ERRORLEVEL%`r`n";[IO.File]::WriteAllText($cmd,$text,[Text.Encoding]::ASCII);& cmd.exe /d /c $cmd;$code=$LASTEXITCODE;Remove-Item -LiteralPath $cmd -Force -ErrorAction SilentlyContinue;if($code -ne 0){throw "status upload failed: $($file.Name)"}}
  foreach($file in $files){$remote="$stage/$($file.Name)";$target="$NasDataDir/$($file.Name)";& $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "sudo -n install -o 1000 -g 1000 -m 0644 '$remote' '$target.tmp' && sudo -n mv '$target.tmp' '$target' && rm -f '$remote'";if($LASTEXITCODE -ne 0){throw "status install failed: $($file.Name)"}}
  Write-Output "Synced $($files.Count) redacted V2 status files."
} finally {& $ssh -o BatchMode=yes -o ConnectTimeout=15 $SshTarget "rm -rf '$stage'" | Out-Null}
