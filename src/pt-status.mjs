import crypto from 'node:crypto';
import { normalizeOrigin, redactText } from './contracts.mjs';

export const PT_STATUS_VALUES = [
  'signed', 'already_signed', 'not_signed', 'unknown', 'login_required',
  'unreachable', 'needs_attention', 'not_available', 'failed'
];

const SOURCE_VALUES = new Set(['harvest', 'legacy-checkin', 'manual', 'v2-observer', 'other']);
const EVIDENCE_VALUES = new Set(['api', 'page_text', 'usage_log', 'user_confirmation', 'manual', 'health_cache', 'harvest', 'none']);
const SENSITIVE_NAMES = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi',
  'screenshot', 'accountid', 'accountlabel'
]);
const STATUS_ALIASES = new Map([
  ['checked_in', 'signed'], ['checkin_success', 'signed'],
  ['not_checked_in', 'not_signed'], ['missing', 'not_signed'],
  ['pending', 'unknown'], ['timeout', 'unreachable']
]);
const SOURCE_PRIORITY = new Map([
  ['harvest', 4], ['v2-observer', 3], ['legacy-checkin', 2], ['manual', 1], ['other', 0]
]);

function sensitiveKey(key) {
  return SENSITIVE_NAMES.has(String(key).replaceAll('_', '').toLowerCase());
}

function assertNoSensitiveFields(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) throw new Error(`sensitive field leaked at ${location}.${key}`);
    assertNoSensitiveFields(child, `${location}.${key}`);
  }
}

function parseIso(value, fallback) {
  const date = new Date(value ?? fallback);
  return Number.isNaN(date.getTime()) ? new Date(fallback).toISOString() : date.toISOString();
}

function normalizeStatus(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const status = STATUS_ALIASES.get(normalized) ?? normalized;
  return PT_STATUS_VALUES.includes(status) ? status : 'unknown';
}

function normalizeSource(value, fallback = 'other') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SOURCE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeEvidenceSource(value, fallback = 'none') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EVIDENCE_VALUES.has(normalized) ? normalized : fallback;
}

function normalizeOriginForStatus(value) {
  if (typeof value !== 'string' || value.length > 255) throw new Error('PT status origin must be a short URL');
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('PT status origin must be HTTPS without credentials');
  }
  return normalizeOrigin(value);
}

function normalizeAccountRef(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^acct_[a-f0-9]{16}$/.test(value)) {
    throw new Error('PT status accountRef is invalid');
  }
  return value;
}

function ageFor(observedAt, generatedAt, maxAgeHours) {
  const observed = new Date(observedAt).getTime();
  const generated = new Date(generatedAt).getTime();
  if (!Number.isFinite(observed) || !Number.isFinite(generated)) return { fresh: false, ageHours: null };
  const ageHours = (generated - observed) / 3600000;
  const fresh = ageHours >= 0 && ageHours <= maxAgeHours;
  return { fresh, ageHours: Number(Math.max(0, ageHours).toFixed(3)) };
}

function evidenceFor(input, status) {
  const evidence = input?.evidence && typeof input.evidence === 'object' ? input.evidence : {};
  const authoritative = evidence.authoritative === true;
  const source = normalizeEvidenceSource(evidence.source, 'none');
  const summary = redactText(evidence.summary ?? input?.reason ?? '');
  return {
    source,
    authoritative,
    summary,
    redacted: true,
    statusVerified: authoritative && ['signed', 'already_signed', 'not_signed'].includes(status)
  };
}

function stableSiteRef(origin, accountRef) {
  const digest = crypto.createHash('sha256').update(`${origin}|${accountRef ?? 'site-default'}`, 'utf8').digest('hex');
  return `pt_${digest.slice(0, 16)}`;
}

function displayNameFor(target, origin) {
  const candidate = target?.displayName ?? target?.title ?? target?.name;
  if (typeof candidate === 'string' && candidate.trim()) return redactText(candidate).slice(0, 80);
  return origin.replace(/^https:\/\//, '');
}

function isPtTarget(target) {
  const folders = Array.isArray(target?.folderNames) ? target.folderNames : [];
  return folders.some((folder) => typeof folder === 'string' && /pt/i.test(folder));
}

function normalizeObservation(input, {
  defaultSource = 'other', generatedAt, maxAgeHours = 26,
  inLegacyPlan = false, displayName = null, fallbackObservedAt = generatedAt
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('PT status observation must be an object');
  assertNoSensitiveFields(input);
  const origin = normalizeOriginForStatus(input.origin);
  const source = normalizeSource(input.source, defaultSource);
  const status = normalizeStatus(input.status);
  const observedAt = input.observedAt === null ? null : parseIso(input.observedAt, fallbackObservedAt);
  const freshness = ageFor(observedAt, generatedAt, maxAgeHours);
  const accountRef = normalizeAccountRef(input.accountRef);
  const evidence = evidenceFor(input, status);
  const supplementCandidate = status === 'not_signed' && evidence.statusVerified && freshness.fresh;
  return {
    source,
    origin,
    displayName: displayName ?? displayNameFor(input, origin),
    accountRef,
    status,
    observedAt,
    freshness,
    evidence,
    inLegacyPlan: inLegacyPlan || input.inLegacyPlan === true,
    managedBy: normalizeSource(input.managedBy, source),
    supplementCandidate,
    supplementAction: supplementCandidate ? 'manual_review_only' : 'none'
  };
}

export function normalizePtStatusReport(report, {
  generatedAt = new Date().toISOString(), businessDate = null, maxAgeHours = 26
} = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('PT status report must be an object');
  assertNoSensitiveFields(report);
  const reportGeneratedAt = parseIso(report.generatedAt, generatedAt);
  const source = normalizeSource(report.source, 'other');
  const sites = Array.isArray(report.sites) ? report.sites : [];
  const unique = new Map();
  for (const item of sites) {
    const observation = normalizeObservation(item, {
      defaultSource: source,
      generatedAt,
      maxAgeHours,
      displayName: displayNameFor(item, normalizeOriginForStatus(item.origin))
    });
    const key = `${observation.origin}|${observation.accountRef ?? 'site-default'}|${observation.source}`;
    const previous = unique.get(key);
    if (!previous || new Date(observation.observedAt) >= new Date(previous.observedAt)) unique.set(key, observation);
  }
  return {
    schemaVersion: 1,
    generatedAt: reportGeneratedAt,
    businessDate: typeof report.businessDate === 'string' ? report.businessDate : businessDate,
    mode: 'status_observe_only',
    source,
    sites: [...unique.values()].sort((a, b) => `${a.origin}|${a.accountRef ?? ''}`.localeCompare(`${b.origin}|${b.accountRef ?? ''}`))
  };
}

function betterObservation(a, b) {
  const time = new Date(a.observedAt) - new Date(b.observedAt);
  if (time !== 0) return time > 0 ? a : b;
  return (SOURCE_PRIORITY.get(a.source) ?? 0) >= (SOURCE_PRIORITY.get(b.source) ?? 0) ? a : b;
}

function mergeSiteObservations(observations, target) {
  const ordered = [...observations].sort((a, b) => new Date(b.observedAt) - new Date(a.observedAt));
  const effective = ordered.reduce((current, item) => current ? betterObservation(current, item) : item, null);
  const bySource = new Map();
  for (const item of ordered) {
    const previous = bySource.get(item.source);
    if (!previous || new Date(item.observedAt) > new Date(previous.observedAt)) bySource.set(item.source, item);
  }
  const sourceStatuses = [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)).map((item) => ({
    source: item.source, status: item.status, observedAt: item.observedAt,
    fresh: item.freshness.fresh, authoritative: item.evidence.authoritative
  }));
  const distinctStatuses = new Set(sourceStatuses.filter((item) => item.authoritative).map((item) => item.status));
  const supplementCandidate = distinctStatuses.size <= 1 && effective?.supplementCandidate === true;
  return {
    siteRef: stableSiteRef(ordered[0].origin, ordered[0].accountRef),
    origin: ordered[0].origin,
    displayName: ordered.find((item) => item.displayName)?.displayName ?? displayNameFor(target, ordered[0].origin),
    accountRef: ordered[0].accountRef,
    inLegacyPlan: ordered.some((item) => item.inLegacyPlan),
    managedBy: [...new Set(ordered.map((item) => item.managedBy))].sort().join(' + '),
    effective: effective ? {
      source: effective.source, status: effective.status, observedAt: effective.observedAt,
      fresh: effective.freshness.fresh, authoritative: effective.evidence.authoritative,
      evidence: effective.evidence
    } : null,
    sourceStatuses,
    discrepancy: distinctStatuses.size > 1,
    supplementCandidate,
    supplementAction: supplementCandidate ? 'manual_review_only' : 'none',
    observations: ordered.map((item) => ({
      source: item.source, status: item.status, observedAt: item.observedAt,
      fresh: item.freshness.fresh, authoritative: item.evidence.authoritative,
      evidence: item.evidence
    }))
  };
}

export function buildPtStatus({
  tasks = [], receipts = [], planTargets = [], externalReport = null, monitorCatalog = null,
  generatedAt = new Date().toISOString(), businessDate = null, maxAgeHours = 26
} = {}) {
  const report = externalReport
    ? normalizePtStatusReport(externalReport, { generatedAt, businessDate, maxAgeHours })
    : null;
  const targets = new Map();
  const stableFallbackAt = businessDate ? `${businessDate}T00:00:00.000Z` : generatedAt;
  for (const target of planTargets) {
    if (!isPtTarget(target)) continue;
    try {
      const origin = normalizeOriginForStatus(target.origin);
      targets.set(origin, { ...target, origin });
    } catch { /* Invalid bookmark targets are handled by the main bridge. */ }
  }
  const receiptByTask = new Map(receipts.map((receipt) => [receipt.taskId, receipt]));
  const grouped = new Map();
  const add = (item) => {
    const key = `${item.origin}|${item.accountRef ?? 'site-default'}`;
    const list = grouped.get(key) ?? [];
    list.push(item);
    grouped.set(key, list);
  };
  for (const task of tasks) {
    if (!targets.has(task.origin)) continue;
    const receipt = receiptByTask.get(task.taskId);
    add(normalizeObservation({
      origin: task.origin,
      accountRef: task.accountRef,
      status: task.observedStatus,
      observedAt: task.observedStatus === 'not_started' ? null : receipt?.observedAt ?? generatedAt,
      source: 'legacy-checkin',
      managedBy: 'legacy-checkin',
      inLegacyPlan: true,
      evidence: receipt?.evidence ?? { source: 'none', authoritative: false, summary: '' }
    }, { generatedAt, maxAgeHours, inLegacyPlan: true, fallbackObservedAt: stableFallbackAt, displayName: displayNameFor(targets.get(task.origin), task.origin) }));
  }
  for (const [origin, target] of targets) {
    if ([...grouped.keys()].some((key) => key.startsWith(`${origin}|`))) continue;
    add(normalizeObservation({
      origin, status: 'unknown', source: 'legacy-checkin', managedBy: 'legacy-checkin',
      inLegacyPlan: true, observedAt: generatedAt,
      evidence: { source: 'none', authoritative: false, summary: '未出现在最近一次 v1 结果中' }
    }, { generatedAt, maxAgeHours, inLegacyPlan: true, fallbackObservedAt: stableFallbackAt, displayName: displayNameFor(target, origin) }));
  }
  const monitorSites = new Map((monitorCatalog?.sites ?? []).map(site => [normalizeOriginForStatus(site.origin), site]));
  for (const item of report?.sites ?? []) {
    if (monitorCatalog && !monitorSites.has(item.origin) && !targets.has(item.origin)) continue;
    const matches = tasks.filter(task => task.origin === item.origin);
    // An external default-account observation may join only a single known account.
    if (!item.accountRef && matches.length === 1) item.accountRef = matches[0].accountRef;
    add(item);
  }
  for (const [origin, site] of monitorSites) {
    if ([...grouped.keys()].some(key => key.startsWith(`${origin}|`))) continue;
    add(normalizeObservation({ origin, displayName: site.displayName, source: 'v2-observer',
      status: 'unknown', observedAt: null, evidence: { source: 'none', authoritative: false,
        summary: '已纳入书签监测，暂无今日签到证据' }
    }, { generatedAt, maxAgeHours }));
  }
  // A catalog is inventory, never evidence. Success must belong to this business day.
  for (const items of grouped.values()) for (const item of items) {
    const observedDay = item.observedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(item.observedAt)) : null;
    if (!item.observedAt || (businessDate && observedDay !== businessDate)) {
      item.freshness.fresh = false;
      item.supplementCandidate = false;
    }
  }
  const sites = [...grouped.values()].map((items) => mergeSiteObservations(items, targets.get(items[0].origin))).sort((a, b) => a.origin.localeCompare(b.origin) || (a.accountRef ?? '').localeCompare(b.accountRef ?? ''));
  const status = Object.fromEntries(PT_STATUS_VALUES.map((value) => [value, 0]));
  for (const site of sites) status[site.effective?.status ?? 'unknown'] += 1;
  return {
    schemaVersion: 1,
    generatedAt: new Date(generatedAt).toISOString(),
    businessDate,
    mode: 'status_observe_only',
    sources: [...new Set(sites.flatMap((site) => site.sourceStatuses.map((item) => item.source)))].sort(),
    counts: {
      sites: sites.length,
      inLegacyPlan: sites.filter((site) => site.inLegacyPlan).length,
      externalOnly: sites.filter((site) => !site.inLegacyPlan).length,
      fresh: sites.filter((site) => site.effective?.fresh).length,
      discrepancies: sites.filter((site) => site.discrepancy).length,
      supplementCandidates: sites.filter((site) => site.supplementCandidate).length,
      status
    },
    executionEnabled: false,
    sites
  };
}
