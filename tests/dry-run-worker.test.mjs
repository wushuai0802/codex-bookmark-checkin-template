import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { taskIdentity, planHash } from '../src/contracts.mjs';
import { runDryWorker } from '../src/dry-run-worker.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dry-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = new Date().toISOString();
  const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const task = { ...taskIdentity({ businessDate, logicalSiteKey: 'https://safe.example', accountKey: 'primary' }), businessDate, logicalSiteKey: 'https://safe.example', accountKey: 'primary', origin: 'https://safe.example', actionType: 'checkin', scheduleOccurrence: 'daily', executionOwner: 'legacy-checkin', observedStatus: 'failed' };
  delete task.tuple;
  return { dir, now, mode: 'dry_run', stateFile: path.join(dir, 'state.json'), legacyRoot: path.join(dir, 'legacy'), worker: { workerId: 'worker_dry_windows', platform: 'windows', capabilities: ['browser_checkin'], allowedOrigins: [task.origin], executionModes: ['dry_run'], profileIsolation: true, heartbeatAt: now }, snapshot: { mode: 'shadow_read_only', generatedAt: now, businessDate, tasks: [task], planHash: planHash([task]), health: { healthy: true, sourceCheckedAt: now, freshness: { fresh: true } } } };
}

test('real one-shot worker persists a dry run and deduplicates across process restart', t => {
  const f = fixture(t);
  const snapshotFile = path.join(f.dir, 'snapshot.json'), workerFile = path.join(f.dir, 'worker.json');
  fs.writeFileSync(snapshotFile, JSON.stringify(f.snapshot)); fs.writeFileSync(workerFile, JSON.stringify(f.worker));
  const script = new URL('../src/dry-run-worker.mjs', import.meta.url);
  const invoke = () => JSON.parse(execFileSync(process.execPath, [script.pathname.replace(/^\/([A-Z]:)/, '$1'), '--snapshot', snapshotFile, '--worker', workerFile, '--state', f.stateFile, '--legacy-root', f.legacyRoot], { encoding: 'utf8', windowsHide: true }));
  assert.equal(invoke().outcomes[0].status, 'dry_run_complete');
  const again = invoke(); assert.equal(again.outcomes[0].status, 'duplicate'); assert.equal(again.browserActions, 0);
});

test('interruption, offline and timeout never replay a prepared task', t => {
  for (const fault of ['after_prepare', 'offline', 'timeout']) {
    const f = fixture(t);
    if (fault === 'after_prepare') assert.throws(() => runDryWorker({ ...f, fault }), /interruption/);
    else runDryWorker({ ...f, fault });
    assert.equal(runDryWorker(f).outcomes[0].status, 'interrupted_requires_review');
    assert.equal(fs.existsSync(f.stateFile + '.lock'), false);
  }
});

test('worker refuses execute, legacy writes, concurrent claim, stale input and switched binding', t => {
  const f = fixture(t);
  assert.throws(() => runDryWorker({ ...f, mode: 'execute' }), /only supports/);
  assert.throws(() => runDryWorker({ ...f, stateFile: path.join(f.legacyRoot, 'state.json') }), /legacy root/);
  fs.writeFileSync(f.stateFile + '.lock', '0'); assert.equal(runDryWorker(f).busy, true); fs.rmSync(f.stateFile + '.lock');
  assert.equal(runDryWorker({ ...f, now: new Date(Date.now() + 48 * 3_600_000).toISOString() }).outcomes[0].status, 'denied');
  runDryWorker(f);
  f.worker.workerId = 'worker_other_windows';
  assert.equal(runDryWorker(f).outcomes[0].status, 'binding_conflict');
});
