import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildSnapshot, writeSnapshot
} from '../src/bridge.mjs';
import {
  credentialGroup, logicalGroup, logicalSiteKey, planHash, taskIdentity
} from '../src/contracts.mjs';

function fixtureRoot({ healthCheckedAt = '2026-09-02T01:00:00.000Z' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'checkin-v2-fixture-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'logs', 'run-1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'scheduler-state.json'), JSON.stringify({ lastRunId: 'run-1', lastRunDate: '2026-09-02' }));
  fs.writeFileSync(path.join(root, 'data', 'last-valid-bookmark-plan.json'), JSON.stringify({
    generatedAt: '2026-09-02T01:00:00.000Z',
    sources: [{ counts: { '公益站': 2 } }],
    targets: [{ origin: 'https://agentrouter.org', accountKey:'agentrouter-245770', title: 'Agent Router', folderNames: ['公益站'] },
      { origin:'https://agentrouter.org', accountKey:'agentrouter-336634',title:'Agent second',folderNames:['公益站'] },
      { origin: 'https://new-api.abrdns.com', title: 'New API', folderNames: ['公益站'] }]
  }));
  fs.writeFileSync(path.join(root, 'data', 'site-state.json'), JSON.stringify({ updatedAt: '2026-09-02T01:01:00.000Z' }));
  fs.writeFileSync(path.join(root, 'health.json'), JSON.stringify({ healthy: true, reason: 'ok', checkedAt: healthCheckedAt, failedChecks: [] }));
  fs.writeFileSync(path.join(root, 'logs', 'run-1', 'result.json'), JSON.stringify({
    runId: 'run-1', finishedAt: '2026-09-02T01:02:00.000Z', executionComplete: true, businessComplete: true,
    results: [
      { origin: 'https://agentrouter.org/path', accountKey: 'agentrouter-245770', accountId: '245770', status: 'signed', reason: 'usage log reward $25 token=should-not-copy', evidence: { source: 'usage_log', createdAt: '2026-09-02T01:02:00.000Z' } },
      { origin: 'https://agentrouter.org', accountKey: 'agentrouter-336634', accountId: '336634', status: 'signed', reason: '每日签到成功，增加额度 123456' },
      { origin: 'https://new-api.abrdns.com', status: 'not_available', reason: 'not open' }
    ]
  }));
  return root;
}

test('task identity is stable and includes account to prevent collisions', () => {
  const a = taskIdentity({ businessDate: '2026-09-02', logicalSiteKey: 'https://agentrouter.org', accountKey: 'agentrouter-245770' });
  const b = taskIdentity({ businessDate: '2026-09-02', logicalSiteKey: 'https://agentrouter.org', accountKey: 'agentrouter-336634' });
  const tomorrow = taskIdentity({ businessDate: '2026-09-03', logicalSiteKey: 'https://agentrouter.org', accountKey: 'agentrouter-245770' });
  assert.notEqual(a.taskId, b.taskId);
  assert.equal(a.taskId, taskIdentity({ businessDate: '2026-09-02', logicalSiteKey: 'https://agentrouter.org', accountKey: 'agentrouter-245770' }).taskId);
  assert.notEqual(a.taskId, tomorrow.taskId);
  assert.equal(a.planUnitId, tomorrow.planUnitId);
  assert.equal(planHash([a, b]), planHash([b, a]));
});

test('logical groups and shared OAuth group are metadata only', () => {
  assert.equal(logicalSiteKey('https://checkin.new-api.abrdns.com/checkin'), 'https://checkin.new-api.abrdns.com');
  assert.equal(logicalGroup('https://new-api.abrdns.com'), 'abrdns-welfare');
  assert.equal(credentialGroup('https://ai.venlacy.com/console'), 'linuxdo-shared');
  assert.equal(credentialGroup('https://api.42w.shop/profile'), null);
});

test('bridge imports 3 execution units and redacts sensitive evidence', () => {
  const root = fixtureRoot();
  const snapshot = buildSnapshot({ legacyRoot: root, generatedAt: '2026-09-02T02:00:00.000Z' });
  assert.equal(snapshot.mode, 'shadow_read_only');
  assert.equal(snapshot.counts.executionUnits, 3);
  assert.equal(snapshot.counts.logicalSites, 2);
  assert.equal(snapshot.tasks.filter((task) => task.origin === 'https://agentrouter.org').length, 2);
  assert.equal(snapshot.tasks.find((task) => task.accountKey === 'agentrouter-245770').accountRef.startsWith('acct_'), true);
  const usageReceipt = snapshot.receipts.find((receipt) => receipt.evidence.source === 'usage_log');
  assert.match(usageReceipt.evidence.summary, /redacted|amount-redacted|number-redacted/);
  assert.equal(snapshot.receipts.some((receipt) => receipt.evidence.summary.includes('should-not-copy')), false);
  assert.equal(snapshot.health.freshness.fresh, true);
});

test('bridge carries redacted PT observations without changing the execution plan', () => {
  const root = fixtureRoot();
  const baseline = buildSnapshot({ legacyRoot: root, generatedAt: '2026-09-02T02:00:00.000Z' });
  const snapshot = buildSnapshot({
    legacyRoot: root,
    generatedAt: '2026-09-02T02:00:00.000Z',
    ptStatusReport: {
      generatedAt: '2026-09-02T02:00:00.000Z',
      source: 'harvest',
      sites: [{ origin: 'https://pt.example', displayName: 'PT example', status: 'not_signed', evidence: { source: 'api', authoritative: true, summary: '未签到' } }]
    }
  });
  assert.equal(snapshot.counts.executionUnits, 3);
  assert.equal(snapshot.planHash, baseline.planHash);
  assert.equal(snapshot.ptStatus.counts.externalOnly, 1);
  assert.equal(snapshot.ptStatus.sites[0].supplementCandidate, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /password|cookie|authorization/i);
});

test('PT status does not make an identical source snapshot non-idempotent', () => {
  const root = fixtureRoot();
  const options = {
    legacyRoot: root,
    generatedAt: '2026-09-02T02:00:00.000Z',
    ptStatusReport: { generatedAt: '2026-09-02T02:00:00.000Z', source: 'harvest', sites: [{ origin: 'https://pt.example', status: 'signed', observedAt: '2026-09-02T01:30:00.000Z', evidence: { source: 'api', authoritative: true, summary: 'ok' } }] }
  };
  assert.equal(buildSnapshot(options).snapshotId, buildSnapshot(options).snapshotId);
});

test('stale health is surfaced instead of trusted', () => {
  const root = fixtureRoot({ healthCheckedAt: '2026-08-01T01:00:00.000Z' });
  const snapshot = buildSnapshot({ legacyRoot: root, generatedAt: '2026-09-02T02:00:00.000Z' });
  assert.equal(snapshot.health.healthy, true);
  assert.equal(snapshot.health.freshness.fresh, false);
  assert.equal(snapshot.health.reason, 'health source is stale or unavailable');
});

test('an injected health report overrides the legacy cached health file', () => {
  const root = fixtureRoot({ healthCheckedAt: '2026-08-01T01:00:00.000Z' });
  const snapshot = buildSnapshot({
    legacyRoot: root,
    generatedAt: '2026-09-02T02:00:00.000Z',
    healthReport: { healthy: true, reason: 'ok', checkedAt: '2026-09-02T01:59:00.000Z', failedChecks: [] }
  });
  assert.equal(snapshot.health.freshness.fresh, true);
  assert.equal(snapshot.health.sourceCheckedAt, '2026-09-02T01:59:00.000Z');
  const old = buildSnapshot({ legacyRoot: root, generatedAt: '2026-09-02T02:00:00Z' });
  assert.notEqual(snapshot.snapshotId, old.snapshotId);
});

test('bridge refuses to write into legacy project', () => {
  const root = fixtureRoot();
  const snapshot = buildSnapshot({ legacyRoot: root, generatedAt: '2026-09-02T02:00:00.000Z' });
  assert.throws(() => writeSnapshot(snapshot, path.join(root, 'should-not-write.json'), root), /legacy project/);
  const output = path.join(os.tmpdir(), `checkin-v2-${Date.now()}.json`);
  writeSnapshot(snapshot, output, root);
  assert.equal(JSON.parse(fs.readFileSync(output, 'utf8')).snapshotId, snapshot.snapshotId);
  fs.rmSync(output, { force: true });
});
