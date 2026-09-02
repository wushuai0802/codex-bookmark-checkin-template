import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSnapshot } from '../src/bridge.mjs';
import {
  acceptIdempotentReceipt, createLease, createNotificationOutboxItem, createReceipt,
  evaluateCandidateDispatch, idempotencyKey, leaseActive, validateWorkerCapability
} from '../src/candidate-protocol.mjs';

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
});

test('candidate gate allows dry-run only and blocks execute before cutover', { skip: !fs.existsSync(legacyRoot) }, () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const candidateSnapshot = structuredClone(snapshot);
  candidateSnapshot.health.freshness.fresh = true;
  const task = candidateSnapshot.tasks.find((candidate) => !['signed', 'already_signed'].includes(candidate.observedStatus));
  const dryRun = evaluateCandidateDispatch({ snapshot: candidateSnapshot, taskId: task.taskId, worker: worker(task.origin), requestedMode: 'dry_run', now: '2026-09-02T12:05:00.000Z' });
  assert.equal(dryRun.decision, 'dry_run');
  assert.equal(dryRun.executable, false);
  const execute = evaluateCandidateDispatch({ snapshot: candidateSnapshot, taskId: task.taskId, worker: worker(task.origin), requestedMode: 'execute', now: '2026-09-02T12:05:00.000Z' });
  assert.equal(execute.decision, 'deny');
  assert.match(execute.reasons.join(','), /candidate_execution_disabled/);
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
