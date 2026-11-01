import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {summarizeUnknownReports} from '../../tools/unknown-summary.mjs';

const cli = fileURLToPath(new URL('../../tools/unknown-summary.mjs', import.meta.url));
const origin = 'https://pt.example';
const unknown = extra => ({origin, failureCode: 'submission_outcome_unknown', submissionAttempted: true, ...extra});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unknown-summary-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const write = (day, results) => fs.writeFileSync(path.join(root, `engine-daily-${day}.json`), JSON.stringify({businessDate: day, results}));
  return {root, write};
}

test('mixed old and new reports count rows by report date and SHA-256 origin prefix without writes', t => {
  const f = fixture(t);
  f.write('2026-10-31', [unknown({}), unknown({nativeGate: 'true'})]);
  f.write('2026-11-01', [unknown({nativeGate: true}), unknown({factObservedAt: '2026-10-06T00:00:00Z'}),
    unknown({diagnosticStage: 'native_child_decode'}), unknown({postActionReadbackAttempted: true}),
    unknown({origin: 'https://other.example', nativeGate: true}), {origin, status: 'signed'},
    unknown({factObservedAt: 'invalid', diagnosticStage: 'unreviewed', postActionReadbackAttempted: 1})]);
  fs.writeFileSync(path.join(f.root, 'engine-latest.json'), 'unrelated');
  const before = Object.fromEntries(fs.readdirSync(f.root).map(file => [file, fs.readFileSync(path.join(f.root, file), 'utf8')]));
  const summary = summarizeUnknownReports(f.root);
  assert.equal(summary.complete, true);
  assert.equal(summary.filesRead, 2);
  assert.deepEqual(summary.totals, {unknownRows: 8, nativeGateRows: 2, withoutNativeGateRows: 3, missingProvenanceRows: 3});
  const hash = createHash('sha256').update(origin).digest('hex').slice(0, 6);
  assert.deepEqual(summary.groups.find(group => group.siteHash === hash && group.businessDate === '2026-11-01'),
    {siteHash: hash, businessDate: '2026-11-01', unknownRows: 5, nativeGateRows: 1, withoutNativeGateRows: 3, missingProvenanceRows: 1});
  assert.equal(JSON.stringify(summary).includes(origin), false);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(f.root).map(file => [file, fs.readFileSync(path.join(f.root, file), 'utf8')])), before);
});

test('corrupt or malformed files are reported safely while valid files remain countable', t => {
  const f = fixture(t);
  f.write('2026-11-01', [unknown({nativeGate: true})]);
  fs.writeFileSync(path.join(f.root, 'engine-daily-2026-10-31.json'), '{invalid private content');
  f.write('2026-10-30', [null]);
  f.write('2026-10-29', [unknown({origin: origin + '/private'})]);
  fs.writeFileSync(path.join(f.root, 'engine-daily-2026-10-28.json'), JSON.stringify({businessDate: '2026-10-27', results: []}));
  fs.writeFileSync(path.join(f.root, 'engine-daily-2026-02-30.json'), '{}');
  const before = Object.fromEntries(fs.readdirSync(f.root).map(file => [file, fs.readFileSync(path.join(f.root, file), 'utf8')]));
  const summary = summarizeUnknownReports(f.root);
  assert.equal(summary.complete, false);
  assert.equal(summary.filesRead, 1);
  assert.equal(summary.totals.unknownRows, 1);
  assert.deepEqual(summary.errors.map(item => item.code).sort(), ['date_mismatch', 'invalid_date', 'invalid_json', 'invalid_results', 'invalid_results']);
  assert.doesNotMatch(JSON.stringify(summary), /private|https:|unknown-summary-/);
  const run = spawnSync(process.execPath, [cli, f.root], {encoding: 'utf8'});
  assert.equal(run.status, 2);
  assert.deepEqual(JSON.parse(run.stdout), summary);
  assert.equal(run.stderr, '');
  assert.deepEqual(Object.fromEntries(fs.readdirSync(f.root).map(file => [file, fs.readFileSync(path.join(f.root, file), 'utf8')])), before);
});

test('unrelated files and report-shaped directories cannot create unknown rows', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'engine-latest.json'), '{invalid');
  fs.mkdirSync(path.join(f.root, 'engine-daily-2026-11-01.json'));
  const summary = summarizeUnknownReports(f.root);
  assert.equal(summary.complete, true);
  assert.equal(summary.filesRead, 0);
  assert.deepEqual(summary.totals, {unknownRows: 0, nativeGateRows: 0, withoutNativeGateRows: 0, missingProvenanceRows: 0});
  assert.deepEqual(summary.groups, []);
  assert.deepEqual(summary.errors, []);
});

test('CLI accepts fieldless legacy reports as uncertain and reports directory errors without paths', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'engine-daily-2026-11-01.json'), JSON.stringify({results: [unknown({})]}));
  let run = spawnSync(process.execPath, [cli, f.root], {encoding: 'utf8'});
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).totals.missingProvenanceRows, 1);
  run = spawnSync(process.execPath, [cli], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Usage:/);
  run = spawnSync(process.execPath, [cli, path.join(f.root, 'absent')], {encoding: 'utf8'});
  assert.equal(run.status, 1);
  assert.equal(run.stderr, 'Unable to read report directory\n');
  assert.equal(run.stdout, '');
});
