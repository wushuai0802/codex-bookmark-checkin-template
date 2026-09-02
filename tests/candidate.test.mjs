import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSnapshot } from '../src/bridge.mjs';
import {
  acceptIdempotentReceipt, createLease, createNotificationOutboxItem, createReceipt,
  evaluateCandidateDispatch, idempotencyKey, leaseActive, validateWorkerCapability
} from '../src/candidate-protocol.mjs';
import { simulateCandidateRun } from '../src/candidate-simulator.mjs';
import { planHash, taskIdentity } from '../src/contracts.mjs';

const legacyRoot = 'D:\\AIWorkspace\\bots\\chrome-daily-checkin';

function worker(origin = 'https://agentrouter.org') {
  return {
    schemaVersion: 1,
    workerId: 'worker_local001',
    platform: 'windows',
    capabilities: ['browser_checkin', 'page_evidence'],
    allowedOrigins: [origin],
    executionModes: ['dry_run'],
    profileIsolation: true,
    heartbeatAt: '2026-09-02T12:00:00.000Z'
  };
}

function candidateSnapshot({ fresh = true } = {}) {
  const businessDate = '2026-09-02';
  const task = (origin, accountKey, observedStatus) => {
    const identity = taskIdentity({ businessDate, logicalSiteKey: origin, accountKey });
    return {
      schemaVersion: 1,
      taskId: identity.taskId,
      businessDate,
      logicalSiteKey: origin,
      logicalGroup: null,
      origin,
      accountKey,
      accountRef: `acct_${accountKey}`,
      actionType: 'checkin',
      scheduleOccurrence: 'daily',
      executionOwner: 'legacy-checkin',
      executionMode: 'observe_only',
      observedStatus
    };
  };
  const tasks = [
    task('https://agentrouter.org', 'agentrouter-primary', 'failed'),
    task('https://agentrouter.org', 'agentrouter-complete', 'already_signed'),
    task('https://unlisted.example', 'unlisted', 'failed')
  ];
  return {
    schemaVersion: 1,
    snapshotId: 'snap_test',
    generatedAt: '2026-09-02T12:00:00.000Z',
    businessDate,
    mode: 'shadow_read_only',
    planHash: planHash(tasks),
    tasks,
    health: { freshness: { fresh } }
  };
}

test('idempotency key is stable for one task and business date', () => {
  const taskId = 'task_0123456789abcdef01234567';
  assert.equal(idempotencyKey({ taskId, businessDate: '2026-09-02' }), idempotencyKey({ taskId, businessDate: '2026-09-02' }));
  assert.notEqual(idempotencyKey({ taskId, businessDate: '2026-09-02' }), idempotencyKey({ taskId, businessDate: '2026-09-03' }));
});

test('lease is bounded, single-use, and expires deterministically', () => {
  const lease = createLease({ taskId: 'task_0123456789abcdef01234567', planHash: 'a'.repeat(64), owner: 'worker_local001', issuedAt: '2026-09-02T12:00:00.000Z', ttlSeconds: 60 });
  assert.match(lease.leaseId, /^lease_[a-f0-9]{24}$/);
  assert.equal(lease.singleUse, true);
  assert.equal(leaseActive(lease, { now: '2026-09-02T12:00:30.000Z' }), true);
  assert.equal(leaseActive(lease, { now: '2026-09-02T12:01:00.000Z' }), false);
  assert.throws(() => createLease({ taskId: lease.taskId, planHash: lease.planHash, owner: lease.owner, ttlSeconds: 901 }), /ttlSeconds/);
});

test('worker capability requires isolation, fresh heartbeat, and unique allowlist', () => {
  assert.equal(validateWorkerCapability(worker(), { now: '2026-09-02T12:05:00.000Z' }).valid, true);
  assert.equal(validateWorkerCapability({ ...worker(), profileIsolation: false }, { now: '2026-09-02T12:05:00.000Z' }).valid, false);
  assert.equal(validateWorkerCapability({ ...worker(), heartbeatAt: '2026-09-02T11:00:00.000Z' }, { now: '2026-09-02T12:05:00.000Z' }).valid, false);
  assert.equal(validateWorkerCapability({ ...worker(), executionModes: ['shadow_read_only'] }, { now: '2026-09-02T12:05:00.000Z' }).valid, false);
  assert.equal(validateWorkerCapability({ ...worker(), allowedOrigins: ['https://agentrouter.org/path'] }, { now: '2026-09-02T12:05:00.000Z' }).valid, false);
});

test('candidate gate allows dry-run only and blocks execute before cutover', { skip: !fs.existsSync(legacyRoot) }, () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const candidateSnapshot = structuredClone(snapshot);
  candidateSnapshot.health.freshness.fresh = true;
  const task = candidateSnapshot.tasks.find((candidate) => !['signed', 'already_signed'].includes(candidate.observedStatus));
  const dryRun = evaluateCandidateDispatch({ snapshot: candidateSnapshot, taskId: task.taskId, worker: worker(task.origin), requestedMode: 'dry_run', now: '2026-09-02T12:05:00.000Z' });
  assert.equal(dryRun.decision, 'dry_run');
  assert.equal(dryRun.executable, false);
  const unsupported = evaluateCandidateDispatch({ snapshot: candidateSnapshot, taskId: task.taskId, worker: { ...worker(task.origin), executionModes: ['execute'] }, requestedMode: 'dry_run', now: '2026-09-02T12:05:00.000Z' });
  assert.equal(unsupported.decision, 'deny');
  assert.match(unsupported.reasons.join(','), /worker_mode_not_supported/);
  const execute = evaluateCandidateDispatch({ snapshot: candidateSnapshot, taskId: task.taskId, worker: worker(task.origin), requestedMode: 'execute', now: '2026-09-02T12:05:00.000Z' });
  assert.equal(execute.decision, 'deny');
  assert.match(execute.reasons.join(','), /candidate_execution_disabled/);
});

test('candidate simulator denies every task when source health is stale', () => {
  const snapshot = candidateSnapshot({ fresh: false });
  const result = simulateCandidateRun({ snapshot, worker: worker(), now: '2026-09-02T12:05:00.000Z' });
  assert.equal(result.executeEnabled, false);
  assert.deepEqual(result.simulation, { leaseSimulation: true, browserActionPerformed: false });
  assert.equal(result.summary.taskCount, snapshot.tasks.length);
  assert.equal(result.summary.dryRunCount, 0);
  assert.equal(result.summary.deniedCount, snapshot.tasks.length);
  assert.equal(result.receipts.length, 0);
  assert.equal(result.decisions.every((decision) => decision.reasons.includes('health_stale')), true);
});

test('candidate simulator produces only deferred dry-run receipts for allowed tasks', () => {
  const snapshot = candidateSnapshot({ fresh: true });
  const result = simulateCandidateRun({ snapshot, worker: worker(), now: '2026-09-02T12:05:00.000Z' });
  assert.equal(result.executeEnabled, false);
  assert.equal(result.summary.dryRunCount, 1);
  assert.equal(result.summary.deniedCount, 2);
  assert.equal(result.summary.notificationCount, result.summary.dryRunCount);
  assert.equal(result.receipts.length, result.summary.dryRunCount);
  assert.equal(result.receipts.every((receipt) => receipt.status === 'deferred'), true);
  assert.equal(result.receipts.every((receipt) => receipt.executionMode === 'dry_run'), true);
  assert.equal(result.receipts.every((receipt) => receipt.evidence.authoritative === false && receipt.evidence.redacted === true), true);
  assert.equal(result.envelopes.length, result.summary.dryRunCount);
  assert.equal(result.envelopes.every((envelope) => envelope.mode === 'dry_run' && !('leaseSimulation' in envelope)), true);
  assert.equal(result.decisions.filter((decision) => decision.decision === 'dry_run').length, result.summary.dryRunCount);
  assert.equal(result.decisions.some((decision) => decision.reasons.includes('legacy_result_terminal')), true);
  assert.equal(result.decisions.some((decision) => decision.reasons.includes('origin_not_allowlisted')), true);
  assert.doesNotMatch(JSON.stringify(result), /"(password|cookie|token|secret|profilePath|userDataDir|accountId|accountLabel)"\s*:/i);
});

test('receipts require redacted evidence and duplicate outcomes are idempotent', () => {
  const base = { taskId: 'task_0123456789abcdef01234567', leaseId: 'lease_0123456789abcdef01234567', workerId: 'worker_local001', businessDate: '2026-09-02', status: 'signed', observedAt: '2026-09-02T12:01:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '签到成功', redacted: true }, executionMode: 'dry_run' };
  const first = createReceipt(base);
  const duplicate = createReceipt({ ...base, observedAt: '2026-09-02T12:02:00.000Z' });
  assert.equal(acceptIdempotentReceipt(null, first).accepted, true);
  assert.equal(acceptIdempotentReceipt(first, duplicate).duplicate, true);
  assert.equal(acceptIdempotentReceipt(first, createReceipt({ ...base, status: 'failed' })).accepted, false);
  assert.throws(() => createReceipt({ ...base, evidence: { ...base.evidence, redacted: false } }), /redacted/);
  const notice = createNotificationOutboxItem({ receipt: first, createdAt: '2026-09-02T12:03:00.000Z' });
  assert.match(notice.dedupeKey, /^notice_[a-f0-9]{24}$/);
  assert.equal(notice.state, 'pending');
});
