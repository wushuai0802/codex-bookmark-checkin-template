import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';

const legacyRoot = fileURLToPath(new URL('./fixtures/legacy/', import.meta.url));

test('fixed redacted legacy fixture has stable site and execution-unit counts', () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  assert.equal(snapshot.counts.logicalSites, 2);
  assert.equal(snapshot.counts.executionUnits, 3);
  assert.equal(new Set(snapshot.tasks.map((task) => task.taskId)).size, 3);
  assert.equal(new Set(snapshot.tasks.map((task) => task.planUnitId)).size, 3);
  assert.equal(new Set(snapshot.receipts.map((receipt) => receipt.taskId)).size, 3);
  assert.equal(snapshot.tasks.filter((task) => task.origin === 'https://agent.example').length, 2);
  assert.equal(snapshot.tasks.every((task) => task.executionOwner === 'legacy-checkin'), true);
  assert.equal(snapshot.tasks.every((task) => task.executionMode === 'observe_only'), true);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /"(password|passwd|token|cookie|secret|authorization|accountId|accountLabel|userDataDir|profilePath|dpapi)"\s*:/i);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\Users\\\\/i);
});
