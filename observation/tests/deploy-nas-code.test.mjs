import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

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

test('scoped NAS deployment rejects traversal, wildcards, duplicates and missing files before export', () => {
  const script = new URL('../scripts/deploy-nas-code.ps1', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
  for (const paths of [
    ['src/../secrets/token'],
    ['src/*.mjs'],
    ['src/attention-controls.mjs', 'src/attention-controls.mjs'],
    ['src/does-not-exist.mjs'],
  ]) {
    const list = paths.map(value => `'${value}'`).join(',');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& '${script}' -IncludePaths @(${list}) -WhatIf`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, `unexpected acceptance of ${paths.join(', ')}`);
    assert.match(result.stderr, /IncludePaths/);
    assert.doesNotMatch(result.stdout, /NAS bundle exported|NAS V2 code deployed/);
  }
});

test('scoped NAS deployment archives and installs only selected files with rollback', () => {
  const source = fs.readFileSync(new URL('../scripts/deploy-nas-code.ps1', import.meta.url), 'utf8');
  assert.match(source, /if\(\$scopedPaths\.Count -gt 0\)\{\$items=\$scopedPaths\}/);
  assert.match(source, /sudo -n test ! -L/);
  assert.match(source, /install -m 0644 '\$stage\/\$path' '\$RemoteRoot\/\$path'/);
  assert.match(source, /\$removeSelected=.*sudo -n rm -f/);
  assert.match(source, /\$removeSelected; sudo -n tar -xzf/);
  assert.match(source, /tar -xzf '\$remoteBackup' -C '\$RemoteRoot'/);
});
