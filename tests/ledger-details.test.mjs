import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { createLedgerRecord } from '../src/shadow-ledger.mjs';

test('ledger retains historical identities and results independent of current state', () => {
  const snapshot = buildSnapshot({legacyRoot:fileURLToPath(new URL('./fixtures/legacy/',import.meta.url)),generatedAt:'2026-09-02T14:00:00Z'});
  snapshot.tasks[0].identity = { username:'example-reader',userId:'12345',password:'must-not-copy' };
  const record = createLedgerRecord(snapshot);
  const savedStatus = record.taskSummaries[0].observedStatus;
  snapshot.tasks[0].identity.username = 'changed'; snapshot.tasks[0].observedStatus = 'failed';
  assert.equal(record.taskSummaries[0].identity.username,'example-reader');
  assert.equal(record.taskSummaries[0].observedStatus,savedStatus);
  assert.doesNotMatch(JSON.stringify(record),/must-not-copy/);
  assert.equal(record.taskSummaries.length,snapshot.tasks.length);
});

test('ledger identifies changed task with its status transition', () => {
  const before = buildSnapshot({legacyRoot:fileURLToPath(new URL('./fixtures/legacy/',import.meta.url)),generatedAt:'2026-09-02T14:00:00Z'});
  const after = structuredClone(before); after.tasks[0].observedStatus='failed';
  const record = createLedgerRecord(after,{previousSnapshot:before});
  const change=record.changes.find(change=>change.kind==='status');
  assert.equal(change.task.origin,after.tasks[0].origin); assert.equal(change.to,'failed');
  assert.equal(record.planHash,before.planHash);
});
