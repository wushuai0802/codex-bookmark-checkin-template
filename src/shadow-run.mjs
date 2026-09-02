#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, writeSnapshot } from './bridge.mjs';
import { appendLedgerRecord, createLedgerRecord } from './shadow-ledger.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--legacy-root') args.legacyRoot = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (token === '--ledger') args.ledger = argv[++i];
    else if (token === '--previous') args.previous = argv[++i];
    else if (token === '--generated-at') args.generatedAt = argv[++i];
    else if (token === '--help' || token === '-h') args.help = true;
    else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function loadSnapshot(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`previous snapshot is missing: ${file}`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`invalid previous snapshot: ${error.message}`); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv);
    if (args.help) {
      console.log('Usage: node src/shadow-run.mjs --legacy-root <path> [--out <file>] [--ledger <jsonl>] [--previous <snapshot>]');
      process.exit(0);
    }
    const legacyRoot = args.legacyRoot ?? process.env.CHECKIN_LEGACY_ROOT;
    if (!legacyRoot) throw new Error('provide --legacy-root or CHECKIN_LEGACY_ROOT');
    const snapshot = buildSnapshot({ legacyRoot, generatedAt: args.generatedAt });
    const previous = loadSnapshot(args.previous);
    const record = createLedgerRecord(snapshot, { previousSnapshot: previous, recordedAt: args.generatedAt });
    if (args.out) writeSnapshot(snapshot, args.out, legacyRoot);
    if (args.ledger) appendLedgerRecord(args.ledger, record, { legacyRoot });
    console.log(JSON.stringify({
      snapshotId: snapshot.snapshotId,
      planHash: snapshot.planHash,
      classification: record.drift.classification,
      logicalSites: snapshot.counts.logicalSites,
      executionUnits: snapshot.counts.executionUnits,
      mode: snapshot.mode,
      output: args.out ? path.resolve(args.out) : null,
      ledger: args.ledger ? path.resolve(args.ledger) : null
    }, null, 2));
  } catch (error) {
    console.error(`shadow run error: ${error.message}`);
    process.exitCode = 1;
  }
}

