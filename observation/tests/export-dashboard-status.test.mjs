import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('dashboard status export defaults to unified execution layer',()=>{
  const source=fs.readFileSync(new URL('../scripts/export-dashboard-status.mjs',import.meta.url),'utf8');
  assert.match(source,/loadRuntimeConfig/);
  assert.match(source,/let executionEngine='v1'/);
  assert.doesNotMatch(source,/executionEngine='v2'/);
});
