import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPt,ptStatusCategory,ptStatusCondition,matchesTask,matchesLedger,ledgerPendingCount,TASK_FILTERS,taskStatusLabel} from '../public/dashboard-model.mjs';

test('PT current maintenance takes precedence over historical and same-day uncertainty',()=>{
  const site={effective:{status:'needs_attention',fresh:true,siteCondition:'site_maintenance',failureCode:'submission_outcome_unknown'},
    recovery:{code:'prior_outcome_unknown'}};
  assert.equal(ptStatusCondition(site),'site_maintenance');
  assert.equal(taskStatusLabel({observedStatus:site.effective.status,condition:ptStatusCondition(site)}),'站点维护');
  site.recovery.code='submission_outcome_unknown';
  assert.equal(ptStatusCondition(site),'site_maintenance');
  site.effective.fresh=false;
  assert.equal(ptStatusCondition(site),'submission_outcome_unknown');
  site.effective={status:'unknown',fresh:true};site.recovery.code='prior_outcome_unknown';
  assert.equal(ptStatusCondition(site),undefined);
  site.recovery.code='unverified_prior_attempt';
  assert.equal(ptStatusCondition(site),'submission_outcome_unknown');
  site.effective={status:'already_signed',fresh:true,siteCondition:'site_maintenance'};
  assert.equal(taskStatusLabel({observedStatus:site.effective.status,condition:ptStatusCondition(site)}),'今日已完成');
});

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
  const recovered={...unknown,observedStatus:'already_signed'};
  assert.equal(taskStatusLabel(recovered),'今日已完成');
  assert.equal(matchesTask(recovered,{status:'verification'}),false);
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
