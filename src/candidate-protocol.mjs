import crypto from 'node:crypto';
import { normalizeOrigin, planHash, STATUS_VALUES } from './contracts.mjs';

const TERMINAL_STATUSES = new Set(['signed', 'already_signed']);
const CAPABILITIES = new Set(['browser_checkin', 'page_evidence', 'api_evidence', 'image_challenge']);
const EXECUTION_MODES = new Set(['dry_run', 'execute']);
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi', 'screenshot'
]);

function digest(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function assertString(value, name, { pattern = null, maxLength = 240 } = {}) {
  if (typeof value !== 'string' || !value || value.length > maxLength) throw new Error(`${name} is invalid`);
  if (pattern && !pattern.test(value)) throw new Error(`${name} has an invalid format`);
  return value;
}

function assertNoSensitiveFields(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.replaceAll('_', '').toLowerCase())) throw new Error(`sensitive field leaked at ${location}.${key}`);
    assertNoSensitiveFields(child, `${location}.${key}`);
  }
}

function asIso(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be an ISO date-time`);
  return date.toISOString();
}

export function idempotencyKey({ taskId, businessDate, actionType = 'checkin' } = {}) {
  assertString(taskId, 'taskId', { pattern: /^task_[a-f0-9]{24}$/ });
  assertString(businessDate, 'businessDate', { pattern: /^\d{4}-\d{2}-\d{2}$/, maxLength: 10 });
  assertString(actionType, 'actionType', { pattern: /^[a-z_]{1,40}$/ });
  return `idem_${digest(`${businessDate}|${taskId}|${actionType}`)}`;
}

export function createLease({ taskId, planHash: hash, owner, issuedAt = new Date().toISOString(), ttlSeconds = 300 } = {}) {
  assertString(taskId, 'taskId', { pattern: /^task_[a-f0-9]{24}$/ });
  assertString(hash, 'planHash', { pattern: /^[a-f0-9]{64}$/, maxLength: 64 });
  assertString(owner, 'owner', { pattern: /^worker_[A-Za-z0-9_-]{8,80}$/ });
  const issued = asIso(issuedAt, 'issuedAt');
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 900) throw new Error('ttlSeconds must be between 30 and 900');
  const leaseId = `lease_${digest(`${taskId}|${hash}|${owner}|${issued}`)}`;
  const lease = {
    schemaVersion: 1,
    leaseId,
    taskId,
    planHash: hash,
    owner,
    issuedAt: issued,
    expiresAt: new Date(new Date(issued).getTime() + ttlSeconds * 1000).toISOString(),
    state: 'active',
    singleUse: true
  };
  assertNoSensitiveFields(lease);
  return lease;
}

export function leaseActive(lease, { now = new Date().toISOString() } = {}) {
  if (!lease || lease.state !== 'active') return false;
  const current = new Date(now).getTime();
  const expires = new Date(lease.expiresAt).getTime();
  return Number.isFinite(current) && Number.isFinite(expires) && expires > current;
}

export function validateWorkerCapability(worker, { now = new Date().toISOString(), maxHeartbeatAgeMinutes = 10 } = {}) {
  const errors = [];
  try { assertString(worker?.workerId, 'workerId', { pattern: /^worker_[A-Za-z0-9_-]{8,80}$/ }); } catch (error) { errors.push(error.message); }
  if (!['windows', 'linux'].includes(worker?.platform)) errors.push('platform is invalid');
  if (!Array.isArray(worker?.capabilities) || new Set(worker.capabilities).size !== worker.capabilities.length) errors.push('capabilities must be unique');
  else if (!worker.capabilities.every((capability) => CAPABILITIES.has(capability))) errors.push('capabilities contain an unsupported value');
  if (!Array.isArray(worker?.allowedOrigins) || new Set(worker.allowedOrigins).size !== worker.allowedOrigins.length) errors.push('allowedOrigins must be unique');
  else {
    for (const origin of worker.allowedOrigins) {
      try {
        if (normalizeOrigin(origin) !== origin) errors.push('allowedOrigins must contain normalized origins');
      } catch { errors.push('allowedOrigins contain an invalid origin'); }
    }
  }
  if (!Array.isArray(worker?.executionModes) || new Set(worker.executionModes).size !== worker.executionModes.length) errors.push('executionModes must be unique');
  else if (!worker.executionModes.every((mode) => EXECUTION_MODES.has(mode))) errors.push('executionModes contain an unsupported value');
  if (worker?.profileIsolation !== true) errors.push('profileIsolation is required');
  let heartbeat;
  try { heartbeat = new Date(worker?.heartbeatAt).getTime(); } catch { heartbeat = Number.NaN; }
  const current = new Date(now).getTime();
  if (!Number.isFinite(heartbeat) || !Number.isFinite(current) || current - heartbeat > maxHeartbeatAgeMinutes * 60_000 || heartbeat > current + 60_000) errors.push('worker heartbeat is stale');
  return { valid: errors.length === 0, errors };
}

export function evaluateCandidateDispatch({ snapshot, taskId, worker, requestedMode = 'dry_run', now = new Date().toISOString(), allowExecute = false } = {}) {
  const task = (snapshot?.tasks ?? []).find((candidate) => candidate.taskId === taskId);
  const reasons = [];
  if (!task) reasons.push('task_not_in_snapshot');
  if (!['dry_run', 'execute'].includes(requestedMode)) reasons.push('unsupported_requested_mode');
  if (snapshot?.mode !== 'shadow_read_only') reasons.push('snapshot_mode_not_shadow');
  if (snapshot?.planHash !== planHash(snapshot?.tasks ?? [])) reasons.push('plan_hash_invalid');
  if (snapshot?.health?.freshness?.fresh !== true) reasons.push('health_stale');
  if (task && TERMINAL_STATUSES.has(task.observedStatus)) reasons.push('legacy_result_terminal');
  const workerCheck = validateWorkerCapability(worker, { now });
  if (!workerCheck.valid) reasons.push('worker_invalid');
  if (['dry_run', 'execute'].includes(requestedMode) && worker?.executionModes?.includes(requestedMode) !== true) reasons.push('worker_mode_not_supported');
  if (task && worker?.allowedOrigins?.includes(task.origin) !== true) reasons.push('origin_not_allowlisted');
  if (requestedMode === 'execute' && !allowExecute) reasons.push('candidate_execution_disabled');
  if (requestedMode === 'execute' && task?.executionOwner !== 'v2-worker') reasons.push('execution_owner_not_cut_over');
  const denied = reasons.length > 0;
  return {
    schemaVersion: 1,
    evaluatedAt: asIso(now, 'now'),
    taskId: taskId ?? null,
    workerId: worker?.workerId ?? null,
    requestedMode,
    decision: denied ? 'deny' : requestedMode === 'dry_run' ? 'dry_run' : 'execute',
    executable: !denied && requestedMode === 'execute',
    leaseGranted: false,
    reasons
  };
}

export function createTaskEnvelope({ snapshot, task, lease, mode = 'dry_run' } = {}) {
  if (!snapshot || snapshot.mode !== 'shadow_read_only') throw new Error('snapshot must be shadow_read_only');
  if (snapshot.planHash !== planHash(snapshot.tasks ?? [])) throw new Error('snapshot plan hash is invalid');
  if (!task || task.taskId !== lease?.taskId) throw new Error('lease does not match task');
  if (lease.planHash !== snapshot.planHash || lease.state !== 'active') throw new Error('lease does not match snapshot');
  if (!['dry_run', 'execute'].includes(mode)) throw new Error('mode is invalid');
  const envelope = {
    schemaVersion: 1,
    envelopeId: `envelope_${digest(`${task.taskId}|${lease.leaseId}|${mode}`)}`,
    taskId: task.taskId,
    businessDate: task.businessDate,
    planHash: snapshot.planHash,
    idempotencyKey: idempotencyKey({ taskId: task.taskId, businessDate: task.businessDate, actionType: task.actionType }),
    lease,
    target: {
      origin: task.origin,
      logicalSiteKey: task.logicalSiteKey,
      accountKey: task.accountKey,
      actionType: task.actionType
    },
    mode
  };
  assertNoSensitiveFields(envelope);
  return envelope;
}

export function createReceipt({ taskId, leaseId, workerId, businessDate, status, observedAt = new Date().toISOString(), evidence, executionMode = 'dry_run', attempt = 1 } = {}) {
  assertString(taskId, 'taskId', { pattern: /^task_[a-f0-9]{24}$/ });
  assertString(leaseId, 'leaseId', { pattern: /^lease_[a-f0-9]{24}$/ });
  assertString(workerId, 'workerId', { pattern: /^worker_[A-Za-z0-9_-]{8,80}$/ });
  assertString(businessDate, 'businessDate', { pattern: /^\d{4}-\d{2}-\d{2}$/, maxLength: 10 });
  if (!STATUS_VALUES.includes(status)) throw new Error('status is invalid');
  if (!['dry_run', 'execute'].includes(executionMode)) throw new Error('executionMode is invalid');
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 8) throw new Error('attempt is invalid');
  if (!evidence || typeof evidence !== 'object') throw new Error('evidence is required');
  const authoritative = ['signed', 'already_signed'].includes(status);
  if (authoritative && evidence.authoritative !== true) throw new Error('successful receipt must be authoritative');
  if (evidence.redacted !== true) throw new Error('receipt evidence must be redacted');
  const receipt = {
    schemaVersion: 1,
    receiptId: `receipt_${digest(`${taskId}|${leaseId}|${observedAt}|${attempt}`)}`,
    idempotencyKey: idempotencyKey({ taskId, businessDate }),
    taskId,
    leaseId,
    workerId,
    businessDate,
    status,
    observedAt: asIso(observedAt, 'observedAt'),
    executionMode,
    attempt,
    evidence: {
      source: assertString(evidence.source, 'evidence.source', { maxLength: 40 }),
      authoritative: evidence.authoritative === true,
      summary: assertString(evidence.summary ?? '', 'evidence.summary', { maxLength: 240 }),
      redacted: true
    }
  };
  assertNoSensitiveFields(receipt);
  return receipt;
}

export function acceptIdempotentReceipt(existing, incoming) {
  if (!existing) return { accepted: true, duplicate: false, receipt: incoming };
  if (existing.idempotencyKey !== incoming.idempotencyKey) return { accepted: false, duplicate: false, reason: 'idempotency_key_conflict' };
  const sameOutcome = existing.status === incoming.status && existing.evidence?.summary === incoming.evidence?.summary;
  return sameOutcome
    ? { accepted: true, duplicate: true, receipt: existing }
    : { accepted: false, duplicate: false, reason: 'conflicting_receipt_for_task_day' };
}

export function createNotificationOutboxItem({ receipt, channel = 'telegram', createdAt = new Date().toISOString() } = {}) {
  if (!receipt || typeof receipt !== 'object') throw new Error('receipt is required');
  if (!['telegram'].includes(channel)) throw new Error('unsupported notification channel');
  const dedupeKey = `notice_${digest(`${receipt.idempotencyKey}|${receipt.status}|${receipt.evidence?.summary ?? ''}`)}`;
  const item = {
    schemaVersion: 1,
    outboxId: `outbox_${digest(`${dedupeKey}|${createdAt}`)}`,
    dedupeKey,
    taskId: receipt.taskId,
    businessDate: receipt.businessDate,
    channel,
    state: 'pending',
    attempts: 0,
    createdAt: asIso(createdAt, 'createdAt'),
    nextAttemptAt: asIso(createdAt, 'createdAt'),
    payload: {
      status: receipt.status,
      summary: receipt.evidence?.summary ?? '',
      observedAt: receipt.observedAt
    }
  };
  assertNoSensitiveFields(item);
  return item;
}
