import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('NAS deployment preserves data/secrets and performs backup before rebuild',()=>{
  const source=fs.readFileSync(new URL('../scripts/deploy-nas-code.ps1',import.meta.url),'utf8');
  assert.match(source,/tar -czf .*src public package\.json/);
  assert.match(source,/compose\.worker\.yaml/);assert.match(source,/docker compose/);assert.match(source,/State\.Health\.Status/);
  assert.doesNotMatch(source,/rm -rf '\$RemoteRoot\/nas-data/);assert.doesNotMatch(source,/rm -rf '\$RemoteRoot\/secrets/);
});
