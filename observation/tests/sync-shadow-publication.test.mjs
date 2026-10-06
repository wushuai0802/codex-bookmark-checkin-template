import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('shadow publication uses a unique staging transaction and bounded cleanup',()=>{
  const source=fs.readFileSync(new URL('../scripts/Sync-ShadowPublication.ps1',import.meta.url),'utf8');
  assert.match(source,/New-ShadowPublicationPlan/);
  assert.match(source,/TransactionId/);
  assert.match(source,/archive-list/);
  assert.match(source,/expected-list/);
  assert.match(source,/shadow-sync-stage-\*/);
  assert.match(source,/-mmin \+1440/);
  assert.match(source,/test -w '\$project'/);
  assert.match(source,/Invoke-BoundedSyncProcess/);
  assert.doesNotMatch(source,/rm -rf -- '\$NasStagingDir/);
});

test('local and passive evidence publication share a cross-process lease',()=>{
  const sync=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  const repair=fs.readFileSync(new URL('../src/pt-evidence-repair.mjs',import.meta.url),'utf8');
  assert.match(sync,/shadow-publication\.lock/);
  assert.match(sync,/Acquire-ShadowPublicationLease/);
  assert.match(repair,/name:'shadow-publication\.lock'/);
});

test('shadow scheduler runs a post-evidence observation-only publication',()=>{
  const source=fs.readFileSync(new URL('../scripts/Start-NasShadowScheduler.ps1',import.meta.url),'utf8');
  const sync=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  assert.match(source,/pt-evidence-repair-dirty-/);
  assert.match(source,/-SkipHarvestFallback/);
  assert.match(source,/evidence_dashboard_sync/);
  assert.match(sync,/SkipHarvestFallback/);
});

test('scheduler respects current retry state and scans dated evidence markers',()=>{
  const source=fs.readFileSync(new URL('../scripts/Start-NasShadowScheduler.ps1',import.meta.url),'utf8');
  assert.match(source,/normalSyncAttempted/);
  assert.match(source,/currentRetryAt/);
  assert.match(source,/Get-PendingEvidenceMarkers/);
  assert.match(source,/publishedEvidenceFingerprint/);
  assert.match(source,/taskkill\.exe/);
});

test('shadow sync bounds Harvest fallback and cleans only expired inactive inputs',()=>{
  const source=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  assert.match(source,/Remove-StaleHarvestFallbackPending/);
  assert.match(source,/Get-CimInstance Win32_Process/);
  assert.match(source,/harvest_fallback/);
  assert.match(source,/Invoke-BoundedSyncProcess \$NodePath/);
  assert.doesNotMatch(source,/Start-Process -FilePath \$NodePath/);
});
