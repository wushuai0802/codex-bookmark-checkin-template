import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {chainFixture, exampleOrigin as origin, inspection} from '../../execution/tests/helpers/offline-chain-fixture.mjs';
import {buildSnapshot} from '../src/bridge.mjs';
import {verdictSnapshot} from '../src/daily-reconciliation.mjs';
import {dayVerdict} from '../public/day-verdict.mjs';

test('real index reports reconcile to daily counts without refreshing an old unknown submission', {timeout: 45000}, async t => {
  const names = ['signed', 'completed', 'verifying', 'attention', 'maintenance', 'paused', 'no-feature', 'old-unknown'];
  const f = chainFixture(t, names, {paused: ['paused']});
  const old = new Date(f.now.getTime() - 86400000);
  if (!await f.writePreflight({[origin('old-unknown')]: inspection('unconfirmed', old, {submissionAttempted: true})}, {at: old})) return;
  const yesterday = await f.runIndex({at: old});
  const oldRow = yesterday.report.results.find(row => row.origin === origin('old-unknown'));
  assert.equal(oldRow.failureCode, 'submission_outcome_unknown');
  assert.equal(oldRow.submissionAttempted, true);
  assert.equal(oldRow.observedAt, old.toISOString());

  // A current report can carry an unresolved historical row. Seed that report
  // envelope, preserving the entire real index-produced historical row.
  const day = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(f.now);
  const seed = {...yesterday.report, runId: day.replaceAll('-', '') + '-chain-prior', finishedAt: f.now.toISOString()};
  fs.writeFileSync(path.join(f.root, 'logs/latest.json'), JSON.stringify(seed));
  const unavailableEvidence = {source: 'new_api_status', outcome: 'budele_enabled_false', authoritative: true,
    confirmedAt: new Date(f.now.getTime() - 1000).toISOString()};
  await f.writePreflight({
    [origin('signed')]: inspection('signed', f.now),
    [origin('completed')]: inspection('already_signed', f.now),
    [origin('verifying')]: inspection('not_signed', f.now),
    [origin('attention')]: inspection('needs_attention', f.now, {failureCode: 'two_factor_required'}),
    [origin('maintenance')]: inspection('unconfirmed', f.now, {failureCode: 'site_maintenance'}),
    [origin('no-feature')]: inspection('not_available', f.now, {availabilityKind: 'feature_disabled', evidence: unavailableEvidence}),
  });
  const out = await f.runIndex({resume: true});
  assert.equal(out.code, 2, out.stdout + out.stderr);
  assert.deepEqual(out.report.results.find(row => row.origin === origin('old-unknown')), oldRow);
  assert.doesNotMatch(out.stdout, /\[\d+\/\d+\] https:\/\/old-unknown\.example/);
  fs.writeFileSync(path.join(f.root, 'data/scheduler-state.json'), JSON.stringify({lastRunId: out.report.runId, lastRunDate: day}));
  const before = fs.readFileSync(path.join(f.root, 'logs/latest.json'), 'utf8');
  const snapshot = buildSnapshot({legacyRoot: f.root, generatedAt: f.now.toISOString()});
  const projected = verdictSnapshot(snapshot, {now: f.now});
  const verdict = dayVerdict(projected, {now: f.now});
  const tasks = new Map(projected.tasks.map(task => [task.origin, task]));
  const categories = new Map(verdict.items.map(item => [item.taskId, item.class]));
  for (const [name, category] of [['signed', 'done'], ['completed', 'done'], ['verifying', 'verifying'],
    ['attention', 'actionNeeded'], ['maintenance', 'external'], ['paused', 'paused'], ['no-feature', 'noFeature'], ['old-unknown', 'verifying']]) {
    assert.equal(categories.get(tasks.get(origin(name))?.taskId), category, name);
  }
  assert.deepEqual(verdict.counts, {done: 2, verifying: 2, actionNeeded: 1, external: 1, paused: 1, noFeature: 1});
  assert.equal(verdict.businessDate, day); assert.equal(verdict.total, 5); assert.equal(verdict.settled, false);
  const oldTask = tasks.get(origin('old-unknown'));
  const receipt = snapshot.receipts.find(receipt => receipt.taskId === oldTask.taskId);
  assert.equal(receipt.observedAt, oldRow.observedAt);
  assert.equal(oldTask.submissionAttempted, true);
  assert.equal(oldTask.failureCode, 'submission_outcome_unknown');
  assert.equal(fs.readFileSync(path.join(f.root, 'logs/latest.json'), 'utf8'), before);
  assert.equal(f.lines('tmp/browser-calls.jsonl').some(call => ['page', 'forbidden'].includes(call.event)), false);
});
