import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { planHash, planUnitIdentity, assertUniqueTaskOwners, redactText } from './contracts.mjs';
import { displayIdentity, shortLabel } from './display-identity.mjs';

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
    planUnitId: stablePlanUnitId(task),
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

function stablePlanUnitId(task) {
  return task.planUnitId ?? planUnitIdentity(task).planUnitId;
}

function taskMap(snapshot) {
  const map = new Map();
  for (const task of snapshot?.tasks ?? []) {
    const planUnitId = stablePlanUnitId(task);
    if (map.has(planUnitId)) throw new Error(`duplicate plan unit id: ${planUnitId}`);
    map.set(planUnitId, task);
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
  const addedPlanUnits = [...currentTasks.keys()].filter((id) => !previousTasks.has(id)).sort();
  const removedPlanUnits = [...previousTasks.keys()].filter((id) => !currentTasks.has(id)).sort();
  const changedPlanUnits = [];
  const statusChanges = [];
  for (const [planUnitId, task] of currentTasks) {
    const old = previousTasks.get(planUnitId);
    if (!old) continue;
    if (taskShape(old) !== taskShape(task)) changedPlanUnits.push(planUnitId);
    if (old.observedStatus !== task.observedStatus) {
      statusChanges.push({
        planUnitId,
        taskId: task.taskId,
        fromTaskId: old.taskId,
        toTaskId: task.taskId,
        from: old.observedStatus ?? null,
        to: task.observedStatus ?? null
      });
    }
  }
  const ownerConflicts = [];
  const ownerByPlanUnit = new Map();
  for (const task of [...(previous?.tasks ?? []), ...(current?.tasks ?? [])]) {
    const planUnitId = stablePlanUnitId(task);
    const owners = ownerByPlanUnit.get(planUnitId) ?? new Set();
    owners.add(task.executionOwner);
    ownerByPlanUnit.set(planUnitId, owners);
  }
  for (const [planUnitId, owners] of ownerByPlanUnit) {
    if (owners.size > 1) ownerConflicts.push({ planUnitId, owners: [...owners].sort() });
  }
  const hashValid = validPlanHash(previous) && validPlanHash(current);
  const planChanged = addedPlanUnits.length > 0 || removedPlanUnits.length > 0 || changedPlanUnits.length > 0;
  const classification = !hashValid || ownerConflicts.length > 0 ? 'invalid' : (planChanged ? 'plan_changed' : 'same_plan');
  return {
    schemaVersion: 1,
    classification,
    samePlan: classification === 'same_plan',
    fromPlanHash: previous?.planHash ?? null,
    toPlanHash: current?.planHash ?? null,
    addedTaskIds: addedPlanUnits.map((id) => currentTasks.get(id).taskId).sort(),
    removedTaskIds: removedPlanUnits.map((id) => previousTasks.get(id).taskId).sort(),
    changedTaskIds: changedPlanUnits.map((id) => currentTasks.get(id).taskId).sort(),
    addedPlanUnitIds: addedPlanUnits,
    removedPlanUnitIds: removedPlanUnits,
    changedPlanUnitIds: changedPlanUnits.sort(),
    statusChanges: statusChanges.sort((a, b) => a.planUnitId.localeCompare(b.planUnitId)),
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
    addedTaskIds: snapshot.tasks.map((task) => task.taskId).sort(),
    removedTaskIds: [], changedTaskIds: [],
    addedPlanUnitIds: snapshot.tasks.map((task) => stablePlanUnitId(task)).sort(),
    removedPlanUnitIds: [], changedPlanUnitIds: [],
    statusChanges: [], ownerConflicts: [], hashValid: true
  };
  if (drift.classification === 'invalid' || drift.hashValid !== true) {
    throw new Error('invalid previous snapshot or ownership drift; review a new baseline without rewriting history');
  }
  const summarize = (task, source) => {
    const receipt = source.receipts?.find(item => item.taskId === task.taskId);
    return { taskId: task.taskId, origin: task.origin, displayName: shortLabel(task.displayName),
      identity: displayIdentity(task.identity), observedStatus: task.observedStatus,
      observedAt: receipt?.observedAt ?? null, evidence: receipt?.evidence ? {
        source: receipt.evidence.source, authoritative: receipt.evidence.authoritative === true,
        summary: redactText(receipt.evidence.summary), redacted: true,
        rawSource: shortLabel(receipt.evidence.rawSource,64),originalSource:shortLabel(receipt.evidence.originalSource,64),verification:shortLabel(receipt.evidence.verification,64)
      } : null };
  };
  const taskSummaries = snapshot.tasks.map(task => summarize(task, snapshot));
  const changes = drift.statusChanges.map(change => ({ kind: 'status', from: change.from, to: change.to,
    task: taskSummaries.find(task => task.taskId === change.taskId) }));
  for (const [kind, ids, source] of [['added', drift.addedTaskIds, snapshot], ['removed', drift.removedTaskIds, previousSnapshot], ['changed', drift.changedTaskIds, snapshot]]) {
    for (const id of ids) { const task = source?.tasks.find(task => task.taskId === id); if (task) changes.push({ kind, task: summarize(task, source) }); }
  }
  const recordId = `ledger_${crypto.createHash('sha256').update(`${snapshot.snapshotId}|task-details-v1`, 'utf8').digest('hex').slice(0, 24)}`;
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
    taskSummaries,
    changes,
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
