import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('canary runner source enforces explicit execute and V1 drain gates',()=>{
  const source=fs.readFileSync(new URL('../scripts/run-v2-canary.mjs',import.meta.url),'utf8');
  assert.match(source,/task\.executionEnabled!==false/);
  assert.match(source,/v1MustBeStoppedBeforeMutation/);
  assert.match(source,/args\.has\('--execute'\)/);
  assert.match(source,/windowMode:'offscreen'/);
});
