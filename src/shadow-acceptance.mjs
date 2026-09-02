#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from './shadow-ledger.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID_PATTERN = /^ledger_[a-f0-9]{24}$/;
const PLAN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const VALID_CLASSIFICATIONS = new Set(['initial', 'same_plan', 'plan_changed']);
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'token', 'cookie', 'secret', 'authorization',
  'credential', 'credentials', 'profilepath', 'userdatadir', 'dpapi',
  'screenshot', 'accountid', 'accountlabel'
]);

function isSensitiveKey(key) {
  return SENSITIVE_KEYS.has(String(key).replaceAll('_', '').toLowerCase());
}

function hasSensitiveKey(value) {
  if (!value || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key) || hasSensitiveKey(child)) return true;
  }
  return false;
}

function validIso(value) {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
}

function validBusinessDate(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dayNumber(value) {
  const [year, month, day] = value.split('-').map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function recordErrors(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['record_not_object'];
  if (record.schemaVersion !== 1) errors.push('schema_version_invalid');
  if (typeof record.recordId !== 'string' || !RECORD_ID_PATTERN.test(record.recordId)) errors.push('record_id_invalid');
  if (record.mode !== 'shadow_read_only') errors.push('mode_not_shadow');
  if (!validBusinessDate(record.businessDate)) errors.push('business_date_invalid');
  if (typeof record.planHash !== 'string' || !PLAN_HASH_PATTERN.test(record.planHash)) errors.push('plan_hash_invalid');
  if (!validIso(record.recordedAt)) errors.push('recorded_at_invalid');
  if (!record.drift || !VALID_CLASSIFICATIONS.has(record.drift.classification)) errors.push('drift_classification_invalid');
  if (record.drift?.hashValid !== true) errors.push('drift_hash_invalid');
  if (Array.isArray(record.drift?.ownerConflicts) && record.drift.ownerConflicts.length > 0) errors.push('owner_conflict');
  if (!record.health || typeof record.health.freshness?.fresh !== 'boolean') errors.push('health_freshness_invalid');
  if (!record.counts || !Number.isInteger(record.counts.logicalSites) || record.counts.logicalSites < 0) errors.push('logical_site_count_invalid');
  if (!record.counts || !Number.isInteger(record.counts.executionUnits) || record.counts.executionUnits < 0) errors.push('execution_unit_count_invalid');
  if (hasSensitiveKey(record)) errors.push('sensitive_field_present');
  return errors;
}

/**
 * Evaluate whether a redacted shadow ledger has enough clean daily history to
 * begin candidate-worker review. This function is read-only and never grants
 * a lease or starts an executor.
 */
export function evaluateShadowHistory(records, { minConsecutiveDays = 7 } = {}) {
  if (!Number.isInteger(minConsecutiveDays) || minConsecutiveDays < 1 || minConsecutiveDays > 366) {
    throw new Error('minConsecutiveDays must be between 1 and 366');
  }
  const list = Array.isArray(records) ? records : [];
  const seenRecordIds = new Set();
  const invalidRecords = [];
  const dates = new Set();
  let freshRecordCount = 0;
  let staleRecordCount = 0;
  let ownerConflictRecords = 0;

  list.forEach((record, index) => {
    const errors = recordErrors(record);
    if (record?.recordId && seenRecordIds.has(record.recordId)) errors.push('duplicate_record_id');
    if (record?.recordId) seenRecordIds.add(record.recordId);
    if (errors.includes('owner_conflict')) ownerConflictRecords += 1;
    if (record?.health?.freshness?.fresh === true) freshRecordCount += 1;
    else staleRecordCount += 1;
    if (validBusinessDate(record?.businessDate)) dates.add(record.businessDate);
    if (errors.length > 0) invalidRecords.push({ index, recordId: record?.recordId ?? null, errors: [...new Set(errors)] });
  });

  const sortedDates = [...dates].sort();
  let longestConsecutiveDays = sortedDates.length > 0 ? 1 : 0;
  let currentConsecutiveDays = longestConsecutiveDays;
  for (let index = 1; index < sortedDates.length; index += 1) {
    if (dayNumber(sortedDates[index]) - dayNumber(sortedDates[index - 1]) === 1) currentConsecutiveDays += 1;
    else currentConsecutiveDays = 1;
    longestConsecutiveDays = Math.max(longestConsecutiveDays, currentConsecutiveDays);
  }

  const reasons = [];
  if (list.length === 0) reasons.push('no_records');
  if (longestConsecutiveDays < minConsecutiveDays) reasons.push('insufficient_consecutive_days');
  if (invalidRecords.length > 0) reasons.push('invalid_records');
  if (ownerConflictRecords > 0) reasons.push('owner_conflict');
  if (staleRecordCount > 0) reasons.push('health_not_fresh');
  return {
    schemaVersion: 1,
    accepted: reasons.length === 0,
    requiredConsecutiveDays: minConsecutiveDays,
    recordCount: list.length,
    distinctBusinessDates: sortedDates.length,
    firstBusinessDate: sortedDates[0] ?? null,
    latestBusinessDate: sortedDates.at(-1) ?? null,
    longestConsecutiveDays,
    freshRecordCount,
    staleRecordCount,
    invalidRecordCount: invalidRecords.length,
    ownerConflictRecords,
    reasons,
    invalidRecords
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--ledger') args.ledger = argv[++index];
    else if (token === '--min-days') args.minConsecutiveDays = Number(argv[++index]);
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log('Usage: node src/shadow-acceptance.mjs --ledger <jsonl> [--min-days 7]');
      process.exit(0);
    }
    if (!args.ledger) throw new Error('provide --ledger');
    const result = evaluateShadowHistory(readLedger(path.resolve(args.ledger)), { minConsecutiveDays: args.minConsecutiveDays ?? 7 });
    console.log(JSON.stringify(result, null, 2));
    if (!result.accepted) process.exitCode = 2;
  } catch (error) {
    console.error(`shadow acceptance error: ${error.message}`);
    process.exitCode = 1;
  }
}
