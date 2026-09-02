#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from './shadow-ledger.mjs';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(MODULE_ROOT, '..', 'public');
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const MAX_BODY_BYTES = 16 * 1024;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function envNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function safeResolve(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(path.isAbsolute(candidate) ? candidate : path.join(resolvedRoot, candidate));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('path escapes configured data directory');
  }
  return resolved;
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function configuredAdminToken() {
  const file = process.env.FABRIC_ADMIN_TOKEN_FILE;
  if (file && fs.existsSync(file)) {
    try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; }
  }
  return process.env.FABRIC_ADMIN_TOKEN ?? '';
}

function readControlState(file) {
  const value = readJson(file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { schemaVersion: 1, sites: {}, audit: [] };
  return {
    schemaVersion: 1,
    sites: value.sites && typeof value.sites === 'object' && !Array.isArray(value.sites) ? value.sites : {},
    audit: Array.isArray(value.audit) ? value.audit.slice(-200) : []
  };
}

function safeOrigin(value) {
  if (typeof value !== 'string' || value.length > 255) throw new Error('origin must be a short URL');
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('origin must be an http(s) origin without credentials or query');
  }
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('request body must be valid JSON')); }
    });
    request.on('error', reject);
  });
}

function fileMtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

function latestSnapshot(dataDir, configuredFile) {
  const candidates = configuredFile
    ? [safeResolve(dataDir, configuredFile)]
    : ['shadow-beta-snapshot.json', 'shadow-snapshot.json', 'snapshot.json'].map((name) => path.join(dataDir, name));
  const found = candidates
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return found ? { file: found.file, snapshot: readJson(found.file) } : { file: null, snapshot: null };
}

function latestLedger(dataDir, configuredFile) {
  const candidates = configuredFile
    ? [safeResolve(dataDir, configuredFile)]
    : ['shadow-ledger.jsonl', 'ledger.jsonl'].map((name) => path.join(dataDir, name));
  const found = candidates
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return found ? { file: found.file, records: readLedger(found.file) } : { file: null, records: [] };
}

function publicTask(task, receipt) {
  return {
    taskId: task.taskId,
    businessDate: task.businessDate,
    origin: task.origin,
    logicalSiteKey: task.logicalSiteKey,
    logicalGroup: task.logicalGroup ?? null,
    accountRef: task.accountRef ?? null,
    actionType: task.actionType,
    scheduleOccurrence: task.scheduleOccurrence,
    executionOwner: task.executionOwner,
    executionMode: task.executionMode,
    observedStatus: task.observedStatus ?? receipt?.status ?? null,
    observedAt: receipt?.observedAt ?? null,
    evidence: receipt?.evidence ? {
      source: receipt.evidence.source,
      authoritative: receipt.evidence.authoritative,
      summary: receipt.evidence.summary,
      redacted: receipt.evidence.redacted === true
    } : null
  };
}

function publicSnapshot(snapshot) {
  if (!snapshot) return null;
  const source = snapshot.source ?? {};
  const safeSource = {
    system: source.system === 'legacy-checkin' ? 'legacy-checkin' : null,
    runId: typeof source.runId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(source.runId) ? source.runId : null,
    bookmarkPlanGeneratedAt: typeof source.bookmarkPlanGeneratedAt === 'string' ? source.bookmarkPlanGeneratedAt.slice(0, 64) : null,
    schedulerStateDate: typeof source.schedulerStateDate === 'string' ? source.schedulerStateDate.slice(0, 32) : null,
    executionComplete: source.executionComplete === true,
    businessComplete: source.businessComplete === true,
    pendingExternalCount: Number.isInteger(source.pendingExternalCount) && source.pendingExternalCount >= 0 ? source.pendingExternalCount : null,
    siteStateUpdatedAt: typeof source.siteStateUpdatedAt === 'string' ? source.siteStateUpdatedAt.slice(0, 64) : null
  };
  const counts = snapshot.counts ?? {};
  const safeCounts = {
    logicalSites: Number.isInteger(counts.logicalSites) && counts.logicalSites >= 0 ? counts.logicalSites : 0,
    executionUnits: Number.isInteger(counts.executionUnits) && counts.executionUnits >= 0 ? counts.executionUnits : 0,
    status: Object.fromEntries(Object.entries(counts.status ?? {}).filter(([key, value]) => /^[a-z_]+$/.test(key) && Number.isInteger(value) && value >= 0)),
    bookmarkSourceCounts: Object.fromEntries(Object.entries(counts.bookmarkSourceCounts ?? {}).filter(([key, value]) => typeof key === 'string' && key.length <= 80 && Number.isInteger(value) && value >= 0))
  };
  return {
    snapshotId: typeof snapshot.snapshotId === 'string' && /^snap_[a-f0-9]{24}$/.test(snapshot.snapshotId) ? snapshot.snapshotId : null,
    generatedAt: typeof snapshot.generatedAt === 'string' ? snapshot.generatedAt.slice(0, 64) : null,
    businessDate: typeof snapshot.businessDate === 'string' ? snapshot.businessDate.slice(0, 32) : null,
    mode: snapshot.mode === 'shadow_read_only' ? 'shadow_read_only' : null,
    planHash: typeof snapshot.planHash === 'string' && /^[a-f0-9]{64}$/.test(snapshot.planHash) ? snapshot.planHash : null,
    source: safeSource,
    counts: safeCounts,
    health: snapshot.health && typeof snapshot.health === 'object' ? {
      healthy: snapshot.health.healthy === true,
      sourceCheckedAt: typeof snapshot.health.sourceCheckedAt === 'string' ? snapshot.health.sourceCheckedAt.slice(0, 64) : null,
      freshness: snapshot.health.freshness && typeof snapshot.health.freshness === 'object' ? {
        fresh: snapshot.health.freshness.fresh === true,
        ageHours: typeof snapshot.health.freshness.ageHours === 'number' && snapshot.health.freshness.ageHours >= 0 ? snapshot.health.freshness.ageHours : null,
        maxAgeHours: typeof snapshot.health.freshness.maxAgeHours === 'number' && snapshot.health.freshness.maxAgeHours > 0 ? snapshot.health.freshness.maxAgeHours : 26
      } : { fresh: false, ageHours: null, maxAgeHours: 26 },
      reason: typeof snapshot.health.reason === 'string' ? snapshot.health.reason.slice(0, 240) : null,
      failedCheckCount: Number.isInteger(snapshot.health.failedCheckCount) && snapshot.health.failedCheckCount >= 0 ? snapshot.health.failedCheckCount : null
    } : null
  };
}

function buildView(snapshot, ledger) {
  const receiptByTask = new Map((snapshot?.receipts ?? []).map((receipt) => [receipt.taskId, receipt]));
  const tasks = (snapshot?.tasks ?? []).map((task) => publicTask(task, receiptByTask.get(task.taskId)));
  const sites = new Map();
  const accounts = new Map();
  for (const task of tasks) {
    const site = sites.get(task.origin) ?? {
      origin: task.origin, logicalSiteKey: task.logicalSiteKey,
      logicalGroup: task.logicalGroup, executionUnitCount: 0,
      status: {}, accounts: new Set()
    };
    site.executionUnitCount += 1;
    site.status[task.observedStatus ?? 'unknown'] = (site.status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
    if (task.accountRef) site.accounts.add(task.accountRef);
    sites.set(task.origin, site);
    if (task.accountRef) {
      const account = accounts.get(task.accountRef) ?? { accountRef: task.accountRef, taskCount: 0, sites: new Set(), status: {} };
      account.taskCount += 1;
      account.sites.add(task.origin);
      account.status[task.observedStatus ?? 'unknown'] = (account.status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
      accounts.set(task.accountRef, account);
    }
  }
  const serializeGroup = (value) => ({ ...value, accounts: value.accounts ? [...value.accounts].sort() : undefined, sites: value.sites ? [...value.sites].sort() : undefined });
  const status = {};
  for (const task of tasks) status[task.observedStatus ?? 'unknown'] = (status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
  return {
    snapshot: publicSnapshot(snapshot),
    status,
    tasks,
    sites: [...sites.values()].map(serializeGroup).sort((a, b) => a.origin.localeCompare(b.origin)),
    accounts: [...accounts.values()].map(serializeGroup).sort((a, b) => a.accountRef.localeCompare(b.accountRef)),
    ledger: ledger.slice(-30).map((record) => ({
      recordId: record.recordId, recordedAt: record.recordedAt,
      snapshotId: record.snapshotId, businessDate: record.businessDate,
      planHash: record.planHash, mode: record.mode,
      counts: record.counts, drift: record.drift, health: record.health
    }))
  };
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientAddress(request) {
  return request.socket.remoteAddress ?? 'unknown';
}

function securityHeaders({ trustProxyTls = false } = {}) {
  const headers = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
  if (trustProxyTls) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    ...headers, 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store'
  });
  response.end(payload);
}

function sendError(response, statusCode, code, message) {
  sendJson(response, statusCode, { error: code, message });
}

export function createDashboardServer({
  dataDir = process.env.FABRIC_DATA_DIR ?? path.resolve(MODULE_ROOT, '..', 'outputs'),
  snapshotFile = process.env.FABRIC_SNAPSHOT_FILE ?? null,
  ledgerFile = process.env.FABRIC_LEDGER_FILE ?? null,
  adminToken = configuredAdminToken(),
  bind = process.env.FABRIC_BIND ?? '127.0.0.1',
  port = envNumber(process.env.FABRIC_PORT, 8787, { min: 1, max: 65535 }),
  trustProxyTls = process.env.FABRIC_TRUST_PROXY_TLS === '1',
  rateLimitPerMinute = envNumber(process.env.FABRIC_RATE_LIMIT_PER_MINUTE, 120, { min: 10, max: 10000 })
} = {}) {
  const root = path.resolve(dataDir);
  const controlFile = safeResolve(root, process.env.FABRIC_CONTROL_FILE ?? 'control-state.json');
  const authRequired = Boolean(adminToken) || !['127.0.0.1', '::1', 'localhost'].includes(bind);
  if (authRequired && !adminToken) throw new Error('FABRIC_ADMIN_TOKEN is required when dashboard is not loopback-only');
  const hits = new Map();
  const headers = securityHeaders({ trustProxyTls });

  function authorized(request, response) {
    if (!authRequired) return true;
    const supplied = request.headers['x-fabric-token'] ?? (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '');
    if (tokenMatches(supplied, adminToken)) return true;
    response.setHeader('WWW-Authenticate', 'Bearer realm="checkin-fabric"');
    sendError(response, 401, 'unauthorized', 'dashboard authentication required');
    return false;
  }

  function rateLimited(request) {
    const now = Date.now();
    const key = clientAddress(request);
    const previous = hits.get(key) ?? { startedAt: now, count: 0 };
    if (now - previous.startedAt >= 60000) { previous.startedAt = now; previous.count = 0; }
    previous.count += 1;
    hits.set(key, previous);
    return previous.count > rateLimitPerMinute;
  }

  function loadView() {
    const current = latestSnapshot(root, snapshotFile);
    const ledger = latestLedger(root, ledgerFile);
    const view = buildView(current.snapshot, ledger.records);
    view.controls = readControlState(controlFile).sites;
    return view;
  }

  const server = http.createServer(async (request, response) => {
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    response.setHeader('X-Request-Id', crypto.randomUUID());
    if (!SAFE_METHODS.has(request.method) && request.method !== 'POST') {
      response.setHeader('Allow', 'GET, HEAD, POST');
      sendError(response, 405, 'method_not_allowed', 'dashboard accepts GET and bounded control POST requests only');
      return;
    }
    if (rateLimited(request)) { sendError(response, 429, 'rate_limited', 'too many requests'); return; }
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname === '/healthz') {
      sendJson(response, 200, { service: 'ok', mode: 'shadow_read_only' });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname !== '/api/controls/sites') {
      response.setHeader('Allow', 'GET, HEAD');
      sendError(response, 405, 'method_not_allowed', 'POST is only available for site control state');
      return;
    }
    if (requestUrl.pathname.startsWith('/api/')) {
      if (!authorized(request, response)) return;
      let view;
      try { view = loadView(); }
      catch { sendError(response, 500, 'data_error', 'dashboard data could not be read'); return; }
      if (requestUrl.pathname === '/api/summary') {
        sendJson(response, 200, { ...view.snapshot, status: view.status, ledgerRecords: view.ledger.length });
      } else if (requestUrl.pathname === '/api/tasks') {
        const query = (requestUrl.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
        const filterStatus = requestUrl.searchParams.get('status');
        const tasks = view.tasks.filter((task) => (!filterStatus || task.observedStatus === filterStatus) && (!query || `${task.origin} ${task.logicalSiteKey} ${task.accountRef ?? ''} ${task.taskId}`.toLowerCase().includes(query)));
        sendJson(response, 200, { tasks, total: tasks.length });
      } else if (requestUrl.pathname === '/api/sites') {
        const sites = view.sites.map((site) => ({ ...site, control: view.controls?.[site.origin] ?? { policy: 'monitor', note: '', updatedAt: null } }));
        sendJson(response, 200, { sites, total: sites.length });
      }
      else if (requestUrl.pathname === '/api/accounts') sendJson(response, 200, { accounts: view.accounts, total: view.accounts.length });
      else if (requestUrl.pathname === '/api/ledger') sendJson(response, 200, { records: view.ledger, total: view.ledger.length });
      else if (requestUrl.pathname === '/api/config') sendJson(response, 200, { mode: 'shadow_read_only', mutationDisabled: false, executionEnabled: false, executionOwner: 'legacy-checkin', authConfigured: authRequired, dataDirectoryConfigured: true });
      else if (requestUrl.pathname === '/api/controls') {
        if (request.method !== 'GET') { sendError(response, 405, 'method_not_allowed', 'use POST /api/controls/sites for a site policy'); return; }
        const controls = readControlState(controlFile);
        sendJson(response, 200, { sites: controls.sites, audit: controls.audit.slice(-30) });
      } else if (requestUrl.pathname === '/api/controls/sites' && request.method === 'POST') {
        if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendError(response, 415, 'unsupported_media_type', 'control state requires application/json');
          return;
        }
        let body;
        try { body = await readRequestBody(request); }
        catch (error) { sendError(response, 400, 'invalid_body', error.message); return; }
        try {
          const origin = safeOrigin(body.origin);
          const policy = ['monitor', 'pause', 'review'].includes(body.policy) ? body.policy : null;
          if (!policy) throw new Error('policy must be monitor, pause, or review');
          const note = typeof body.note === 'string' ? body.note.trim().slice(0, 240) : '';
          const controls = readControlState(controlFile);
          controls.sites[origin] = { policy, note, updatedAt: new Date().toISOString(), source: 'dashboard' };
          controls.audit.push({ origin, policy, note, recordedAt: new Date().toISOString(), source: 'dashboard' });
          fs.mkdirSync(path.dirname(controlFile), { recursive: true });
          fs.writeFileSync(controlFile, `${JSON.stringify(controls, null, 2)}\n`, 'utf8');
          sendJson(response, 200, { ok: true, origin, policy, note, executionImpact: 'none_in_beta' });
        } catch (error) { sendError(response, 400, 'invalid_control', error.message); }
      }
      else if (requestUrl.pathname === '/api/health') sendJson(response, 200, { service: 'ok', mode: 'shadow_read_only', generatedAt: new Date().toISOString(), snapshot: view.snapshot, dataAvailable: Boolean(view.snapshot), ledgerRecords: view.ledger.length });
      else sendError(response, 404, 'not_found', 'API endpoint not found');
      return;
    }
    let relative;
    try { relative = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname); }
    catch { sendError(response, 400, 'invalid_path', 'invalid URL path'); return; }
    const file = safeResolve(PUBLIC_ROOT, path.join(PUBLIC_ROOT, relative));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { sendError(response, 404, 'not_found', 'page not found'); return; }
    const content = fs.readFileSync(file);
    response.writeHead(200, { ...headers, 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache' });
    if (request.method === 'HEAD') response.end(); else response.end(content);
  });
  return { server, bind, port, authRequired, dataDir: root };
}

export function startDashboardServer(options = {}) {
  const instance = createDashboardServer(options);
  instance.server.listen(instance.port, instance.bind, () => {
    const address = instance.server.address();
    const actualPort = typeof address === 'object' && address ? address.port : instance.port;
    console.log(`check-in fabric dashboard listening on ${instance.bind}:${actualPort} (mode=shadow_read_only, auth=${instance.authRequired ? 'required' : 'loopback'})`);
  });
  return instance;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { startDashboardServer(); }
  catch (error) { console.error(`dashboard error: ${error.message}`); process.exitCode = 1; }
}
