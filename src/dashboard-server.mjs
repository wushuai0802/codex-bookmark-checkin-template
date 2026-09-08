#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from './shadow-ledger.mjs';
import { healthIsFresh, timestampFresh } from './freshness.mjs';
import { evaluateShadowHistory } from './shadow-acceptance.mjs';
import { displayIdentity, shortLabel } from './display-identity.mjs';
import {createWorkerGateway} from './worker-gateway.mjs';
import {publicAdapterObservations} from './adapter-observations.mjs';

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.resolve(MODULE_ROOT, '..', 'public');
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_COOKIE = 'fabric_session';
const SESSION_SECONDS = 12 * 60 * 60;
const REMEMBER_SECONDS = 7 * 24 * 60 * 60;
const PT_STATUS_VALUES = new Set([
  'signed', 'already_signed', 'not_signed', 'unknown', 'login_required',
  'unreachable', 'needs_attention', 'not_available', 'failed'
]);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mjs': 'text/javascript; charset=utf-8'
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
    planUnitId: task.planUnitId ?? null,
    businessDate: task.businessDate,
    origin: task.origin,
    logicalSiteKey: task.logicalSiteKey,
    logicalGroup: task.logicalGroup ?? null,
    accountRef: task.accountRef ?? null,
    displayName: shortLabel(task.displayName),
    identity: displayIdentity(task.identity),
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
      redacted: receipt.evidence.redacted === true,
      rawSource: shortLabel(receipt.evidence.rawSource,64), originalSource: shortLabel(receipt.evidence.originalSource,64),
      verification: shortLabel(receipt.evidence.verification,64)
    } : null
  };
}

function publicPtEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    source: typeof evidence.source === 'string' ? evidence.source.slice(0, 40) : 'none',
    authoritative: evidence.authoritative === true,
    summary: typeof evidence.summary === 'string' ? evidence.summary.slice(0, 240) : '',
    redacted: evidence.redacted === true,
    statusVerified: evidence.statusVerified === true
  };
}

function publicPtStatus(ptStatus) {
  if (!ptStatus || typeof ptStatus !== 'object' || Array.isArray(ptStatus)) return null;
  const now = new Date().toISOString();
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' });
  const freshPt = value => timestampFresh(value, now) && dayFormat.format(new Date(value)) === dayFormat.format(new Date(now));
  const sites = (Array.isArray(ptStatus.sites) ? ptStatus.sites : []).flatMap((site) => {
    try {
      const origin = safeOrigin(site.origin);
      if (!origin.startsWith('https://')) return [];
      const effective = site.effective && typeof site.effective === 'object' ? site.effective : null;
      const sourceStatuses = (Array.isArray(site.sourceStatuses) ? site.sourceStatuses : []).flatMap((item) => {
        const status = PT_STATUS_VALUES.has(item?.status) ? item.status : 'unknown';
        if (typeof item?.source !== 'string' || typeof item?.observedAt !== 'string') return [];
        return [{ source: item.source.slice(0, 40), status, observedAt: item.observedAt.slice(0, 64), fresh: item.fresh === true && timestampFresh(item.observedAt, now), authoritative: item.authoritative === true }];
      });
      const observations = (Array.isArray(site.observations) ? site.observations : []).flatMap((item) => {
        const status = PT_STATUS_VALUES.has(item?.status) ? item.status : 'unknown';
        if (typeof item?.source !== 'string' || typeof item?.observedAt !== 'string') return [];
        return [{ source: item.source.slice(0, 40), status, observedAt: item.observedAt.slice(0, 64), fresh: item.fresh === true && timestampFresh(item.observedAt, now), authoritative: item.authoritative === true, evidence: publicPtEvidence(item.evidence) }];
      });
      return [{
        siteRef: typeof site.siteRef === 'string' && /^pt_[a-f0-9]{16}$/.test(site.siteRef) ? site.siteRef : null,
        origin,
        displayName: typeof site.displayName === 'string' ? site.displayName.slice(0, 80) : origin.replace(/^https:\/\//, ''),
        accountRef: typeof site.accountRef === 'string' && /^acct_[a-f0-9]{16}$/.test(site.accountRef) ? site.accountRef : null,
        inLegacyPlan: site.inLegacyPlan === true,
        managedBy: typeof site.managedBy === 'string' ? site.managedBy.slice(0, 80) : 'other',
        effective: effective && typeof effective.source === 'string' ? {
          source: effective.source.slice(0, 40),
          status: PT_STATUS_VALUES.has(effective.status) ? effective.status : 'unknown',
          observedAt: typeof effective.observedAt === 'string' ? effective.observedAt.slice(0, 64) : null,
          fresh: effective.fresh === true && freshPt(effective.observedAt),
          authoritative: effective.authoritative === true,
          evidence: publicPtEvidence(effective.evidence)
        } : null,
        sourceStatuses,
        discrepancy: site.discrepancy === true,
        supplementCandidate: site.supplementCandidate === true && effective?.fresh === true && freshPt(effective?.observedAt),
        supplementAction: site.supplementCandidate === true && effective?.fresh === true && freshPt(effective?.observedAt) ? 'manual_review_only' : 'none',
        observations
      }];
    } catch { return []; }
  });
  const counts = ptStatus.counts && typeof ptStatus.counts === 'object' ? ptStatus.counts : {};
  const safeCount = (value, fallback) => Number.isInteger(value) && value >= 0 ? value : fallback;
  const status = Object.fromEntries([...PT_STATUS_VALUES].map((key) => [key, safeCount(counts.status?.[key], sites.filter((site) => site.effective?.status === key).length)]));
  return {
    schemaVersion: 1,
    generatedAt: typeof ptStatus.generatedAt === 'string' ? ptStatus.generatedAt.slice(0, 64) : null,
    businessDate: typeof ptStatus.businessDate === 'string' ? ptStatus.businessDate.slice(0, 32) : null,
    mode: 'status_observe_only',
    sources: (Array.isArray(ptStatus.sources) ? ptStatus.sources : []).filter((source) => typeof source === 'string').map((source) => source.slice(0, 40)).slice(0, 20),
    counts: {
      sites: safeCount(counts.sites, sites.length),
      inLegacyPlan: safeCount(counts.inLegacyPlan, sites.filter((site) => site.inLegacyPlan).length),
      externalOnly: safeCount(counts.externalOnly, sites.filter((site) => !site.inLegacyPlan).length),
      fresh: sites.filter((site) => site.effective?.fresh).length,
      discrepancies: safeCount(counts.discrepancies, sites.filter((site) => site.discrepancy).length),
      supplementCandidates: sites.filter((site) => site.supplementCandidate).length,
      status
    },
    executionEnabled: false,
    sites
  };
}

function publicSnapshot(snapshot, now = new Date().toISOString()) {
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
    reconciliation: snapshot.reconciliation ? {
      missingCount:Number(snapshot.reconciliation.missingCount)||0,conflictCount:Number(snapshot.reconciliation.conflictCount)||0,
      unexpectedCount:Number(snapshot.reconciliation.unexpectedCount)||0,planSource:shortLabel(snapshot.reconciliation.planSource)
    } : null,
    evidenceQuality: snapshot.evidenceQuality ? {verifiedSuccess:Number(snapshot.evidenceQuality.verifiedSuccess)||0,unverifiedSuccess:Number(snapshot.evidenceQuality.unverifiedSuccess)||0} : null,
    ptStatus: publicPtStatus(snapshot.ptStatus),
    health: snapshot.health && typeof snapshot.health === 'object' ? {
      healthy: snapshot.health.healthy === true,
      sourceCheckedAt: typeof snapshot.health.sourceCheckedAt === 'string' ? snapshot.health.sourceCheckedAt.slice(0, 64) : null,
      freshness: snapshot.health.freshness && typeof snapshot.health.freshness === 'object' ? {
        fresh: healthIsFresh(snapshot.health, now),
        ageHours: Number.isFinite(Date.parse(snapshot.health.sourceCheckedAt)) ? Math.max(0, (Date.parse(now) - Date.parse(snapshot.health.sourceCheckedAt)) / 3_600_000) : null,
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
      displayName: task.displayName,
      logicalGroup: task.logicalGroup, executionUnitCount: 0,
      status: {}, accounts: new Set()
    };
    site.executionUnitCount += 1;
    site.status[task.observedStatus ?? 'unknown'] = (site.status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
    if (task.accountRef) site.accounts.add(task.accountRef);
    sites.set(task.origin, site);
    if (task.accountRef) {
      const accountGroup = `${task.origin}|${task.accountRef}`;
      const account = accounts.get(accountGroup) ?? { accountRef: task.accountRef, identity: task.identity,
        displayName: task.displayName, origin: task.origin, taskCount: 0, sites: new Set(), status: {} };
      account.taskCount += 1;
      account.sites.add(task.origin);
      account.status[task.observedStatus ?? 'unknown'] = (account.status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
      accounts.set(accountGroup, account);
    }
  }
  const serializeGroup = (value) => ({ ...value, accounts: value.accounts ? [...value.accounts].sort() : undefined, sites: value.sites ? [...value.sites].sort() : undefined });
  const status = {};
  for (const task of tasks) status[task.observedStatus ?? 'unknown'] = (status[task.observedStatus ?? 'unknown'] ?? 0) + 1;
  return {
    snapshot: publicSnapshot(snapshot),
    readiness: evaluateShadowHistory(ledger),
    ptStatus: publicPtStatus(snapshot?.ptStatus),
    status,
    tasks,
    sites: [...sites.values()].map(serializeGroup).sort((a, b) => a.origin.localeCompare(b.origin)),
    accounts: [...accounts.values()].map(serializeGroup).sort((a, b) => a.accountRef.localeCompare(b.accountRef)),
    ledger: ledger.slice(-30).map((record) => ({
      recordId: record.recordId, recordedAt: record.recordedAt,
      snapshotId: record.snapshotId, businessDate: record.businessDate,
      planHash: record.planHash, mode: record.mode,
      counts: record.counts, drift: record.drift, health: record.health,
      sourceRunId: shortLabel(record.sourceRunId, 120),
      taskSummaries: Array.isArray(record.taskSummaries) ? record.taskSummaries.map(task => publicTask(task, task)) : null,
      changes: Array.isArray(record.changes) ? record.changes.filter(change => ['status','added','removed','changed'].includes(change.kind) && change.task).map(change => ({
        kind: change.kind, from: shortLabel(change.from, 40), to: shortLabel(change.to, 40), task: publicTask(change.task, change.task)
      })) : []
    }))
  };
}

function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestCookie(request, name) {
  const header = String(request.headers.cookie ?? '');
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { return ''; }
  }
  return '';
}

function createSessionToken(adminToken, { remember = false, now = Date.now() } = {}) {
  const lifetime = remember ? REMEMBER_SECONDS : SESSION_SECONDS;
  const expiresAt = Math.floor(now / 1000) + lifetime;
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `v1.${expiresAt}.${nonce}`;
  const signature = crypto.createHmac('sha256', adminToken).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function sessionTokenMatches(provided, adminToken, { now = Date.now() } = {}) {
  if (!provided || !adminToken) return false;
  const parts = provided.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1' || !/^\d{10}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{20,}$/.test(parts[2]) || !/^[A-Za-z0-9_-]{40,}$/.test(parts[3])) return false;
  const expiresAt = Number(parts[1]);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds || expiresAt > nowSeconds + REMEMBER_SECONDS + 60) return false;
  const payload = parts.slice(0, 3).join('.');
  const expected = crypto.createHmac('sha256', adminToken).update(payload).digest('base64url');
  return tokenMatches(parts[3], expected);
}

function sessionCookie(token, { remember = false, secure = false, clear = false } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict'
  ];
  if (secure) attributes.push('Secure');
  if (clear) attributes.push('Max-Age=0');
  else if (remember) attributes.push(`Max-Age=${REMEMBER_SECONDS}`);
  return attributes.join('; ');
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
  rateLimitPerMinute = envNumber(process.env.FABRIC_RATE_LIMIT_PER_MINUTE, 120, { min: 10, max: 10000 }),
  workerGateway = null
} = {}) {
  const root = path.resolve(dataDir);
  const controlFile = safeResolve(root, process.env.FABRIC_CONTROL_FILE ?? 'control-state.json');
  const authRequired = Boolean(adminToken) || !['127.0.0.1', '::1', 'localhost'].includes(bind);
  if (authRequired && !adminToken) throw new Error('FABRIC_ADMIN_TOKEN is required when dashboard is not loopback-only');
  const hits = new Map();
  const headers = securityHeaders({ trustProxyTls });

  function authorized(request, response) {
    if (!authRequired) return true;
    const headerToken = request.headers['x-fabric-token']
      ?? (request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '');
    const cookieToken = requestCookie(request, SESSION_COOKIE);
    if (tokenMatches(headerToken, adminToken) || sessionTokenMatches(cookieToken, adminToken)) return true;
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
    const observationsFile=path.join(root,'adapter-observations.json');
    try{view.adapterObservations=fs.statSync(observationsFile).size<=1_000_000?publicAdapterObservations(JSON.parse(fs.readFileSync(observationsFile,'utf8'))):null;}
    catch{view.adapterObservations=null;}
    view.snapshotMeta = { receivedAt: fileMtime(current.file), available: Boolean(current.snapshot), fresh: timestampFresh(current.snapshot?.generatedAt, new Date().toISOString()) };
    view.controls = readControlState(controlFile).sites;
    view.sites = view.sites.map(site => ({ ...site, control: view.controls[site.origin] ?? { policy: 'monitor', note: '', updatedAt: null } }));
    return view;
  }

  const server = http.createServer(async (request, response) => {
    for (const [key, value] of Object.entries(headers)) response.setHeader(key, value);
    response.setHeader('X-Request-Id', crypto.randomUUID());
    if ((request.url??'').startsWith('/v2/dry/')) {
      if(workerGateway)workerGateway.handle(request,response);
      else sendError(response,404,'not_found','worker transport disabled');
      return;
    }
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/session') {
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        sendError(response, 415, 'unsupported_media_type', 'session creation requires application/json');
        return;
      }
      let body;
      try { body = await readRequestBody(request); }
      catch (error) { sendError(response, 400, 'invalid_body', error.message); return; }
      const supplied = typeof body.token === 'string' ? body.token.trim() : '';
      if (!tokenMatches(supplied, adminToken)) {
        sendError(response, 401, 'unauthorized', 'dashboard authentication required');
        return;
      }
      const remember = body.remember === true;
      const sessionToken = createSessionToken(adminToken, { remember });
      sendJson(response, 200, { ok: true, remembered: body.remember === true }, {
        'Set-Cookie': sessionCookie(sessionToken, { remember, secure: trustProxyTls })
      });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/session/logout') {
      sendJson(response, 200, { ok: true }, {
        'Set-Cookie': sessionCookie('', { secure: trustProxyTls, clear: true })
      });
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
      if (requestUrl.pathname === '/api/overview') {
        sendJson(response, 200, { ...view, snapshot: { ...view.snapshot, status: view.status, readiness: view.readiness, snapshotMeta: view.snapshotMeta }, authConfigured: authRequired });
      } else if (requestUrl.pathname === '/api/summary') {
        sendJson(response, 200, { ...view.snapshot, status: view.status, ledgerRecords: view.ledger.length, readiness: view.readiness, snapshotMeta: view.snapshotMeta });
      } else if (requestUrl.pathname === '/api/tasks') {
        const query = (requestUrl.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
        const filterStatus = requestUrl.searchParams.get('status');
        const tasks = view.tasks.filter((task) => (!filterStatus || task.observedStatus === filterStatus) && (!query || `${task.origin} ${task.logicalSiteKey} ${task.accountRef ?? ''} ${task.taskId}`.toLowerCase().includes(query)));
        sendJson(response, 200, { tasks, total: tasks.length });
      } else if (requestUrl.pathname === '/api/sites') {
        const sites = view.sites.map((site) => ({ ...site, control: view.controls?.[site.origin] ?? { policy: 'monitor', note: '', updatedAt: null } }));
        sendJson(response, 200, { sites, total: sites.length });
      }
      else if (requestUrl.pathname === '/api/pt-status') sendJson(response, 200, view.ptStatus ?? { schemaVersion: 1, mode: 'status_observe_only', counts: { sites: 0, inLegacyPlan: 0, externalOnly: 0, fresh: 0, discrepancies: 0, supplementCandidates: 0, status: {} }, executionEnabled: false, sites: [] });
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
  let workerGateway=null;
  if(process.env.FABRIC_WORKER_REGISTRY_FILE){
    workerGateway=createWorkerGateway({registryFile:process.env.FABRIC_WORKER_REGISTRY_FILE,stateFile:process.env.FABRIC_WORKER_STATE_FILE??'/transport-data/server.sqlite',snapshotFile:path.join(process.env.FABRIC_DATA_DIR??'outputs','shadow-beta-snapshot.json')});
  }
  const instance = createDashboardServer({...options,workerGateway});
  if(workerGateway)instance.server.once('close',()=>workerGateway.close());
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
