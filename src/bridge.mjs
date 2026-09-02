#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  STATUS_VALUES, accountRef, assertUniqueTaskOwners, classifyEvidence,
  credentialGroup, logicalGroup, logicalSiteKey, planHash, redactText,
  taskIdentity, normalizeOrigin
} from './contracts.mjs';

const SENSITIVE_NAMES = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi', 'screenshot'
]);

function isSensitiveKey(key) {
  return SENSITIVE_NAMES.has(String(key).replaceAll('_', '').toLowerCase());
}

function readJson(file, { required = true } = {}) {
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`required legacy file is missing: ${file}`);
    return null;
  }
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid JSON in ${file}: ${error.message}`); }
  return parsed;
}

function businessDateFrom(value, fallback = new Date()) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value ? new Date(value) : fallback;
  if (Number.isNaN(date.getTime())) throw new Error(`invalid business date: ${value}`);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

function observedAt(result, fallback) {
  const candidate = result?.evidence?.createdAt ?? result?.confirmedAt ?? result?.lastConfirmedAt ?? fallback;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function latestResultPath(legacyRoot, schedulerState) {
  const runId = schedulerState?.lastRunId;
  if (typeof runId === 'string' && /^[A-Za-z0-9_-]+$/.test(runId)) {
    const candidate = path.join(legacyRoot, 'logs', runId, 'result.json');
    if (fs.existsSync(candidate)) return candidate;
  }
  const logsRoot = path.join(legacyRoot, 'logs');
  const candidates = [];
  if (fs.existsSync(logsRoot)) {
    for (const entry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(logsRoot, entry.name, 'result.json');
      if (fs.existsSync(candidate)) candidates.push({ candidate, mtime: fs.statSync(candidate).mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  if (!candidates[0]) throw new Error('no legacy result.json was found');
  return candidates[0].candidate;
}

function sourceCounts(plan) {
  const counts = {};
  for (const source of Array.isArray(plan?.sources) ? plan.sources : []) {
    for (const [name, count] of Object.entries(source?.counts ?? {})) {
      counts[name] = (counts[name] ?? 0) + (Number.isFinite(count) ? count : 0);
    }
  }
  return counts;
}

function safeFolderNames(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string').map((v) => v.slice(0, 80));
}

function evidenceReceipt(result, taskId, fallbackAt) {
  const status = STATUS_VALUES.includes(result?.status) ? result.status : 'failed';
  const source = classifyEvidence(result);
  const authoritative = ['signed', 'already_signed'].includes(status) && source !== 'none';
  return {
    schemaVersion: 1,
    taskId,
    status,
    observedAt: observedAt(result, fallbackAt),
    evidence: {
      source,
      authoritative,
      summary: redactText(result?.reason ?? ''),
      redacted: true
    }
  };
}

function healthSnapshot(health, generatedAt, maxAgeHours = 26) {
  const checked = health?.checkedAt ? new Date(health.checkedAt) : null;
  const generated = new Date(generatedAt);
  const ageHours = checked && !Number.isNaN(checked.getTime())
    ? Math.max(0, (generated.getTime() - checked.getTime()) / 3600000) : null;
  const fresh = ageHours !== null && ageHours <= maxAgeHours;
  return {
    healthy: health?.healthy === true,
    sourceCheckedAt: checked && !Number.isNaN(checked.getTime()) ? checked.toISOString() : null,
    freshness: { fresh, ageHours: ageHours === null ? null : Number(ageHours.toFixed(3)), maxAgeHours },
    reason: fresh ? (typeof health?.reason === 'string' ? redactText(health.reason) : null) : 'health source is stale or unavailable',
    failedCheckCount: Array.isArray(health?.failedChecks) ? health.failedChecks.length : null
  };
}

/**
 * Read and redact the legacy runner's latest state. This function performs no
 * writes and has no browser, network, or notification side effects.
 */
export function buildSnapshot({ legacyRoot, generatedAt = new Date().toISOString(), maxHealthAgeHours = 26 } = {}) {
  if (!legacyRoot) throw new Error('legacyRoot is required');
  const root = path.resolve(legacyRoot);
  const scheduler = readJson(path.join(root, 'data', 'scheduler-state.json'));
  const plan = readJson(path.join(root, 'data', 'last-valid-bookmark-plan.json'));
  const resultFile = latestResultPath(root, scheduler);
  const result = readJson(resultFile);
  const siteState = readJson(path.join(root, 'data', 'site-state.json'), { required: false });
  const health = readJson(path.join(root, 'health.json'), { required: false });
  if (!Array.isArray(result?.results) || result.results.length === 0) throw new Error('legacy result has no results array');

  const businessDate = businessDateFrom(scheduler?.lastRunDate ?? result?.finishedAt, new Date(generatedAt));
  const fallbackAt = result?.finishedAt && !Number.isNaN(new Date(result.finishedAt).getTime())
    ? new Date(result.finishedAt).toISOString() : generatedAt;
  const seenPerOrigin = new Map();
  const tasks = [];
  const receipts = [];
  const logicalSites = new Map();

  for (const entry of result.results) {
    const origin = normalizeOrigin(entry.origin);
    const occurrence = (seenPerOrigin.get(origin) ?? 0) + 1;
    seenPerOrigin.set(origin, occurrence);
    const providedAccountKey = typeof entry.accountKey === 'string' && entry.accountKey.trim() ? entry.accountKey.trim() : null;
    const accountKey = providedAccountKey ?? (occurrence === 1 ? 'site-default' : `site-default-${occurrence}`);
    const siteKey = logicalSiteKey(origin);
    const identity = taskIdentity({ businessDate, logicalSiteKey: siteKey, accountKey });
    const status = STATUS_VALUES.includes(entry.status) ? entry.status : 'failed';
    const task = {
      schemaVersion: 1,
      taskId: identity.taskId,
      businessDate,
      logicalSiteKey: siteKey,
      logicalGroup: logicalGroup(origin),
      origin,
      accountKey,
      accountRef: accountRef(accountKey),
      actionType: 'checkin',
      scheduleOccurrence: 'daily',
      executionOwner: 'legacy-checkin',
      executionMode: 'observe_only',
      observedStatus: status
    };
    tasks.push(task);
    receipts.push(evidenceReceipt(entry, identity.taskId, fallbackAt));
    if (!logicalSites.has(origin)) {
      const planTarget = Array.isArray(plan?.targets) ? plan.targets.find((target) => {
        try { return normalizeOrigin(target.origin) === origin; } catch { return false; }
      }) : null;
      logicalSites.set(origin, {
        logicalSiteKey: siteKey,
        logicalGroup: logicalGroup(origin),
        origin,
        title: typeof planTarget?.title === 'string' ? redactText(planTarget.title) : null,
        folderNames: safeFolderNames(planTarget?.folderNames),
        executionUnitCount: 0,
        credentialGroup: credentialGroup(origin)
      });
    }
    logicalSites.get(origin).executionUnitCount += 1;
  }
  assertUniqueTaskOwners(tasks);
  const statusCounts = Object.fromEntries(STATUS_VALUES.map((status) => [status, 0]));
  for (const receipt of receipts) statusCounts[receipt.status] += 1;
  const counts = {
    logicalSites: logicalSites.size,
    executionUnits: tasks.length,
    status: statusCounts,
    bookmarkSourceCounts: sourceCounts(plan)
  };
  const hash = planHash(tasks);
  const runId = typeof result.runId === 'string' ? result.runId : (typeof scheduler.lastRunId === 'string' ? scheduler.lastRunId : null);
  const snapshotId = `snap_${hash.slice(0, 24)}`;
  const stateUpdatedAt = siteState?.updatedAt && !Number.isNaN(new Date(siteState.updatedAt).getTime())
    ? new Date(siteState.updatedAt).toISOString() : null;
  return {
    schemaVersion: 1,
    snapshotId,
    generatedAt: new Date(generatedAt).toISOString(),
    businessDate,
    mode: 'shadow_read_only',
    planHash: hash,
    source: {
      system: 'legacy-checkin',
      runId,
      bookmarkPlanGeneratedAt: typeof plan?.generatedAt === 'string' ? plan.generatedAt : null,
      schedulerStateDate: typeof scheduler?.lastRunDate === 'string' ? scheduler.lastRunDate : null,
      executionComplete: result?.executionComplete === true,
      businessComplete: result?.businessComplete === true,
      pendingExternalCount: Number.isFinite(result?.pendingExternalCount) ? result.pendingExternalCount : null,
      siteStateUpdatedAt: stateUpdatedAt
    },
    counts,
    logicalSites: [...logicalSites.values()].sort((a, b) => a.origin.localeCompare(b.origin)),
    tasks: tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    receipts: receipts.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    health: healthSnapshot(health, generatedAt, maxHealthAgeHours)
  };
}

function assertNoSensitiveKeys(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) throw new Error(`sensitive field leaked at ${location}.${key}`);
    assertNoSensitiveKeys(child, `${location}.${key}`);
  }
  if (Array.isArray(value)) value.forEach((child, index) => assertNoSensitiveKeys(child, `${location}[${index}]`));
}

export function writeSnapshot(snapshot, outFile, legacyRoot) {
  const destination = path.resolve(outFile);
  const root = path.resolve(legacyRoot);
  if (destination === root || destination.startsWith(`${root}${path.sep}`)) {
    throw new Error('refusing to write inside the legacy project');
  }
  assertNoSensitiveKeys(snapshot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return destination;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--legacy-root') args.legacyRoot = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--generated-at') args.generatedAt = argv[++i];
    else if (token === '--max-health-age-hours') args.maxHealthAgeHours = Number(argv[++i]);
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log('Usage: node src/bridge.mjs --legacy-root <path> [--out <file>] [--generated-at <ISO>]');
      process.exit(0);
    }
    const legacyRoot = args.legacyRoot ?? process.env.CHECKIN_LEGACY_ROOT;
    if (!legacyRoot) throw new Error('provide --legacy-root or CHECKIN_LEGACY_ROOT');
    const snapshot = buildSnapshot({ legacyRoot, generatedAt: args.generatedAt, maxHealthAgeHours: args.maxHealthAgeHours ?? 26 });
    if (args.out) {
      const destination = writeSnapshot(snapshot, args.out, legacyRoot);
      console.log(`snapshot written: ${destination}`);
    } else {
      console.log(JSON.stringify(snapshot, null, 2));
    }
  } catch (error) {
    console.error(`bridge error: ${error.message}`);
    process.exitCode = 1;
  }
}
