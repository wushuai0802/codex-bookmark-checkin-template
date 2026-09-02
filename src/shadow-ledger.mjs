import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planHash, assertUniqueTaskOwners } from './contracts.mjs';

const SENSITIVE_NAMES = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi', 'screenshot',
  'accountid', 'accountlabel'
]);

function sensitiveKey(key) {
  return SENSITIVE_NAMES.has(String(key).replaceAll('_', '').toLowerCase());
}

function assertRedacted(value, location = '$') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitiveKey(key)) throw new Error(`sensitive field leaked at ${location}.${key}`);
    assertRedacted(child, `${location}.${key}`);
  }
}

function taskShape(task) {
  return JSON.stringify({
    taskId: task.taskId,
    businessDate: task.businessDate,
    logicalSiteKey: task.logicalSiteKey,
    logicalGroup: task.logicalGroup ?? null,
    origin: task.origin,
    accountKey: task.accountKey,
    accountRef: task.accountRef ?? null,
    actionType: task.actionType,
    scheduleOccurrence: task.scheduleOccurrence,
    executionOwner: task.executionOwner,
    executionMode: task.executionMode
  });
}

function taskMap(snapshot) {
  const map = new Map();
  for (const task of snapshot?.tasks ?? []) {
    if (map.has(task.taskId)) throw new Error(`duplicate task id: ${task.taskId}`);
    map.set(task.taskId, task);
  }
  return map;
}

function validPlanHash(snapshot) {
  return typeof snapshot?.planHash === 'string' && snapshot.planHash === planHash(snapshot.tasks ?? []);
}

/** Compare task identity/ownership while keeping result status changes separate. */
export function compareSnapshots(previous, current) {
  const previousTasks = taskMap(previous);
  const currentTasks = taskMap(current);
  const added = [...currentTasks.keys()].filter((id) => !previousTasks.has(id)).sort();
  const removed = [...previousTasks.keys()].filter((id) => !currentTasks.has(id)).sort();
  const changed = [];
  const statusChanges = [];
  for (const [id, task] of currentTasks) {
    const old = previousTasks.get(id);
    if (!old) continue;
    if (taskShape(old) !== taskShape(task)) changed.push(id);
    if (old.observedStatus !== task.observedStatus) statusChanges.push({ taskId: id, from: old.observedStatus ?? null, to: task.observedStatus ?? null });
  }
  const ownerConflicts = [];
  const ownerByTask = new Map();
  for (const task of [...(previous?.tasks ?? []), ...(current?.tasks ?? [])]) {
    const owners = ownerByTask.get(task.taskId) ?? new Set();
    owners.add(task.executionOwner);
    ownerByTask.set(task.taskId, owners);
  }
  for (const [taskId, owners] of ownerByTask) if (owners.size > 1) ownerConflicts.push({ taskId, owners: [...owners].sort() });
  const hashValid = validPlanHash(previous) && validPlanHash(current);
  const planChanged = added.length > 0 || removed.length > 0 || changed.length > 0;
  const classification = !hashValid || ownerConflicts.length > 0 ? 'invalid' : (planChanged ? 'plan_changed' : 'same_plan');
  return {
    schemaVersion: 1,
    classification,
    samePlan: classification === 'same_plan',
    fromPlanHash: previous?.planHash ?? null,
    toPlanHash: current?.planHash ?? null,
    addedTaskIds: added,
    removedTaskIds: removed,
    changedTaskIds: changed.sort(),
    statusChanges: statusChanges.sort((a, b) => a.taskId.localeCompare(b.taskId)),
    ownerConflicts,
    hashValid
  };
}

export function createLedgerRecord(snapshot, { previousSnapshot = null, recordedAt = new Date().toISOString() } = {}) {
  if (!snapshot || snapshot.mode !== 'shadow_read_only') throw new Error('only shadow_read_only snapshots can enter the alpha ledger');
  assertUniqueTaskOwners(snapshot.tasks ?? []);
  if (!validPlanHash(snapshot)) throw new Error('snapshot planHash does not match its tasks');
  const drift = previousSnapshot ? compareSnapshots(previousSnapshot, snapshot) : {
    schemaVersion: 1, classification: 'initial', samePlan: true,
    fromPlanHash: null, toPlanHash: snapshot.planHash,
    addedTaskIds: snapshot.tasks.map((task) => task.taskId).sort(), removedTaskIds: [], changedTaskIds: [], statusChanges: [], ownerConflicts: [], hashValid: true
  };
  const recordId = `ledger_${crypto.createHash('sha256').update(`${snapshot.snapshotId}|${recordedAt}`, 'utf8').digest('hex').slice(0, 24)}`;
  const record = {
    schemaVersion: 1,
    recordId,
    recordedAt: new Date(recordedAt).toISOString(),
    snapshotId: snapshot.snapshotId,
    businessDate: snapshot.businessDate,
    planHash: snapshot.planHash,
    sourceRunId: snapshot.source?.runId ?? null,
    mode: 'shadow_read_only',
    counts: snapshot.counts,
    drift,
    health: snapshot.health
  };
  assertRedacted(record);
  return record;
}

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw new Error(`invalid ledger JSON at line ${index + 1}: ${error.message}`); }
  });
}

export function appendLedgerRecord(file, record, { legacyRoot } = {}) {
  const destination = path.resolve(file);
  if (legacyRoot) {
    const root = path.resolve(legacyRoot);
    if (destination === root || destination.startsWith(`${root}${path.sep}`)) throw new Error('refusing to write ledger inside legacy project');
  }
  assertRedacted(record);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) {
    const existing = readLedger(destination);
    if (existing.some((candidate) => candidate.recordId === record.recordId)) return destination;
  }
  fs.appendFileSync(destination, `${JSON.stringify(record)}\n`, 'utf8');
  return destination;
}
