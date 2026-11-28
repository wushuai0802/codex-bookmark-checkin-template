import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planRelease, applyRelease, auditRelease, rollbackRelease } from '../../tools/release-lib.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const invokeScript = path.join(project, 'observation/scripts/Invoke-DryWorkerIfDue.ps1');
const runScript = path.join(project, 'observation/scripts/Run-DryWorker.ps1');

test('managed dry-worker PowerShell scripts parse cleanly and contain no hardcoded local paths', () => {
  for (const file of [invokeScript, runScript]) {
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /[A-Za-z]:\\|\/mnt\/[a-z]\//);
    assert.match(content, /AbandonedMutexException/);
  }
  assert.match(fs.readFileSync(runScript, 'utf8'), /ZeroFreeBSTR/);

  const checkCommand = [
    '$errors = $null;',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${invokeScript.replaceAll("'", "''")}', [ref]$null, [ref]$errors);`,
    'if ($errors.Count -gt 0) { throw ($errors | Out-String) }',
    '$errors = $null;',
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${runScript.replaceAll("'", "''")}', [ref]$null, [ref]$errors);`,
    'if ($errors.Count -gt 0) { throw ($errors | Out-String) }',
    'Write-Output "PARSE_OK"',
  ].join(' ');
  const stdout = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', checkCommand], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.match(stdout, /PARSE_OK/);
});

test('Invoke-DryWorkerIfDue exits cleanly when disabled, non-dry-run, or within 15-minute cooldown', (t) => {
  const opsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-worker-ops-'));
  t.after(() => fs.rmSync(opsRoot, { recursive: true, force: true }));
  const runDispatch = () => execFileSync('pwsh.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', invokeScript, '-OpsRoot', opsRoot,
  ], { encoding: 'utf8', windowsHide: true });

  // Missing config -> silent exit 0
  assert.equal(runDispatch().trim(), '');

  fs.mkdirSync(path.join(opsRoot, 'config'), { recursive: true });
  fs.mkdirSync(path.join(opsRoot, 'outputs'), { recursive: true });

  // Disabled -> silent exit 0
  fs.writeFileSync(path.join(opsRoot, 'config/worker.local.json'), JSON.stringify({ mode: 'dry_run', enabled: false }));
  assert.equal(runDispatch().trim(), '');

  // Non dry_run -> silent exit 0
  fs.writeFileSync(path.join(opsRoot, 'config/worker.local.json'), JSON.stringify({ mode: 'disabled', enabled: true }));
  assert.equal(runDispatch().trim(), '');

  // Cooldown active -> silent exit 0 without spawning wscript/Run-DryWorker
  fs.writeFileSync(path.join(opsRoot, 'config/worker.local.json'), JSON.stringify({ mode: 'dry_run', enabled: true }));
  fs.writeFileSync(path.join(opsRoot, 'outputs/worker-last-attempt.json'), JSON.stringify({ at: new Date().toISOString(), exitCode: 0 }));
  assert.equal(runDispatch().trim(), '');
});

test('release planning ships both dry-worker scripts to observation and operations roots', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dry-worker-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const executionRoot = path.join(root, 'execution');
  const observationRoot = path.join(root, 'observation');
  const opsRoot = path.join(root, 'operations');
  for (const dir of [
    path.join(source, 'execution/scripts'),
    path.join(source, 'observation/scripts'),
    path.join(executionRoot, 'scripts'),
    path.join(observationRoot, 'scripts'),
    path.join(opsRoot, 'scripts'),
  ]) fs.mkdirSync(dir, { recursive: true });

  for (const [relative, content] of [
    ['observation/scripts/Sync-NasShadow.ps1', 'sync'],
    ['observation/scripts/Start-NasShadowScheduler.ps1', 'scheduler'],
    ['observation/scripts/Sync-OperationsSupport.ps1', 'support'],
    ['observation/scripts/Sync-Transport.ps1', 'transport'],
    ['execution/scripts/Run-HiddenPowerShell.vbs', 'launcher'],
    ['observation/scripts/Invoke-DryWorkerIfDue.ps1', fs.readFileSync(invokeScript, 'utf8')],
    ['observation/scripts/Run-DryWorker.ps1', fs.readFileSync(runScript, 'utf8')],
  ]) fs.writeFileSync(path.join(source, relative), content);

  const plan = planRelease({
    source,
    executionRoot,
    observationRoot,
    opsRoot,
    files: [
      'observation/scripts/Invoke-DryWorkerIfDue.ps1',
      'observation/scripts/Run-DryWorker.ps1',
    ],
    revision: 'a'.repeat(40),
    version: '1.1.87',
  });
  const managedFiles = plan.files.map(entry => entry.file);
  assert.ok(managedFiles.includes('observation/scripts/Invoke-DryWorkerIfDue.ps1'));
  assert.ok(managedFiles.includes('observation/scripts/Run-DryWorker.ps1'));
  assert.ok(managedFiles.includes('operations/scripts/Invoke-DryWorkerIfDue.ps1'));
  assert.ok(managedFiles.includes('operations/scripts/Run-DryWorker.ps1'));

  const lock = async (_plan, run) => run();
  const out = await applyRelease(plan, { backupRoot: path.join(root, 'backups'), lock });
  assert.equal(auditRelease(plan).drift.length, 0);
  assert.equal(fs.readFileSync(path.join(opsRoot, 'scripts/Invoke-DryWorkerIfDue.ps1'), 'utf8'), fs.readFileSync(invokeScript, 'utf8'));
  assert.equal(fs.readFileSync(path.join(opsRoot, 'scripts/Run-DryWorker.ps1'), 'utf8'), fs.readFileSync(runScript, 'utf8'));
  await rollbackRelease(out.backup, { lock });
  assert.equal(fs.existsSync(path.join(opsRoot, 'scripts/Invoke-DryWorkerIfDue.ps1')), false);
});
