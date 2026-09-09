import crypto from 'node:crypto';

export const STATUS_VALUES = [
  'signed', 'already_signed', 'not_available', 'needs_attention',
  'deferred', 'login_required', 'failed', 'not_started'
];

// The all-zero value is reserved as a missing-plan sentinel and must never
// cross an execution boundary as if it were a real fingerprint.
export const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const ZERO_PLAN_HASH_PATTERN = /^0{64}$/;

export function isPlanHash(value) {
  return typeof value === 'string'
    && PLAN_HASH_PATTERN.test(value)
    && !ZERO_PLAN_HASH_PATTERN.test(value);
}

export function assertPlanHash(value, name = 'planHash') {
  if (!isPlanHash(value)) throw new Error(`${name} must be a non-zero SHA-256 hash`);
  return value;
}

export const LOGICAL_GROUPS = new Map([
  ['https://checkin.new-api.abrdns.com', 'abrdns-welfare'],
  ['https://new-api.abrdns.com', 'abrdns-welfare']
]);

export const SHARED_OAUTH_ORIGINS = new Set([
  'https://ai.venlacy.com', 'https://x666.me'
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

export function planUnitIdentity({ logicalSiteKey: site, accountKey = 'site-default', actionType = 'checkin', scheduleOccurrence = 'daily' }) {
  for (const [name, value] of Object.entries({ logicalSiteKey: site, accountKey, actionType, scheduleOccurrence })) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required for plan unit identity`);
  }
  const tuple = [site, accountKey, actionType, scheduleOccurrence].join('|');
  const digest = crypto.createHash('sha256').update(tuple, 'utf8').digest('hex');
  return { planUnitId: `unit_${digest.slice(0, 24)}`, tuple };
}

export function taskIdentity({ businessDate, logicalSiteKey: site, accountKey = 'site-default', actionType = 'checkin', scheduleOccurrence = 'daily' }) {
  for (const [name, value] of Object.entries({ businessDate, logicalSiteKey: site, accountKey, actionType, scheduleOccurrence })) {
    if (typeof value !== 'string' || !value) throw new Error(`${name} is required for task identity`);
  }
  const { planUnitId } = planUnitIdentity({ logicalSiteKey: site, accountKey, actionType, scheduleOccurrence });
  const tuple = [businessDate, planUnitId].join('|');
  const digest = crypto.createHash('sha256').update(tuple, 'utf8').digest('hex');
  return { taskId: `task_${digest.slice(0, 24)}`, planUnitId, tuple };
}

export function planHash(tasks) {
  const canonical = tasks
    .map((task) => ({
      planUnitId: task.planUnitId ?? planUnitIdentity(task).planUnitId,
      logicalSiteKey: task.logicalSiteKey, accountKey: task.accountKey,
      actionType: task.actionType, scheduleOccurrence: task.scheduleOccurrence
    }))
    .sort((a, b) => a.planUnitId.localeCompare(b.planUnitId));
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

export function accountRef(accountKey) {
  if (!accountKey) return null;
  return `acct_${crypto.createHash('sha256').update(accountKey, 'utf8').digest('hex').slice(0, 16)}`;
}

export function classifyEvidence(result) {
  const source = result?.evidence?.source ?? 'none';
  const sourceMap = {
    usage_log: 'usage_log', api: 'api', page_text: 'page_text',
    user_confirmation: 'user_confirmation', health_cache: 'health_cache',
    legacy_authoritative: 'legacy_authoritative', none: 'none'
  };
  const apiSources = ['new_api_checkin_calendar', 'new_api_checkin_status', 'new_api_checkin_action', 'new_api_captcha', 'oauth_api_action_status', 'oauth_callback', 'sign_in_response', 'sign_in_already_claimed_contract'];
  if (source === 'cached_confirmation') return 'health_cache';
  if (source === 'configuration' || source === 'operator_confirmation') return 'user_confirmation';
  return sourceMap[source] ?? (apiSources.includes(source) ? 'api' : 'none');
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
