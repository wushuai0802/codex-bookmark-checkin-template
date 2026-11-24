import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ptFailureMessages } from './checkin-contract.generated.mjs';
import {
  dailyOpenJournalPath,
  dailyOpenLimitForOrigin,
  inspectDailyOpenState,
  readDailyOpenJournal,
  shanghaiOpenDay,
} from './pt-daily-open-state.mjs';
import { nextShanghaiTimeNextDay } from './retry-policy.mjs';
import { acquireRunLock, releaseRunLock } from './run-lock.mjs';

const MAX_RETENTION_DAYS = 14;
const MAX_JOURNAL_ENTRIES = 4096;

function readConfig(root, config) {
  if (config) return config;
  const file = path.join(path.resolve(root), 'config', 'config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJournalAtomic(root, journal) {
  const file = dailyOpenJournalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(journal, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function pruneEntries(entries, today) {
  const cutoffMs = Date.parse(`${today}T00:00:00Z`) - MAX_RETENTION_DAYS * 86_400_000;
  const cutoffDay = Number.isFinite(cutoffMs) ? new Date(cutoffMs).toISOString().slice(0, 10) : today;
  const recent = entries.filter(item => item.businessDate >= cutoffDay || item.businessDate === today);
  if (recent.length <= MAX_JOURNAL_ENTRIES) return recent;
  const todayEntries = recent.filter(item => item.businessDate === today);
  const olderEntries = recent.filter(item => item.businessDate !== today);
  return [...olderEntries.slice(-Math.max(0, MAX_JOURNAL_ENTRIES - todayEntries.length)), ...todayEntries];
}

export function dailyOpenLimitDecision(config = {}, now = new Date()) {
  const schedule = typeof config?.schedule === 'string' ? config.schedule : '08:05';
  return {
    status: 'deferred',
    failureCode: 'daily_open_limit',
    submissionAttempted: false,
    nativeGate: true,
    retryable: false,
    retryableLoginRecovery: false,
    retryExhaustedForDay: true,
    nextEligibleAt: nextShanghaiTimeNextDay(schedule, now),
    reason: ptFailureMessages.daily_open_limit,
  };
}

export function noticeAcknowledgementDecision() {
  return {
    status: 'needs_attention',
    failureCode: 'notice_acknowledgement_required',
    submissionAttempted: false,
    nativeGate: true,
    retryable: false,
    retryableLoginRecovery: false,
    reason: ptFailureMessages.notice_acknowledgement_required,
  };
}

export function checkDailyOpenGate({ root, origin, config, openId, clock = () => new Date() } = {}) {
  const now = clock();
  const loadedConfig = readConfig(root, config);
  const state = inspectDailyOpenState({ root, origin, config: loadedConfig, openId, now });
  if (state.limitReached) {
    return { allowed: false, ...state, decision: dailyOpenLimitDecision(loadedConfig, now) };
  }
  if (state.noticeRequired && !state.openIdValid) {
    return { allowed: false, ...state, decision: noticeAcknowledgementDecision() };
  }
  return { allowed: true, ...state };
}

/**
 * Persist a page-open slot before launching the browser so a mid-open kill
 * still counts against the site's Shanghai business-day budget.
 */
export async function acquireDailyOpen({
  root,
  origin,
  config,
  source = 'native',
  openId,
  clock = () => new Date(),
  acquire = acquireRunLock,
  release = releaseRunLock,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const loadedConfig = readConfig(resolvedRoot, config);
  const now = clock();
  const limit = dailyOpenLimitForOrigin(origin, loadedConfig);
  const file = dailyOpenJournalPath(resolvedRoot);
  if (limit === null && !fs.existsSync(file)) {
    return { allowed: true, openId: null, limit: null, used: 0, remaining: null, businessDate: shanghaiOpenDay(now) };
  }
  const lock = await acquire(path.join(resolvedRoot, 'tmp', 'native-pt-opens.lock'));
  try {
    const currentNow = clock();
    const state = inspectDailyOpenState({ root: resolvedRoot, origin, config: loadedConfig, openId, now: currentNow });
    if (state.limitReached) {
      return { allowed: false, ...state, decision: dailyOpenLimitDecision(loadedConfig, currentNow) };
    }
    if (state.noticeRequired && !state.openIdValid) {
      return { allowed: false, ...state, decision: noticeAcknowledgementDecision() };
    }
    if (state.openIdValid) {
      return { allowed: true, openId, reused: true, ...state };
    }
    if (limit === null) {
      return { allowed: true, openId: null, ...state };
    }
    const journal = readDailyOpenJournal(resolvedRoot);
    const issuedId = crypto.randomUUID();
    const safeSource = String(source ?? 'native').replace(/[^a-z0-9_-]/gi, '_').slice(0, 40) || 'native';
    journal.opens.push({
      openId: issuedId,
      origin,
      businessDate: state.businessDate,
      openedAt: currentNow.toISOString(),
      source: safeSource,
    });
    journal.opens = pruneEntries(journal.opens, state.businessDate);
    journal.notices = pruneEntries(journal.notices, state.businessDate);
    writeJournalAtomic(resolvedRoot, journal);
    return {
      allowed: true,
      openId: issuedId,
      businessDate: state.businessDate,
      limit,
      used: state.used + 1,
      remaining: Math.max(0, limit - (state.used + 1)),
    };
  } finally {
    await release(lock).catch(() => {});
  }
}

export async function recordDailyNoticeGate({
  root,
  origin,
  clock = () => new Date(),
  acquire = acquireRunLock,
  release = releaseRunLock,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const lock = await acquire(path.join(resolvedRoot, 'tmp', 'native-pt-opens.lock'));
  try {
    const now = clock();
    const businessDate = shanghaiOpenDay(now);
    const journal = readDailyOpenJournal(resolvedRoot);
    if (!journal.notices.some(item => item.origin === origin && item.businessDate === businessDate && item.code === 'notice_acknowledgement_required')) {
      journal.notices.push({
        origin,
        businessDate,
        recordedAt: now.toISOString(),
        code: 'notice_acknowledgement_required',
      });
      journal.opens = pruneEntries(journal.opens, businessDate);
      journal.notices = pruneEntries(journal.notices, businessDate);
      writeJournalAtomic(resolvedRoot, journal);
    }
    return { businessDate, recorded: true };
  } finally {
    await release(lock).catch(() => {});
  }
}

async function runCli(args) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let mode = 'check', origin, source = 'cli', openId;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--acquire') mode = 'acquire';
    else if (args[i] === '--check') mode = 'check';
    else if (args[i] === '--origin') origin = args[++i];
    else if (args[i] === '--source') source = args[++i];
    else if (args[i] === '--open-id') openId = args[++i];
    else throw Error('invalid pt-daily-open-limit argument');
  }
  if (!origin) throw Error('origin is required');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) {
    throw Error('unsafe origin');
  }
  const result = mode === 'acquire'
    ? await acquireDailyOpen({ root, origin, source, openId })
    : checkDailyOpenGate({ root, origin, openId });
  console.log(JSON.stringify(result));
  if (!result.allowed) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli(process.argv.slice(2));
  } catch {
    console.log(JSON.stringify({ allowed: false, decision: { status: 'unconfirmed', failureCode: 'native_readback_unavailable', submissionAttempted: false } }));
    process.exitCode = 2;
  }
}
