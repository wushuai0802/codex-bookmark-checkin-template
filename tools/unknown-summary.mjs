#!/usr/bin/env node
// Read-only: node tools/unknown-summary.mjs <engine-report-directory>
// Counts are report rows, never submission counts. An absent nativeGate marker
// does not prove dispatch; a row without any valid provenance is uncertain.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {NATIVE_DIAGNOSTIC_STAGES, normalizeFactTimestamp} from '../observation/src/engine-row-provenance.mjs';

const emptyCounts = () => ({unknownRows: 0, nativeGateRows: 0, withoutNativeGateRows: 0, missingProvenanceRows: 0});
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && normalizeFactTimestamp(value + 'T00:00:00Z') !== null;
const hasProvenance = row => normalizeFactTimestamp(row.factObservedAt) !== null || row.nativeGate === true ||
  NATIVE_DIAGNOSTIC_STAGES.includes(row.diagnosticStage) || row.postActionReadbackAttempted === true;
function validOrigin(value) {
  try { const url = new URL(value); return typeof value === 'string' && ['https:', 'http:'].includes(url.protocol) && url.origin === value; }
  catch { return false; }
}

export function summarizeUnknownReports(directory) {
  const groups = new Map(), errors = [], totals = emptyCounts();
  let filesRead = 0;
  for (const entry of fs.readdirSync(directory, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
    const match = /^engine-daily-(\d{4}-\d{2}-\d{2})\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) continue;
    const businessDate = match[1], fail = code => errors.push({file: entry.name, code});
    if (!validDay(businessDate)) { fail('invalid_date'); continue; }
    let report;
    try { report = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')); }
    catch (error) { fail(error instanceof SyntaxError ? 'invalid_json' : 'unreadable_file'); continue; }
    if (!Array.isArray(report?.results) || report.results.some(row => !row || typeof row !== 'object' || Array.isArray(row) || !validOrigin(row.origin))) {
      fail('invalid_results'); continue;
    }
    if (report.businessDate !== undefined && report.businessDate !== businessDate) { fail('date_mismatch'); continue; }
    filesRead++;
    for (const row of report.results) {
      if (row.failureCode !== 'submission_outcome_unknown') continue;
      const siteHash = createHash('sha256').update(row.origin).digest('hex').slice(0, 6);
      const key = businessDate + ':' + siteHash;
      if (!groups.has(key)) groups.set(key, {siteHash, businessDate, ...emptyCounts()});
      const counts = groups.get(key);
      const category = row.nativeGate === true ? 'nativeGateRows'
        : hasProvenance(row) ? 'withoutNativeGateRows' : 'missingProvenanceRows';
      counts.unknownRows++; counts[category]++;
      totals.unknownRows++; totals[category]++;
    }
  }
  return {schemaVersion: 1, complete: errors.length === 0, filesRead, totals, groups: [...groups.values()], errors};
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 1 || args[0].startsWith('--')) {
    process.stderr.write('Usage: node tools/unknown-summary.mjs <engine-report-directory>\n');
    return 1;
  }
  let summary;
  try { summary = summarizeUnknownReports(args[0]); }
  catch { process.stderr.write('Unable to read report directory\n'); return 1; }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return summary.complete ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
