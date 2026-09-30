import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPt,ptStatusCategory,matchesTask,matchesLedger,ledgerPendingCount,TASK_FILTERS,taskStatusLabel} from '../public/dashboard-model.mjs';

test('external conditions and unknown submissions have distinct labels and filters',()=>{
  const external={origin:'https://site.test',observedStatus:'deferred',condition:'upstream_unavailable'};
  const unknown={...external,observedStatus:'needs_attention',condition:'submission_outcome_unknown'};
  assert.equal(taskStatusLabel(external),'等待站点恢复');
  assert.equal(matchesTask(external,{status:'external'}),true);
  assert.equal(matchesTask(external,{status:'verification'}),false);
  assert.equal(matchesTask(unknown,{status:'external'}),false);
  assert.equal(matchesTask(unknown,{status:'verification'}),true);
  assert.equal(matchesTask(unknown,{status:'attention'}),false);
  assert.equal(matchesTask(external,{status:'attention'}),false);
  assert.equal(matchesTask(external,{status:'pending'}),true);
});

test('task filters use non-overlapping business groups',()=>{
  const task=status=>({observedStatus:status,origin:'https://example.test'});
  for(const status of ['signed','already_signed'])assert.equal(matchesTask(task(status),{status:'completed'}),true);
  assert.equal(matchesTask(task('deferred'),{status:'pending'}),true);
  assert.equal(matchesTask(task('needs_attention'),{status:'attention'}),true);
  assert.equal(matchesTask(task('failed'),{status:'attention'}),true);
  assert.equal(matchesTask(task('unknown'),{status:'attention'}),true);
  assert.equal(matchesTask(task('not_started'),{status:'attention'}),true);
  assert.equal(matchesTask(task('login_required'),{status:'login_required'}),true);
  assert.equal(matchesTask(task('not_available'),{status:'unavailable'}),true);
  assert.equal(matchesTask(task('not_available'),{status:'not_available'}),true);
  assert.equal(matchesTask(task('signed'),{status:'success'}),true);
  assert.equal(matchesTask(task('needs_attention'),{status:'pending'}),true);
  assert.equal(matchesTask(task('signed'),{status:'pending'}),false);
  for (const key of ['completed','pending','unavailable','attention']) {
    assert.ok(TASK_FILTERS.some(([value]) => value === key), key + ' must be selectable from the dashboard');
  }
  assert.equal(matchesTask(task('deferred'),{status:'completed'}),false);
});

test('ledger review filters keep pending and drift records distinct', () => {
  const pending = {counts:{executionUnits:2,status:{signed:1}}};
  const changed = {counts:{executionUnits:1,status:{signed:1}},drift:{statusChanges:[{taskId:'sample'}]}};
  assert.equal(ledgerPendingCount(pending), 1);
  assert.equal(matchesLedger(pending, 'pending'), true);
  assert.equal(matchesLedger(changed, 'pending'), false);
  assert.equal(matchesLedger(changed, 'changed'), true);
});

test('PT review filter includes registered unknown status but not unregistered observations',()=>{
  assert.equal(matchesPt({inLegacyPlan:true,effective:{status:'unknown'}},'review'),true);
  assert.equal(matchesPt({inLegacyPlan:true,effective:{status:'signed'}},'review'),false);
  assert.equal(matchesPt({inLegacyPlan:false,effective:{status:'unknown'}},'review'),false);
  assert.equal(matchesPt({inLegacyPlan:false,fallbackEnabled:true,effective:{status:'unknown'}},'review'),true);
});

test('PT completion, reported success and unknown are disjoint, including stale evidence',()=>{
 const site={inLegacyPlan:true,effective:{status:'signed',fresh:true,authoritative:false}};
 assert.equal(ptStatusCategory(site),'reported');
 assert.equal(matchesPt(site,'reported'),true);
 assert.equal(matchesPt(site,'review'),false);
 site.effective.authoritative=true;
 assert.equal(ptStatusCategory(site),'confirmed');
 assert.equal(matchesPt(site,'confirmed'),true);
 site.effective.fresh=false;
 assert.equal(ptStatusCategory(site),'unknown');
 assert.equal(matchesPt(site,'review'),true);
});
