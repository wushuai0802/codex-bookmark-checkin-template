import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { appendLedgerRecord, compareSnapshots, createLedgerRecord, readLedger } from '../src/shadow-ledger.mjs';
import { evaluateShadowGate } from '../src/schedule-gate.mjs';
import { planHash, taskIdentity } from '../src/contracts.mjs';
import { evaluateShadowHistory } from '../src/shadow-acceptance.mjs';

const legacyRoot = fileURLToPath(new URL('./fixtures/legacy/', import.meta.url));

test('same plan ignores status-only changes but records status delta', () => {
  const first = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const second = structuredClone(first);
  second.generatedAt = '2026-09-02T12:10:00.000Z';
  second.snapshotId = 'snap_000000000000000000000000';
  const nextStatus = first.tasks[0].observedStatus === 'signed' ? 'already_signed' : 'signed';
  second.receipts[0].status = nextStatus;
  second.tasks[0].observedStatus = nextStatus;
  const diff = compareSnapshots(first, second);
  assert.equal(diff.classification, 'same_plan');
  assert.equal(diff.samePlan, true);
  assert.equal(diff.statusChanges.length, 1);
  assert.equal(diff.addedTaskIds.length, 0);
});

test('calendar rollover keeps one stable plan while task instances change', () => {
  const first = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const second = structuredClone(first);
  second.businessDate = '2026-09-03';
  for (const task of second.tasks) {
    task.businessDate = second.businessDate;
    const identity = taskIdentity(task);
    const receipt = second.receipts.find((candidate) => candidate.taskId === task.taskId);
    if (receipt) receipt.taskId = identity.taskId;
    task.taskId = identity.taskId;
    task.planUnitId = identity.planUnitId;
  }
  second.planHash = planHash(second.tasks);
  assert.equal(second.planHash, first.planHash);
  assert.equal(second.tasks.some((task, index) => task.taskId === first.tasks[index].taskId), false);
  const diff = compareSnapshots(first, second);
  assert.equal(diff.classification, 'same_plan');
  assert.equal(diff.addedTaskIds.length, 0);
  assert.equal(diff.removedTaskIds.length, 0);
});

test('plan drift and invalid ownership are detected', () => {
  const first = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const changed = structuredClone(first);
  changed.tasks = changed.tasks.slice(1);
  changed.planHash = planHash(changed.tasks);
  const diff = compareSnapshots(first, changed);
  assert.equal(diff.classification, 'plan_changed');
  assert.equal(diff.removedTaskIds.length, 1);
  const ownerChanged = structuredClone(first);
  ownerChanged.tasks[0].executionOwner = 'unexpected-worker';
  ownerChanged.planHash = planHash(ownerChanged.tasks);
  assert.equal(compareSnapshots(first, ownerChanged).classification, 'invalid');
  const duplicate = structuredClone(first);
  duplicate.tasks.push({ ...duplicate.tasks[0], executionOwner: 'unexpected-worker' });
  assert.throws(() => compareSnapshots(first, duplicate), /duplicate plan unit id/);
});

test('shadow gate never grants a lease or executable decision', () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const task = snapshot.tasks.find((candidate) => !['signed', 'already_signed'].includes(candidate.observedStatus));
  const denied = evaluateShadowGate({ snapshot, taskId: task.taskId, requestedMode: 'execute', minHealthFresh: false });
  assert.equal(denied.executable, false);
  assert.equal(denied.leaseGranted, false);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reasons.join(','), /alpha_execution_disabled/);
  const missing = evaluateShadowGate({ snapshot, taskId: 'task_missing', minHealthFresh: false });
  assert.equal(missing.decision, 'deny');
  assert.equal(missing.executable, false);
  const observeOnly = structuredClone(snapshot);
  observeOnly.health.freshness.fresh = true;
  observeOnly.tasks.find(t => t.taskId === task.taskId).observedStatus = 'failed';
  const observed = evaluateShadowGate({ snapshot: observeOnly, taskId: task.taskId, minHealthFresh: true, now: '2026-09-02T12:05:00Z' });
  assert.equal(observed.decision, 'observe');
  assert.equal(observed.executable, false);
  assert.equal(observed.leaseGranted, false);
});

test('ledger is append-only, redacted, and outside legacy root', () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const record = createLedgerRecord(snapshot, { recordedAt: '2026-09-02T12:01:00.000Z' });
  assert.equal(record.mode, 'shadow_read_only');
  assert.equal(record.counts.executionUnits, 3);
  const ledger = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-v2-ledger-')), 'ledger.jsonl');
  appendLedgerRecord(ledger, record, { legacyRoot });
  appendLedgerRecord(ledger, { ...record, recordId: 'ledger_111111111111111111111111', recordedAt: '2026-09-02T12:02:00.000Z' }, { legacyRoot });
  assert.equal(readLedger(ledger).length, 2);
  appendLedgerRecord(ledger, record, { legacyRoot });
  assert.equal(readLedger(ledger).length, 2);
  assert.throws(() => appendLedgerRecord(path.join(legacyRoot, 'data', 'v2-ledger.jsonl'), record, { legacyRoot }), /legacy project/);
});

function historyRecord(businessDate, { fresh = true, recordId = null, ownerConflicts = [] } = {}) {
  return {
    schemaVersion: 1,
    recordId: recordId ?? `ledger_${businessDate.replaceAll('-', '')}0000000000000000`,
    recordedAt: `${businessDate}T12:00:00.000Z`,
    snapshotId: 'snap_0123456789abcdef01234567',
    businessDate,
    planHash: 'a'.repeat(64),
    sourceRunId: 'run-1',
    mode: 'shadow_read_only',
    counts: { logicalSites: 1, executionUnits: 1, status: { signed: 1 }, bookmarkSourceCounts: {} },
    drift: { classification: 'same_plan', hashValid: true, ownerConflicts, addedTaskIds: [], removedTaskIds: [], changedTaskIds: [], statusChanges: [] },
    health: { healthy: true, sourceCheckedAt: `${businessDate}T12:00:00.000Z`, freshness: { fresh, maxAgeHours: 26 } }
  };
}

test('shadow history accepts seven consecutive fresh records', () => {
  const records = Array.from({ length: 7 }, (_, index) => historyRecord(`2026-09-${String(index + 1).padStart(2, '0')}`));
  const result = evaluateShadowHistory(records, { now: '2026-09-07T14:00:00Z' });
  assert.equal(result.accepted, true);
  assert.equal(result.longestConsecutiveDays, 7);
  assert.equal(result.freshRecordCount, 7);
  assert.deepEqual(result.reasons, []);
});

test('shadow history blocks gaps, stale health, conflicts, and duplicate records', () => {
  const records = [
    historyRecord('2026-09-01', { recordId: 'ledger_111111111111111111111111' }),
    historyRecord('2026-09-03', { fresh: false, recordId: 'ledger_222222222222222222222222', ownerConflicts: [{ taskId: 'task_1', owners: ['legacy-checkin', 'v2-worker'] }] }),
    historyRecord('2026-09-03', { recordId: 'ledger_111111111111111111111111' })
  ];
  const result = evaluateShadowHistory(records, { now: '2026-09-03T14:00:00Z' });
  assert.equal(result.accepted, false);
  assert.equal(result.longestConsecutiveDays, 1);
  assert.equal(result.invalidRecordCount, 2);
  assert.equal(result.ownerConflictRecords, 1);
  assert.equal(result.staleRecordCount, 1);
  assert.match(result.reasons.join(','), /insufficient_consecutive_days/);
  // All history remains diagnostic; the latest duplicate is the selected day.
  assert.equal(result.staleRecordCount, 1);
});

test('shadow history rejects a fresh but unhealthy source report', () => {
  const record = historyRecord('2026-09-01');
  record.health.healthy = false;
  const result = evaluateShadowHistory([record], { minConsecutiveDays: 1 });
  assert.equal(result.accepted, false);
  assert.equal(result.unhealthyRecordCount, 1);
  assert.equal(result.reasons.includes('health_not_healthy'), true);
});

test('shadow history rejects impossible calendar dates', () => {
  const result = evaluateShadowHistory([historyRecord('2026-02-30')], { minConsecutiveDays: 1 });
  assert.equal(result.accepted, false);
  assert.equal(result.invalidRecordCount, 1);
  assert.equal(result.reasons.includes('invalid_records'), true);
});

test('an obsolete successful week is not recent acceptance', () => {
  const records = Array.from({ length: 7 }, (_, i) => historyRecord(`2020-01-0${i + 1}`));
  const result = evaluateShadowHistory(records, { now: '2026-09-06T12:00:00Z' });
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes('history_not_current'));
});

test('recovered recent days can pass without rewriting earlier failed audit history', () => {
  const records = [historyRecord('2020-01-01', { fresh: false }), ...Array.from({ length: 7 }, (_, i) => historyRecord(`2026-09-0${i + 1}`))];
  const result = evaluateShadowHistory(records, { now: '2026-09-07T14:00:00Z' });
  assert.equal(result.accepted, true);
  assert.equal(result.staleRecordCount, 1);
  assert.equal(result.eligibleRecentDays, 7);
});

test('a fresh boolean cannot substitute for source time and stable plan', () => {
  const r = historyRecord('2026-09-06');
  delete r.health.sourceCheckedAt;
  assert.equal(evaluateShadowHistory([r], { minConsecutiveDays: 1, now: '2026-09-06T14:00:00Z' }).accepted, false);
  const old = buildSnapshot({ legacyRoot }); old.planHash = 'a'.repeat(64);
  assert.throws(() => createLedgerRecord(buildSnapshot({ legacyRoot }), { previousSnapshot: old }), /invalid previous/);
});
