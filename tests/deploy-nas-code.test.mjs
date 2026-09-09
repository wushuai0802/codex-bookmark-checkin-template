import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('NAS deployment preserves data/secrets and performs backup before rebuild',()=>{
  const source=fs.readFileSync(new URL('../scripts/deploy-nas-code.ps1',import.meta.url),'utf8');
  assert.match(source,/backupItems=@\('src','public','package\.json'/);
  assert.match(source,/compose\.worker\.yaml/);assert.match(source,/docker compose/);assert.match(source,/State\.Health\.Status/);
  assert.match(source,/RedirectStandardInput/);
  assert.match(source,/StandardInput\.BaseStream/);
  assert.match(source,/tar -xzf - -C/);
  assert.match(source,/-T.*BatchMode/);
  assert.match(source,/GetTempPath/);
  assert.match(source,/finally\s*\{/);
  assert.match(source,/rm -rf '\$stage'/);
  assert.match(source,/install -m 0644 '\$stage\/compose\.worker\.yaml'/);
  assert.match(source,/install -m 0644 '\$stage\/\.dockerignore'/);
  assert.match(source,/UseWorkerTransport/);
  assert.match(source,/BundleDir -notmatch/);
  assert.match(source,/transport-config\/worker-registry\.json/);
  assert.match(source,/transport-data/);
  assert.doesNotMatch(source,/\$scp/);
  assert.doesNotMatch(source,/Get-Command\s+scp/i);
  assert.doesNotMatch(source,/&\s*\$scp/i);
  assert.doesNotMatch(source,/scp is required/);
  assert.doesNotMatch(source,/rm -rf '\$RemoteRoot\/nas-data/);assert.doesNotMatch(source,/rm -rf '\$RemoteRoot\/secrets/);
});
