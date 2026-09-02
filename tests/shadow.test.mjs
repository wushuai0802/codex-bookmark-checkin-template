import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../src/bridge.mjs';
import { appendLedgerRecord, compareSnapshots, createLedgerRecord, readLedger } from '../src/shadow-ledger.mjs';
import { evaluateShadowGate } from '../src/schedule-gate.mjs';
import { planHash } from '../src/contracts.mjs';
import { evaluateShadowHistory } from '../src/shadow-acceptance.mjs';

const legacyRoot = 'D:\\AIWorkspace\\bots\\chrome-daily-checkin';

test('same plan ignores status-only changes but records status delta', { skip: !fs.existsSync(legacyRoot) }, () => {
  const first = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const second = structuredClone(first);
  second.generatedAt = '2026-09-02T12:10:00.000Z';
  second.snapshotId = 'snap_000000000000000000000000';
  second.receipts[0].status = 'already_signed';
  second.tasks[0].observedStatus = 'already_signed';
  const diff = compareSnapshots(first, second);
  assert.equal(diff.classification, 'same_plan');
  assert.equal(diff.samePlan, true);
  assert.equal(diff.statusChanges.length, 1);
  assert.equal(diff.addedTaskIds.length, 0);
});

test('plan drift and invalid ownership are detected', { skip: !fs.existsSync(legacyRoot) }, () => {
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
  assert.throws(() => compareSnapshots(first, duplicate), /duplicate task id/);
});

test('shadow gate never grants a lease or executable decision', { skip: !fs.existsSync(legacyRoot) }, () => {
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
  const observed = evaluateShadowGate({ snapshot: observeOnly, taskId: task.taskId, minHealthFresh: true });
  assert.equal(observed.decision, 'observe');
  assert.equal(observed.executable, false);
  assert.equal(observed.leaseGranted, false);
});

test('ledger is append-only, redacted, and outside legacy root', { skip: !fs.existsSync(legacyRoot) }, () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  const record = createLedgerRecord(snapshot, { recordedAt: '2026-09-02T12:01:00.000Z' });
  assert.equal(record.mode, 'shadow_read_only');
  assert.equal(record.counts.executionUnits, 21);
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
    health: { freshness: { fresh } }
  };
}

test('shadow history accepts seven consecutive fresh records', () => {
  const records = Array.from({ length: 7 }, (_, index) => historyRecord(`2026-09-${String(index + 1).padStart(2, '0')}`));
  const result = evaluateShadowHistory(records);
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
  const result = evaluateShadowHistory(records);
  assert.equal(result.accepted, false);
  assert.equal(result.longestConsecutiveDays, 1);
  assert.equal(result.invalidRecordCount, 2);
  assert.equal(result.ownerConflictRecords, 1);
  assert.equal(result.staleRecordCount, 1);
  assert.match(result.reasons.join(','), /insufficient_consecutive_days/);
  assert.match(result.reasons.join(','), /health_not_fresh/);
});

test('shadow history rejects impossible calendar dates', () => {
  const result = evaluateShadowHistory([historyRecord('2026-02-30')], { minConsecutiveDays: 1 });
  assert.equal(result.accepted, false);
  assert.equal(result.invalidRecordCount, 1);
  assert.equal(result.reasons.includes('invalid_records'), true);
});
