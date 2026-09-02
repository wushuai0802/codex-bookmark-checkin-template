import crypto from 'node:crypto';

export const STATUS_VALUES = [
  'signed', 'already_signed', 'not_available', 'needs_attention',
  'deferred', 'login_required', 'failed'
];

export const LOGICAL_GROUPS = new Map([
  ['https://checkin.new-api.abrdns.com', 'abrdns-welfare'],
  ['https://new-api.abrdns.com', 'abrdns-welfare']
]);

export const SHARED_OAUTH_ORIGINS = new Set([
  'https://ai.venlacy.com', 'https://api.42w.shop', 'https://x666.me'
]);

export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('origin must be a non-empty string');
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`unsupported origin protocol: ${url.protocol}`);
  return `${url.protocol}//${url.host}`.toLowerCase();
}

export function logicalSiteKey(origin) {
  return normalizeOrigin(origin);
}

export function logicalGroup(origin) {
  const normalized = normalizeOrigin(origin);
  return LOGICAL_GROUPS.get(normalized) ?? null;
}

export function credentialGroup(origin) {
  const normalized = normalizeOrigin(origin);
  return SHARED_OAUTH_ORIGINS.has(normalized) ? 'linuxdo-shared' : null;
}

export function taskIdentity({ businessDate, logicalSiteKey: site, accountKey = 'site-default', actionType = 'checkin', scheduleOccurrence = 'daily' }) {
  for (const [name, value] of Object.entries({ businessDate, logicalSiteKey: site, accountKey, actionType, scheduleOccurrence })) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required for task identity`);
  }
  const tuple = [businessDate, site, accountKey, actionType, scheduleOccurrence].join('|');
  const digest = crypto.createHash('sha256').update(tuple, 'utf8').digest('hex');
  return { taskId: `task_${digest.slice(0, 24)}`, tuple };
}

export function planHash(tasks) {
  const canonical = tasks
    .map((task) => ({
      taskId: task.taskId, businessDate: task.businessDate,
      logicalSiteKey: task.logicalSiteKey, accountKey: task.accountKey,
      actionType: task.actionType, scheduleOccurrence: task.scheduleOccurrence
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function accountRef(accountKey) {
  if (!accountKey) return null;
  return `acct_${crypto.createHash('sha256').update(accountKey, 'utf8').digest('hex').slice(0, 16)}`;
}

export function classifyEvidence(result) {
  const source = result?.evidence?.source ?? (
    result?.status === 'signed' || result?.status === 'already_signed' ? 'legacy_authoritative' : 'none'
  );
  const sourceMap = {
    usage_log: 'usage_log', api: 'api', page_text: 'page_text',
    user_confirmation: 'user_confirmation', health_cache: 'health_cache',
    legacy_authoritative: 'legacy_authoritative', none: 'none'
  };
  return sourceMap[source] ?? 'legacy_authoritative';
}

export function redactText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')
    .replace(/(?:password|passwd|token|cookie|secret|authorization)\s*[:=]\s*[^\s,;]+/ig, '$1=<redacted>')
    .replace(/(?:\$|额度\s*)\s*\d[\d,.]*/g, '<amount-redacted>')
    .replace(/\b\d{5,}\b/g, '<number-redacted>')
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path-redacted>')
    .slice(0, 240);
}

export function assertUniqueTaskOwners(tasks) {
  const owners = new Map();
  for (const task of tasks) {
    if (owners.has(task.taskId)) throw new Error(`duplicate task definition or multiple execution owners for ${task.taskId}`);
    owners.set(task.taskId, task.executionOwner);
  }
  return true;
}
