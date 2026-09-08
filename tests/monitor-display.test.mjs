import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { buildPtStatus } from '../src/pt-status.mjs';
import { bookmarkCatalog } from '../src/monitor-catalog.mjs';
import { displayIdentity } from '../src/display-identity.mjs';
import { identityTitle, matchesTask, matchesPt } from '../public/dashboard-model.mjs';

test('bookmark inventory is exact, deduplicated and does not keep removed sites', () => {
  const fixture = { roots: { bar: { id: 'parent', children: [{ id: 'pt', children: [
    { type: 'url', name: '站点', url: 'https://pt.example/attendance?passkey=private' },
    { type: 'url', url: 'https://pt.example/' }, { type: 'url', url: 'https://u:p@unsafe.example/' }
  ] }, { id: 'other', children: [{ type: 'url', url: 'https://excluded.example' }] }] } } };
  const scope = { parentId: 'parent', folderId: 'pt' };
  assert.deepEqual(bookmarkCatalog(fixture, scope).sites, [{ origin: 'https://pt.example', displayName: 'pt.example' }]);
  fixture.roots.bar.children[0].children = [];
  assert.equal(bookmarkCatalog(fixture, scope).sites.length, 0);
  assert.throws(() => bookmarkCatalog(fixture, { ...scope, parentId: 'wrong' }), /missing/);
});

test('monitor-only catalog and Harvest evidence never alter task identity or plan', () => {
  const args = { legacyRoot: fileURLToPath(new URL('./fixtures/legacy/', import.meta.url)), generatedAt: '2026-09-02T14:00:00Z' };
  const before = buildSnapshot(args);
  const after = buildSnapshot({ ...args, monitorCatalog: { sites: [{ origin: 'https://monitor.example', displayName: '仅监测' }] },
    ptStatusReport: { generatedAt: args.generatedAt, source: 'harvest', sites: [{ origin: 'https://monitor.example', status: 'signed', observedAt: args.generatedAt,
      evidence: { source: 'harvest', authoritative: true, summary: '今日签到回执' } }] } });
  assert.equal(after.planHash, before.planHash);
  assert.deepEqual(after.tasks, before.tasks);
  assert.equal(after.ptStatus.executionEnabled, false);
  assert.equal(after.ptStatus.sites[0].inLegacyPlan, false);
  assert.equal(after.ptStatus.sites[0].effective.status, 'signed');
});

test('catalog entries without evidence are unknown, not fresh or executable', () => {
  const result = buildPtStatus({ generatedAt: '2026-09-07T14:00:00Z', businessDate: '2026-09-07',
    monitorCatalog: { sites: [{ origin: 'https://monitor.example' }] } });
  assert.equal(result.sites[0].effective.status, 'unknown');
  assert.equal(result.sites[0].effective.observedAt, null);
  assert.equal(result.sites[0].effective.fresh, false);
  assert.equal(result.sites[0].supplementCandidate, false);
});

test('older Harvest report is evaluated against current time, including day rollover', () => {
  const result = buildPtStatus({ generatedAt: '2026-09-08T01:00:00Z', businessDate: '2026-09-08',
    externalReport: { generatedAt: '2026-09-07T10:00:00Z', source: 'harvest', sites: [{ origin: 'https://monitor.example', status: 'not_signed',
      observedAt: '2026-09-07T10:00:00Z', evidence: { source: 'api', authoritative: true } }] } });
  assert.equal(result.sites[0].effective.fresh, false);
  assert.equal(result.sites[0].supplementCandidate, false);
});

test('display identity preserves actual ID and never includes credentials', () => {
  const id = displayIdentity({ userId: '336579', username: 'example-user', password: 'never-copy', label: 'Agent' });
  assert.equal(id.userId, '336579'); assert.equal(identityTitle({ identity: id }), 'example-user');
  assert.equal('password' in id, false);
  assert.equal(displayIdentity({ username: 'token=bad' }).username, null);
});

test('KPI and identity searches use exact status groups, PT filters stay separate', () => {
  const task = { origin: 'https://example.com', identity: { userId: '12345', username: 'reader' }, observedStatus: 'already_signed' };
  assert.equal(matchesTask(task, { status: 'success', query: '12345' }), true);
  assert.equal(matchesTask(task, { status: 'pending' }), false);
  assert.equal(matchesTask({ ...task, observedStatus: 'not_available' }, { status: 'pending' }), false);
  assert.equal(matchesPt({ inLegacyPlan: false }, 'monitor'), true);
  assert.equal(matchesPt({ inLegacyPlan: true }, 'monitor'), false);
});
