import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const scanner = fileURLToPath(new URL('../scripts/Scan-PublicSafety.ps1', import.meta.url));
test('public safety detects raw and escaped user, workspace and archive paths without echoing them', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-path-scan-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const separator = String.fromCharCode(92);
  const values = [['C:', 'Users', 'example-user', 'profile'], ['D:', 'AIWorkspace', 'example-project'], ['E:', 'AIArchive', 'example-deliverable']]
    .map(parts => parts.join(separator));
  fs.writeFileSync(path.join(root, 'paths.txt'), values.flatMap(value => [value, JSON.stringify(value), value.replaceAll(separator, '/')]).join('\n'));
  fs.writeFileSync(path.join(root, 'placeholders.txt'), '<execution-root>\n<observation-root>\n<operations-root>');
  const result = spawnSync(process.platform === 'win32' ? 'pwsh.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', scanner, '-Root', root], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.findings.length, 9);
  assert.deepEqual([...new Set(report.findings.map(item => item.rule))], ['Windows user path', 'Private workspace path', 'Private archive path']);
  assert.ok(report.findings.every(item => item.file === 'paths.txt'));
  for (const value of values) assert.equal((result.stdout + result.stderr).includes(value), false);
});
