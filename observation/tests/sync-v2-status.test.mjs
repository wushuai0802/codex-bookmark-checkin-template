import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('status sync allowlists only redacted result files and preserves NAS data boundaries',()=>{
  const source=fs.readFileSync(new URL('../scripts/sync-v2-status.ps1',import.meta.url),'utf8');
  assert.match(source,/export-dashboard-status\.mjs/);assert.match(source,/dashboard-runtime\.json/);assert.match(source,/Sync-Transport\.ps1/);assert.match(source,/Invoke-BoundedSyncProcess/);assert.match(source,/Invoke-StatusSshWithRetry/);assert.match(source,/status_upload/);assert.match(source,/-mmin \+120/);assert.match(source,/sudo -n install/);assert.match(source,/sudo -n mv/);assert.doesNotMatch(source,/cmd\.exe|status-upload\.cmd|&\s*\$ssh|v2-profiles|credentials|transport-data|migration-|v2-daily/i);
});

test('shared transport drains both streams, closes stdin and bounds the process tree',()=>{
  const transport=fs.readFileSync(new URL('../scripts/Sync-Transport.ps1',import.meta.url),'utf8');
  assert.match(transport,/ReadToEndAsync/);assert.match(transport,/StandardInput\.Close/);assert.match(transport,/CopyToAsync/);assert.match(transport,/Stop-SyncProcessTree/);assert.match(transport,/Kill\(\$true\)/);
});
