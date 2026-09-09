import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('one-time canary task is interactive, bounded and account-scoped',()=>{
  const source=fs.readFileSync(new URL('../scripts/install-v2-canary-task.ps1',import.meta.url),'utf8');
  assert.match(source,/LogonType Interactive/);assert.match(source,/RunLevel Limited/);assert.match(source,/ExecutionTimeLimit/);assert.match(source,/--account-key/);assert.match(source,/Existing task .*not owned/);
  assert.match(source,/ShouldProcess\(\$TaskName,'Replace existing V2 canary task'\)/);
});
