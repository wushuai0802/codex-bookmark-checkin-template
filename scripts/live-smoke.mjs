#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/bridge.mjs';

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--legacy-root') args.legacyRoot = argv[++index];
    else if (token === '--health-file') args.healthFile = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

export function validateLiveSnapshot(snapshot) {
  if (snapshot?.mode !== 'shadow_read_only') throw new Error('live snapshot is not read-only shadow mode');
  if (snapshot.counts.logicalSites < 1 || snapshot.counts.executionUnits < 1) throw new Error('live snapshot is empty');
  if (new Set(snapshot.tasks.map((task) => task.taskId)).size !== snapshot.tasks.length) throw new Error('duplicate daily task id');
  if (new Set(snapshot.tasks.map((task) => task.planUnitId)).size !== snapshot.tasks.length) throw new Error('duplicate stable plan unit id');
  if (snapshot.health?.freshness?.fresh !== true) throw new Error('legacy health report is stale');
  if (snapshot.health?.healthy !== true) throw new Error('legacy health report is unhealthy');
  const serialized = JSON.stringify(snapshot);
  if (/"(?:password|passwd|token|cookie|secret|authorization|accountId|accountLabel|userDataDir|profilePath|dpapi|screenshot)"\s*:/i.test(serialized)) {
    throw new Error('sensitive field was present in live snapshot');
  }
  return {
    ok: true,
    mode: snapshot.mode,
    businessDate: snapshot.businessDate,
    logicalSites: snapshot.counts.logicalSites,
    executionUnits: snapshot.counts.executionUnits,
    healthFresh: snapshot.health.freshness.fresh,
    healthHealthy: snapshot.health.healthy
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv);
    const legacyRoot = args.legacyRoot ?? process.env.CHECKIN_LEGACY_ROOT;
    if (!legacyRoot) throw new Error('provide --legacy-root or CHECKIN_LEGACY_ROOT');
    const healthReport = args.healthFile
      ? JSON.parse(fs.readFileSync(path.resolve(args.healthFile), 'utf8'))
      : undefined;
    console.log(JSON.stringify(validateLiveSnapshot(buildSnapshot({ legacyRoot, healthReport })), null, 2));
  } catch (error) {
    console.error(`live smoke error: ${error.message}`);
    process.exitCode = 1;
  }
}
