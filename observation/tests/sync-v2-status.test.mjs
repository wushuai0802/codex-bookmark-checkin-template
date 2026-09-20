import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('status sync allowlists only redacted result files and preserves NAS data boundaries',()=>{
  const source=fs.readFileSync(new URL('../scripts/sync-v2-status.ps1',import.meta.url),'utf8');
  assert.match(source,/export-dashboard-status\.mjs/);assert.match(source,/dashboard-runtime\.json/);assert.match(source,/cat >/);assert.match(source,/sudo -n install/);assert.match(source,/sudo -n mv/);assert.doesNotMatch(source,/v2-profiles|credentials|transport-data|migration-|v2-daily/i);
});
