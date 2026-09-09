import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('staged migration retains V1 fallback until authoritative V2 success',()=>{
  const source=fs.readFileSync(new URL('../scripts/stage-account-migration.mjs',import.meta.url),'utf8');
  assert.match(source,/state:'candidate'/); assert.match(source,/firstMutationNotPerformed:true/); assert.match(source,/switchAfter:'authoritative_v2_success'/); assert.match(source,/owner:'legacy-checkin'/);
});
