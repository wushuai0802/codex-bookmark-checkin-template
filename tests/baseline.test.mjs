import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from '../src/bridge.mjs';

const legacyRoot = 'D:\\AIWorkspace\\bots\\chrome-daily-checkin';

test('current legacy baseline is 17 logical sites and 21 execution units', { skip: !fs.existsSync(legacyRoot) }, () => {
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T12:00:00.000Z' });
  assert.equal(snapshot.counts.logicalSites, 17);
  assert.equal(snapshot.counts.executionUnits, 21);
  assert.equal(new Set(snapshot.tasks.map((task) => task.taskId)).size, 21);
  assert.equal(new Set(snapshot.receipts.map((receipt) => receipt.taskId)).size, 21);
  assert.equal(snapshot.tasks.filter((task) => task.origin === 'https://agentrouter.org').length, 5);
  assert.equal(snapshot.tasks.every((task) => task.executionOwner === 'legacy-checkin'), true);
  assert.equal(snapshot.tasks.every((task) => task.executionMode === 'observe_only'), true);
  assert.equal(snapshot.logicalSites.find((site) => site.origin === 'https://new-api.abrdns.com').logicalGroup, 'abrdns-welfare');
  assert.equal(snapshot.logicalSites.filter((site) => site.credentialGroup === 'linuxdo-shared').length, 3);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /"(password|passwd|token|cookie|secret|authorization|accountId|accountLabel|userDataDir|profilePath|dpapi)"\s*:/i);
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\Users\\\\/i);
});
