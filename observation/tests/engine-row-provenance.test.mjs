import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {engineRowProvenance, normalizeFactTimestamp, NATIVE_DIAGNOSTIC_STAGES} from '../src/engine-row-provenance.mjs';
import {publishEngineReport} from '../src/legacy-engine.mjs';

const finishedAt = '2026-11-01T02:00:00.000Z';
const oldAt = '2026-10-06T01:02:03.000Z';
const fields = ['factObservedAt', 'nativeGate', 'diagnosticStage', 'postActionReadbackAttempted'];
const withoutProvenance = row => Object.fromEntries(Object.entries(row).filter(([key]) => !fields.includes(key)));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'row-provenance-')), legacyRoot = path.join(root, 'legacy');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.cpSync(fileURLToPath(new URL('./fixtures/legacy/', import.meta.url)), legacyRoot, {recursive: true});
  const latest = JSON.parse(fs.readFileSync(path.join(legacyRoot, 'logs/fixture-run-20260902/result.json'), 'utf8'));
  Object.assign(latest, {runId: '20261101-provenance', finishedAt, isComplete: true});
  const publish = () => {
    fs.writeFileSync(path.join(legacyRoot, 'logs/latest.json'), JSON.stringify(latest));
    return publishEngineReport({root, legacyRoot, now: new Date('2026-11-01T02:01:00Z')});
  };
  return {root, latest, publish};
}

test('row provenance normalizes ISO timestamps and rejects coercions and impossible dates', () => {
  assert.equal(normalizeFactTimestamp('2026-10-06T09:02:03+08:00'), oldAt);
  assert.equal(normalizeFactTimestamp('2024-02-29T00:00:00.1234567Z'), '2024-02-29T00:00:00.123Z');
  for (const observedAt of [undefined, null, 0, true, {}, [], '1', '2026-10-06', '2026-10-06 01:02:03Z',
    '2026-02-30T01:02:03Z', '2026-02-29T01:02:03Z', '2026-04-31T01:02:03Z',
    '2026-10-06T24:00:00Z', '2026-10-06T01:02:03+24:00', '2026-10-06T01:02:03', 'invalid']) {
    assert.equal(normalizeFactTimestamp(observedAt), null);
    assert.deepEqual(engineRowProvenance({observedAt}, finishedAt), {});
  }
});

test('native diagnostics and booleans use exact allowlists', () => {
  for (const diagnosticStage of NATIVE_DIAGNOSTIC_STAGES) {
    assert.deepEqual(engineRowProvenance({diagnosticStage, nativeGate: true, postActionReadbackAttempted: true}, finishedAt),
      {nativeGate: true, diagnosticStage, postActionReadbackAttempted: true});
  }
  for (const value of [false, 0, 1, 'false', 'true', null, {}, [], undefined]) {
    assert.deepEqual(engineRowProvenance({nativeGate: value, postActionReadbackAttempted: value,
      diagnosticStage: value, arbitrary: 'discard'}, finishedAt), {});
  }
  assert.deepEqual(engineRowProvenance({diagnosticStage: 'unreviewed_stage'}, finishedAt), {});
});

test('report-finished timestamps alone never become fact time; independent evidence can date the row', () => {
  assert.deepEqual(engineRowProvenance({observedAt: finishedAt}, finishedAt), {});
  assert.deepEqual(engineRowProvenance({observedAt: finishedAt}, 'Sun, 01 Nov 2026 02:00:00 GMT'), {});
  assert.deepEqual(engineRowProvenance({observedAt: '2026-11-01T10:00:00+08:00'}, finishedAt), {});
  assert.deepEqual(engineRowProvenance({}, finishedAt), {});
  assert.deepEqual(engineRowProvenance({observedAt: finishedAt, evidence: {confirmedAt: oldAt}}, finishedAt), {factObservedAt: oldAt});
  assert.deepEqual(engineRowProvenance({observedAt: finishedAt, evidence: {confirmedAt: finishedAt}}, finishedAt), {factObservedAt: finishedAt});
  assert.deepEqual(engineRowProvenance({observedAt: 'invalid', confirmedAt: oldAt}, finishedAt), {factObservedAt: oldAt});
});

test('a report completion fallback is omitted from published rows without an independent receipt', t => {
  const f = fixture(t);
  for (const row of f.latest.results) {
    Object.assign(row, {observedAt: finishedAt, evidence: {}, confirmedAt: undefined, lastConfirmedAt: undefined});
  }
  let report = f.publish();
  assert.equal(report.results.some(row => 'factObservedAt' in row), false);
  f.latest.results[0].evidence.confirmedAt = oldAt;
  report = f.publish();
  assert.equal(report.results[0].factObservedAt, oldAt);
  assert.equal(report.results.slice(1).some(row => 'factObservedAt' in row), false);
});

test('publication preserves the old pending time and never asserts a native gate did not dispatch', t => {
  const f = fixture(t);
  f.latest.results[2] = {...f.latest.results[2], observedAt: oldAt, failureCode: 'submission_outcome_unknown',
    submissionAttempted: true, retryable: false, nativeGate: true, diagnosticStage: 'page_readback',
    postActionReadbackAttempted: true, dispatchedThisRun: false};
  const report = f.publish(), row = report.results[2];
  assert.equal(row.factObservedAt, oldAt);
  assert.notEqual(row.factObservedAt, report.observedAt);
  assert.notEqual(row.factObservedAt, report.sourceFinishedAt);
  assert.equal(row.submissionAttempted, true);
  assert.equal(row.nativeGate, true);
  assert.equal(row.postActionReadbackAttempted, true);
  assert.equal('dispatchedThisRun' in row, false);
  const saved = JSON.parse(fs.readFileSync(path.join(f.root, 'outputs/engine-daily-2026-11-01.json'), 'utf8'));
  assert.deepEqual(saved.results, report.results);
});

test('all legacy row fields and public projections are unchanged by row provenance', t => {
  const f = fixture(t);
  for (const [index, row] of f.latest.results.entries()) Object.assign(row, {
    observedAt: oldAt, failureCode: 'submission_outcome_unknown', submissionAttempted: index !== 1,
    retryable: index === 0 ? false : true, nativeGate: true, diagnosticStage: 'native_child_decode',
    postActionReadbackAttempted: true,
  });
  const report = f.publish();
  const snapshotFile = path.join(f.root, 'outputs/shadow-beta-snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8'));
  for (const file of ['shadow-beta-snapshot.json', 'shadow-ledger.jsonl', 'dashboard-generation.json', 'dashboard-runtime.json']) {
    const text = fs.readFileSync(path.join(f.root, 'outputs', file), 'utf8');
    for (const field of [...fields, 'dispatchedThisRun']) assert.equal(text.includes('"' + field + '"'), false, file + ':' + field);
  }
  for (const row of f.latest.results) for (const field of ['observedAt', ...fields]) delete row[field];
  const reference = f.publish();
  assert.deepEqual(report.results.map(withoutProvenance), reference.results.map(withoutProvenance));
  assert.deepEqual(report.counts, reference.counts);
  assert.equal(report.businessComplete, reference.businessComplete);
  assert.deepEqual(snapshot, JSON.parse(fs.readFileSync(snapshotFile, 'utf8')));
});
