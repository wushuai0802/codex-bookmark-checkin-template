import fs from 'node:fs';
import path from 'node:path';

export const shanghaiOpenDay = (value = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(value));

export function dailyOpenJournalPath(root) {
  return path.join(path.resolve(root), 'data', 'native-pt-opens.json');
}

export function dailyOpenLimitForOrigin(origin, config = {}) {
  const raw = config?.ptReadOnlyPolicies?.[origin]?.dailyOpenLimit;
  if (raw === undefined || raw === null) return null;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > 100) {
    throw Object.assign(Error('Invalid dailyOpenLimit in ptReadOnlyPolicies'), { code: 'PT_READONLY_UNSAFE' });
  }
  return raw;
}

export function readDailyOpenJournal(root) {
  const file = dailyOpenJournalPath(root);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, opens: [], notices: [] };
    throw error;
  }
  const value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    value.schemaVersion !== 1 || !Array.isArray(value.opens) ||
    (value.notices !== undefined && !Array.isArray(value.notices)) ||
    value.opens.some(entry => !entry || typeof entry !== 'object' || typeof entry.origin !== 'string' ||
      !validDay(entry.businessDate) || typeof entry.openId !== 'string' || !entry.openId) ||
    (value.notices ?? []).some(entry => !entry || typeof entry !== 'object' || typeof entry.origin !== 'string' ||
      !validDay(entry.businessDate) || typeof entry.code !== 'string')
  ) {
    throw Error('invalid native PT opens journal');
  }
  return { schemaVersion: 1, opens: value.opens, notices: value.notices ?? [] };
}

const VALID_OPEN_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function inspectDailyOpenState({ root, origin, config, openId, now = new Date() } = {}) {
  const businessDate = shanghaiOpenDay(now);
  const limit = dailyOpenLimitForOrigin(origin, config);
  const file = dailyOpenJournalPath(root);
  if (limit === null && !fs.existsSync(file)) {
    return {
      businessDate,
      limit: null,
      used: 0,
      remaining: null,
      limitReached: false,
      noticeRequired: false,
      exhausted: false,
      openIdValid: false,
    };
  }
  const journal = readDailyOpenJournal(root);
  const opensToday = journal.opens.filter(item => item.origin === origin && item.businessDate === businessDate);
  const noticeRequired = journal.notices.some(
    item => item.origin === origin && item.businessDate === businessDate && item.code === 'notice_acknowledgement_required',
  );
  const validFormatOpenId = typeof openId === 'string' && VALID_OPEN_ID_RE.test(openId) ? openId : null;
  const openIdValid = Boolean(validFormatOpenId && opensToday.some(item => item.openId === validFormatOpenId));
  const limitReached = limit !== null && opensToday.length >= limit && !openIdValid;
  return {
    businessDate,
    limit,
    used: opensToday.length,
    remaining: limit === null ? null : Math.max(0, limit - opensToday.length),
    limitReached,
    noticeRequired,
    exhausted: limitReached || noticeRequired,
    openIdValid,
  };
}

export function dailyOpenExhaustedOrigins({ root, config = {}, now = new Date() } = {}) {
  const exhausted = new Set();
  if (!root) return exhausted;
  const file = dailyOpenJournalPath(root);
  if (!fs.existsSync(file)) return exhausted;
  const businessDate = shanghaiOpenDay(now);
  const journal = readDailyOpenJournal(root);
  for (const notice of journal.notices) {
    if (notice.businessDate === businessDate && notice.code === 'notice_acknowledgement_required') {
      exhausted.add(notice.origin);
    }
  }
  for (const origin of Object.keys(config?.ptReadOnlyPolicies ?? {})) {
    let limit = null;
    try { limit = dailyOpenLimitForOrigin(origin, config); } catch { continue; }
    if (limit === null) continue;
    const used = journal.opens.filter(item => item.origin === origin && item.businessDate === businessDate).length;
    if (used >= limit) exhausted.add(origin);
  }
  return exhausted;
}
