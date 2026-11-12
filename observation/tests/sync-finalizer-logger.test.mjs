import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scripts=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','scripts');
const syncScript=path.join(scripts,'Sync-NasShadow.ps1');

test('the sync entry supplies the logger its support functions call, so a notifier refresh cannot fail a sync',()=>{
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'sync-finalizer-')));
  try{
    fs.mkdirSync(path.join(root,'scripts'));
    for(const name of ['Submit-UnifiedCheckinReport.ps1','Invoke-CheckinNotificationOutbox.ps1'])fs.writeFileSync(path.join(root,'scripts',name),'exit 1');
    const driver=path.join(root,'driver.ps1');
    // Take the logger definitions from the real entry script and the notifier
    // from the real support file; only the process transport is synthetic.
    fs.writeFileSync(driver,`
param([string]$SyncScript,[string]$Support,[string]$LegacyRoot)
$ErrorActionPreference='Stop'
$ast=[System.Management.Automation.Language.Parser]::ParseFile($SyncScript,[ref]$null,[ref]$null)
$wanted='Write-Log','Write-SchedulerLog'
$found=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name},$false))
foreach($definition in $found){ . ([scriptblock]::Create($definition.Extent.Text)) }
. $Support
function Invoke-BoundedSyncProcess { return [pscustomobject]@{exitCode=1;output=@()} }
Update-SynchronizedCheckinNotification $LegacyRoot
Write-Output 'finalizer returned'
`);
    const run=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',driver,'-SyncScript',syncScript,
      '-Support',path.join(scripts,'Sync-OperationsSupport.ps1'),'-LegacyRoot',root],{encoding:'utf8',windowsHide:true,timeout:60_000});
    assert.equal(run.status,0,run.stderr||run.stdout);
    assert.match(run.stdout,/Daily receipt refresh deferred \(phase=report_refresh; code=report_refresh_failed\)/);
    assert.match(run.stdout,/finalizer returned/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('the sync entry reconciles the daily receipt itself only after an incomplete publication, and guards the call',()=>{
  const text=fs.readFileSync(syncScript,'utf8');
  const calls=[...text.matchAll(/Update-SynchronizedCheckinNotification/g)];
  assert.equal(calls.length,1);
  assert.match(text,/if \(\$localPublished -and -not \$publicationCompleted -and -not \$NoUpload\) \{\s*try \{ Update-SynchronizedCheckinNotification \$resolvedLegacyRoot \}\s*catch \{/);
  assert.ok(text.indexOf('$publicationCompleted = $true')>text.indexOf('Write-Log "Sync complete:'));
});
