import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('shadow publication uses a unique staging transaction and bounded cleanup',()=>{
  const source=fs.readFileSync(new URL('../scripts/Sync-ShadowPublication.ps1',import.meta.url),'utf8');
  assert.match(source,/New-ShadowPublicationPlan/);
  assert.match(source,/TransactionId/);
  assert.match(source,/archive-list/);
  assert.match(source,/expected-list/);
  assert.match(source,/Invoke-BoundedSyncProcess/);
  assert.doesNotMatch(source,/rm -rf|rmdir -- '\$NasStagingDir'/);
});

test('shadow scheduler runs a post-evidence observation-only publication',()=>{
  const source=fs.readFileSync(new URL('../scripts/Start-NasShadowScheduler.ps1',import.meta.url),'utf8');
  const sync=fs.readFileSync(new URL('../scripts/Sync-NasShadow.ps1',import.meta.url),'utf8');
  assert.match(source,/pt-evidence-repair-dirty-/);
  assert.match(source,/-SkipHarvestFallback/);
  assert.match(source,/evidence_dashboard_sync/);
  assert.match(sync,/SkipHarvestFallback/);
});
