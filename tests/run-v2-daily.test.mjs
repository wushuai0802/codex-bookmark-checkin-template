import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('daily V2 entry enforces a narrow execution window and uses migration candidates',()=>{
  const source=fs.readFileSync(new URL('../scripts/run-v2-daily.mjs',import.meta.url),'utf8');
  assert.match(source,/V2 daily execute window is closed/);assert.match(source,/migration-\[A-Za-z0-9/);assert.match(source,/runCanary/);assert.match(source,/notify-canary-result/);assert.match(source,/current:'v2-worker'/);
});
