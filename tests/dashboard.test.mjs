import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../src/bridge.mjs';
import { createDashboardServer } from '../src/dashboard-server.mjs';

const legacyRoot = 'D:\\AIWorkspace\\bots\\chrome-daily-checkin';

async function start(options) {
  const instance = createDashboardServer({ ...options, bind: '127.0.0.1', port: 0 });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  return { instance, base: `http://127.0.0.1:${address.port}` };
}

function close(instance) {
  return new Promise((resolve) => instance.server.close(resolve));
}

test('dashboard serves summary, tasks, and static UI from redacted data', { skip: !fs.existsSync(legacyRoot) }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dashboard-'));
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: '2026-09-02T14:00:00.000Z' });
  fs.writeFileSync(path.join(root, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
  const { instance, base } = await start({ dataDir: root });
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Check-in Fabric/);
    const summary = await fetch(`${base}/api/summary`);
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json();
    assert.equal(summaryBody.counts.executionUnits, 21);
    const tasks = await fetch(`${base}/api/tasks?status=needs_attention`);
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).total, 1);
    const sites = await fetch(`${base}/api/sites`);
    assert.equal((await sites.json()).total, 17);
  } finally { await close(instance); fs.rmSync(root, { recursive: true, force: true }); }
});

test('non-loopback deployment requires token and exposes only bounded controls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dashboard-auth-'));
  const { instance, base } = await start({ dataDir: root, adminToken: 'test-token-1234567890' });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/summary`)).status, 401);
    const unauthorized = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com', policy: 'pause' }) });
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://Example.com/path', policy: 'pause', note: '<b>review</b>' }) });
    assert.equal(authorized.status, 400);
    const saved = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com', policy: 'pause', note: '<b>review</b>' }) });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.executionImpact, 'none_in_beta');
    const controls = await fetch(`${base}/api/controls`, { headers: { Authorization: 'Bearer test-token-1234567890' } });
    const controlsBody = await controls.json();
    assert.equal(controlsBody.sites['https://example.com'].policy, 'pause');
    assert.equal(controlsBody.sites['https://example.com'].note, '<b>review</b>');
    const method = await fetch(`${base}/api/summary`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890' } });
    assert.equal(method.status, 405);
  } finally { await close(instance); fs.rmSync(root, { recursive: true, force: true }); }
});
