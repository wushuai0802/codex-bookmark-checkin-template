import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {runNativePtGate} from '../src/native-pt-gate.mjs';
import {chainFixture, exampleOrigin as origin, inspection} from './helpers/offline-chain-fixture.mjs';

const byOrigin = report => new Map(report.results.map(row => [row.origin, row]));
function noBrowserPages(f) {
  const calls = f.lines('tmp/browser-calls.jsonl');
  assert.equal(calls.filter(call => call.event === 'launch').length, calls.filter(call => call.event === 'close').length);
  assert.equal(calls.filter(call => ['page', 'forbidden'].includes(call.event)).length, 0);
}

test('real preflight projection and UTF-8 writer feed six outcomes into the real index and both report files', {timeout: 30000}, async t => {
  const names = ['signed', 'completed', 'unsigned', 'unreadable', 'login', 'missing'];
  const f = chainFixture(t, names);
  const preflight = await f.writePreflight({
    [origin('signed')]: inspection('signed', f.now),
    [origin('completed')]: inspection('already_signed', f.now),
    [origin('unsigned')]: inspection('not_signed', f.now),
    [origin('unreadable')]: inspection('unconfirmed', f.now, {failureCode: 'accessibility_unavailable'}),
    [origin('login')]: inspection('login_required', f.now),
  });
  if (!preflight) return;
  assert.equal(preflight.results.length, 5);
  const projections = byOrigin(preflight);
  assert.equal(projections.get(origin('completed')).status, 'already_signed');
  assert.equal(projections.get(origin('unsigned')).inspectionStatus, 'not_signed');
  assert.equal(projections.get(origin('login')).inspectionStatus, 'login_required');
  const out = await f.runIndex(), rows = byOrigin(out.report);
  assert.equal(out.code, 2, out.stdout + out.stderr);
  for (const [name, status] of [['signed', 'signed'], ['completed', 'already_signed'], ['unsigned', 'deferred'],
    ['unreadable', 'deferred'], ['login', 'deferred'], ['missing', 'deferred']]) {
    assert.equal(rows.get(origin(name)).status, status, name);
    assert.equal(rows.get(origin(name)).attempt, 1, name);
  }
  for (const name of ['signed', 'completed']) {
    assert.equal(rows.get(origin(name)).evidence.authoritative, true);
    assert.deepEqual(rows.get(origin(name)).evidence, projections.get(origin(name)).evidence);
  }
  for (const name of ['unsigned', 'unreadable', 'missing']) {
    assert.equal(rows.get(origin(name)).retryCause, 'native_readback_unavailable', name);
  }
  assert.equal(rows.get(origin('unreadable')).failureCode, 'accessibility_unavailable');
  assert.equal(rows.get(origin('login')).retryCause, 'login_required');
  assert.equal(rows.get(origin('login')).inspectionStatus, 'login_required');
  assert.equal(rows.get(origin('missing')).inspectionStatus, 'missing');
  assert.equal(out.report.processedTotal, names.length);
  assert.equal(out.report.businessComplete, false);
  assert.equal(fs.existsSync(path.join(f.root, 'tmp/native-waf-preflight.json')), false);
  assert.deepEqual(f.lines('tmp/browser-calls.jsonl').filter(call => call.event === 'login_helper'),
    [{event: 'login_helper', origin: origin('login')}]);
  noBrowserPages(f);
});

test('real one-shot scheduler dispatches the wrapper; resume excludes completed rows and settles old and newly paused rows', {timeout: 45000}, async t => {
  const f = chainFixture(t, ['completed', 'pending', 'paused', 'newly-paused'], {paused: ['paused']});
  const initial = {
    [origin('completed')]: inspection('already_signed', f.now),
    [origin('pending')]: inspection('not_signed', f.now),
    [origin('newly-paused')]: inspection('not_signed', f.now),
  };
  fs.writeFileSync(path.join(f.root, 'tmp/chain-inspections.json'), JSON.stringify(initial));
  const main = await f.runEntry('scheduler');
  if (!main) return;
  const mainRows = byOrigin(main.report);
  assert.equal(mainRows.get(origin('completed')).status, 'already_signed');
  assert.equal(mainRows.get(origin('pending')).status, 'deferred');
  assert.equal(mainRows.get(origin('newly-paused')).status, 'deferred');
  const mainScope = f.lines('tmp/preflight-calls.jsonl')[0];
  assert.deepEqual([...mainScope.requested].sort(), ['completed', 'pending', 'newly-paused'].map(origin).sort());
  assert.deepEqual([...mainScope.selected].sort(), [...mainScope.requested].sort());
  const state = f.json('data/scheduler-state.json');
  assert.equal(state.reportValid, true);
  assert.equal(state.lastRunId, main.report.runId);
  assert.equal(state.reportExecutionComplete, true);
  const dispatches = f.lines('tmp/process-calls.jsonl');
  assert.ok(dispatches.some(call => call.args.some(arg => String(arg).includes('Run-Checkin.ps1'))));
  assert.ok(dispatches.some(call => call.args.some(arg => String(arg).endsWith('index.mjs'))));

  f.config.disabledCheckinOrigins.push(origin('newly-paused')); f.save();
  await f.writePreflight({[origin('pending')]: inspection('signed', f.now)});
  // The explicit writer call above is setup; retain only wrapper scope calls.
  fs.rmSync(path.join(f.root, 'tmp/preflight-calls.jsonl'));
  const resumed = await f.runEntry('wrapper');
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  const resumedRows = byOrigin(resumed.report);
  const resumeScope = f.lines('tmp/preflight-calls.jsonl');
  assert.equal(resumeScope.length, 1);
  assert.deepEqual([...resumeScope[0].requested].sort(), ['pending', 'newly-paused'].map(origin).sort());
  assert.deepEqual(resumeScope[0].selected, [origin('pending')]);
  assert.deepEqual(resumedRows.get(origin('completed')), mainRows.get(origin('completed')));
  assert.equal(resumedRows.get(origin('pending')).status, 'signed');
  assert.doesNotMatch(resumed.stdout, /\[\d+\/\d+\] https:\/\/completed\.example/);
  for (const report of [main.report, resumed.report]) for (const name of report === main.report ? ['paused'] : ['paused', 'newly-paused']) {
    const row = byOrigin(report).get(origin(name));
    assert.equal(row.status, 'not_available'); assert.equal(row.availabilityKind, 'task_disabled');
    assert.equal(row.disabledByConfig, true); assert.equal(row.attempt, 0);
    assert.equal(row.evidence.source, 'configuration'); assert.equal(row.nextEligibleAt, undefined);
  }
  assert.equal(resumed.report.businessComplete, true);
  assert.equal(resumed.report.nextRetryAt, null);
  noBrowserPages(f);
});

test('a fully paused main run and resume stay terminal without preflight or pages', {timeout: 30000}, async t => {
  const f = chainFixture(t, ['paused'], {paused: ['paused']});
  fs.writeFileSync(path.join(f.root, 'tmp/chain-inspections.json'), '{}');
  const main = await f.runEntry('wrapper');
  if (!main) return;
  const resumed = await f.runEntry('wrapper');
  for (const out of [main, resumed]) {
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(out.report.results[0].availabilityKind, 'task_disabled');
    assert.equal(out.report.results[0].attempt, 0);
  }
  assert.deepEqual(f.lines('tmp/preflight-calls.jsonl'), []);
  noBrowserPages(f);
  await t.test('a fully paused run avoids launching a browser context', {
    todo: 'index.runGlobalTarget awaits getSharedContext before runOneTarget applies configuredTargetSkip',
  }, () => assert.deepEqual(f.lines('tmp/browser-calls.jsonl'), []));
});

test('a real native gate decision survives the real preflight writer and index without replaying a pending intent', {timeout: 30000}, async t => {
  const f = chainFixture(t, ['guarded']);
  f.config.targetFolderNames = ['example-pt-folder'];
  f.config.ptReadOnlyPolicies = {[origin('guarded')]: {reviewed: true, mode: 'safe_history_page',
    url: origin('guarded') + '/index.php', selector: '#info_block'}};
  const bookmarks = f.json('tmp/Bookmarks');
  bookmarks.roots.other.children[0].name = 'example-pt-folder';
  fs.writeFileSync(f.config.bookmarksPath, JSON.stringify(bookmarks)); f.save();
  const options = {root: f.root, origin: origin('guarded'), url: origin('guarded') + '/attendance.php',
    profile: f.profile, now: f.now, harvest: () => null, verify: () => null, verifyHistorical: () => null};
  // A synthetic durable intent exercises the real gate, not a browser action.
  const begun = await runNativePtGate({...options, phase: 'begin', action: 'navigation', attemptId: randomUUID()});
  assert.equal(begun.allow, true);
  const gate = await runNativePtGate({...options, phase: 'inspect', attemptId: randomUUID()});
  assert.equal(gate.allow, false); assert.equal(gate.decision.failureCode, 'submission_outcome_unknown');
  const journalBefore = fs.readFileSync(path.join(f.root, 'data/native-pt-attempts.json'), 'utf8');
  if (!await f.writePreflight({[origin('guarded')]: {gateDecision: gate.decision}})) return;
  const out = await f.runIndex(), row = out.report.results[0];
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.equal(row.status, 'needs_attention'); assert.equal(row.failureCode, 'submission_outcome_unknown');
  assert.equal(row.nativeGate, true); assert.equal(row.attempt, 0);
  assert.equal(row.submissionAttempted, true); assert.equal(row.retryable, false);
  assert.equal(out.report.nextRetryAt, null);
  assert.equal(fs.readFileSync(path.join(f.root, 'data/native-pt-attempts.json'), 'utf8'), journalBefore);
  noBrowserPages(f);
});
