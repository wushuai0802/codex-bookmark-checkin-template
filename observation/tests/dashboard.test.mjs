import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';
import { createDashboardServer,calendarHistory } from '../src/dashboard-server.mjs';

const legacyRoot = fileURLToPath(new URL('./fixtures/legacy/', import.meta.url));

async function start(options) {
  const instance = createDashboardServer({ ...options, bind: '127.0.0.1', port: 0 });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const address = instance.server.address();
  return { instance, base: `http://127.0.0.1:${address.port}` };
}

function close(instance) {
  return new Promise((resolve) => instance.server.close(resolve));
}

test('calendar keeps the latest valid daily receipt beyond the recent run list',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-calendar-history-'));
  const row=(businessDate,recordedAt,completed)=>({businessDate,recordedAt,
    counts:{executionUnits:2,status:{signed:completed,needs_attention:2-completed}},
    taskSummaries:[{origin:'https://example.test',displayName:'Example',observedStatus:'signed',
      evidence:{source:'page_text',summary:'token=abc',authoritative:true}}]});
  const older=row('2026-08-01','2026-08-01T01:00:00Z',1);
  const records=[older,...Array.from({length:35},(_,index)=>row('2026-09-02',
    `2026-09-02T${String(index%24).padStart(2,'0')}:${String(index).padStart(2,'0')}:00Z`,1)),
    row('2026-09-02','2026-09-02T23:59:00Z',2),row('2026-02-30','2026-02-30T00:00:00Z',2)];
  fs.writeFileSync(path.join(root,'shadow-ledger.jsonl'),records.map(record=>JSON.stringify(record)).join('\n')+'\n');
  const projected=calendarHistory(records,{now:new Date('2026-09-03T00:00:00Z')});
  assert.deepEqual(projected.days.map(day=>day.businessDate),['2026-08-01','2026-09-02']);
  assert.equal(projected.days[1].counts.status.signed,2);
  assert.doesNotMatch(JSON.stringify(projected),/token=abc/);
  assert.equal(calendarHistory(records,{limit:1,now:new Date('2026-09-03T00:00:00Z')}).oldestBusinessDate,'2026-09-02');
  const longHistory=Array.from({length:182},(_,index)=>{
    const day=new Date(Date.UTC(2026,0,index+1)).toISOString().slice(0,10);
    return row(day,`${day}T12:00:00Z`,1);
  });
  const bounded=calendarHistory(longHistory,{now:new Date('2027-01-01T00:00:00Z')});
  assert.equal(bounded.days.length,180);
  assert.equal(bounded.truncated,true);
  assert.equal(bounded.oldestBusinessDate,longHistory[2].businessDate);
  const {instance,base}=await start({dataDir:root});
  try{
    const overview=await(await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.ledger.length,30);
    const calendar=await(await fetch(`${base}/api/calendar`)).json();
    assert.equal(calendar.days.length,2);
    assert.equal(calendar.days[0].businessDate,'2026-08-01');
  }finally{await close(instance);fs.rmSync(root,{recursive:true,force:true});}
});

test('dashboard serves summary, tasks, and static UI from redacted data', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dashboard-'));
  const snapshot = buildSnapshot({
    legacyRoot,
    generatedAt: '2026-09-02T14:00:00.000Z',
    ptStatusReport: {
      generatedAt: '2026-09-02T14:00:00.000Z', source: 'harvest',
      sites: [{ origin: 'https://external-pt.example', displayName: '外部 PT', status: 'not_signed', evidence: { source: 'api', authoritative: true, summary: '未签到' } }]
    }
  });
  snapshot.tasks[0].identity = { userId: '12345', username: 'example-reader', label: 'Primary', provider: 'GitHub', password: 'TEST' };
  fs.writeFileSync(path.join(root, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
  const { instance, base } = await start({ dataDir: root });
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /Check-in Fabric/);
    const summary = await fetch(`${base}/api/summary`);
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json();
    assert.equal(summaryBody.counts.executionUnits, 3);
    const tasks = await fetch(`${base}/api/tasks?status=needs_attention`);
    assert.equal(tasks.status, 200);
    assert.ok((await tasks.json()).total >= 1);
    const sites = await fetch(`${base}/api/sites`);
    assert.equal((await sites.json()).total, 2);
    const ptStatus = await fetch(`${base}/api/pt-status`);
    assert.equal(ptStatus.status, 200);
    const ptBody = await ptStatus.json();
    assert.equal(ptBody.counts.externalOnly, 1);
    assert.equal(ptBody.sites[0].supplementCandidate, false, 'historical snapshot cannot retain fresh supplement eligibility');
    const overview = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(overview.snapshot.counts.executionUnits, overview.tasks.length);
    assert.equal(overview.tasks[0].identity.username, 'example-reader');
    assert.equal(overview.tasks[0].identity.userId, '12345');
    assert.doesNotMatch(JSON.stringify(overview), /"password"|"TEST"/);
    assert.equal(overview.snapshot.health.freshness.fresh, false);
    assert.equal(overview.snapshot.readiness.accepted, false);
    const original = overview.tasks[0];
    const paused = await fetch(`${base}/api/controls/sites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: original.origin, policy: 'pause', pauseHours: 24 })
    });
    assert.equal(paused.status, 200);
    const during = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(during.tasks[0].observedStatus, original.observedStatus);
    assert.ok(Date.parse(during.tasks[0].attention.pausedUntil) > Date.now());
    assert.deepEqual(during.status, overview.status);
    const controlFile = path.join(root, 'control-state.json');
    const stored = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
    stored.sites[original.origin].expiresAt = '2026-09-19T00:00:00Z';
    fs.writeFileSync(controlFile, JSON.stringify(stored));
    const expired = await (await fetch(`${base}/api/overview`)).json();
    assert.equal(expired.controls[original.origin].policy, 'monitor');
    assert.equal(expired.tasks[0].attention, undefined);
    assert.equal(expired.tasks[0].observedStatus, original.observedStatus);
    assert.equal((await fetch(`${base}/overview-model.mjs`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.match(pageText, /PT 状态/);
  } finally { await close(instance); fs.rmSync(root, { recursive: true, force: true }); }
});

test('non-loopback deployment uses an HttpOnly session and exposes only bounded controls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dashboard-auth-'));
  const { instance, base } = await start({ dataDir: root, adminToken: 'test-token-1234567890', trustProxyTls: true });
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/api/summary`)).status, 401);
    assert.equal((await fetch(`${base}/api/calendar`)).status, 401);
    const session = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'test-token-1234567890', remember: true })
    });
    assert.equal(session.status, 200);
    const setCookie = session.headers.get('set-cookie');
    assert.match(setCookie, /^fabric_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /Max-Age=604800/);
    assert.doesNotMatch(setCookie, /test-token-1234567890/);
    const cookie = setCookie.split(';', 1)[0];
    assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/calendar`, { headers: { Cookie: cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/config`, { headers: { Cookie: ['fabric_session','test-token-1234567890'].join('=') } })).status, 401);
    const unauthorized = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com', policy: 'pause' }) });
    assert.equal(unauthorized.status, 401);
    const authorized = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://Example.com/path', policy: 'pause', note: '<b>review</b>' }) });
    assert.equal(authorized.status, 400);
    const saved = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com', policy: 'pause', note: '<b>review</b>' }) });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.executionImpact, 'none_in_beta');
    assert.ok(Date.parse(savedBody.expiresAt) > Date.now());
    const invalidDuration = await fetch(`${base}/api/controls/sites`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890', 'Content-Type': 'application/json' }, body: JSON.stringify({ origin: 'https://example.com', policy: 'pause', pauseHours: 1 }) });
    assert.equal(invalidDuration.status, 400);
    const controls = await fetch(`${base}/api/controls`, { headers: { Authorization: ['Bearer','test-token-1234567890'].join(' ') } });
    const controlsBody = await controls.json();
    assert.equal(controlsBody.sites['https://example.com'].policy, 'pause');
    assert.equal(controlsBody.sites['https://example.com'].note, '<b>review</b>');
    assert.equal(controlsBody.sites['https://example.com'].expiresAt, savedBody.expiresAt);
    const overview = await fetch(`${base}/api/overview`, { headers: { Cookie: cookie } });
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).controls['https://example.com'].policy, 'pause');
    const method = await fetch(`${base}/api/summary`, { method: 'POST', headers: { 'X-Fabric-Token': 'test-token-1234567890' } });
    assert.equal(method.status, 405);
    const logout = await fetch(`${base}/api/session/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  } finally { await close(instance); fs.rmSync(root, { recursive: true, force: true }); }
});

test('dashboard client never persists the administrator token in browser storage', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /setItem\([^\n]*(fabricToken|token)/i);
  assert.match(source, /\/api\/session/);
  assert.match(source, /credentials:\s*'same-origin'/);
});

test('static modules cannot exhaust the API request budget', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-dashboard-limit-'));
  const snapshot = buildSnapshot({ legacyRoot, generatedAt: new Date().toISOString() });
  fs.writeFileSync(path.join(root, 'shadow-beta-snapshot.json'), JSON.stringify(snapshot));
  const { instance, base } = await start({ dataDir: root, rateLimitPerMinute: 10 });
  try {
    for (let index = 0; index < 15; index++) assert.equal((await fetch(`${base}/notice-state.mjs`)).status, 200);
    for (let index = 0; index < 10; index++) assert.equal((await fetch(`${base}/api/overview`)).status, 200);
    assert.equal((await fetch(`${base}/api/overview`)).status, 429);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
  } finally { await close(instance); fs.rmSync(root, { recursive: true, force: true }); }
});
