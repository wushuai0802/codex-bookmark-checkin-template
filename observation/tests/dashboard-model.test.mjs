import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPt,ptStatusCategory,ptStatusCondition,matchesTask,matchesLedger,ledgerPendingCount,ledgerCancelledCount,TASK_FILTERS,taskStatusLabel,taskStatusSummary,externalTask,cancelledTask} from '../public/dashboard-model.mjs';
import {overviewStatusCounts} from '../public/overview-model.mjs';

test('current availability consistently labels and filters an uncertain regular task without changing its result',()=>{
  const task={origin:'https://fixture.example',observedStatus:'needs_attention',condition:'submission_outcome_unknown',
    failureCode:'submission_outcome_unknown',submissionAttempted:true,evidence:{authoritative:false,summary:'旧执行结果尚未确认'},
    availability:{condition:'site_maintenance',summary:'站点维护，等待恢复'}};
  const original=JSON.stringify(task);
  assert.equal(taskStatusLabel(task),'站点维护');assert.equal(taskStatusSummary(task),'站点维护，等待恢复');
  assert.equal(externalTask(task),true);
  assert.equal(matchesTask(task,{status:'external'}),true);
  assert.equal(matchesTask(task,{status:'verification'}),false);
  assert.equal(matchesTask(task,{status:'attention'}),false);
  assert.equal(matchesTask(task,{status:'pending'}),true);
  assert.equal(JSON.stringify(task),original);
  assert.equal(taskStatusLabel({...task,availability:null}),'结果待核验');
  assert.equal(taskStatusLabel({...task,observedStatus:'already_signed'}),'已签到');
  assert.equal(externalTask({...task,observedStatus:'already_signed'}),false);
});

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
  assert.equal(taskStatusLabel({observedStatus:site.effective.status,condition:ptStatusCondition(site)}),'已签到');
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
  assert.equal(taskStatusLabel(recovered),'已签到');
  assert.equal(matchesTask(recovered,{status:'verification'}),false);
});

test('task filters use non-overlapping business groups',()=>{
  const task=status=>({observedStatus:status,origin:'https://example.test'});
  for(const status of ['signed','already_signed']){
    assert.equal(taskStatusLabel(task(status)),'已签到');
    for(const filter of ['completed','signed','already_signed'])assert.equal(matchesTask(task(status),{status:filter}),true);
  }
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

test('every chart legend drills down to exactly its visible bucket',()=>{
  const tasks=[];
  for(const observedStatus of ['signed','already_signed','not_available','needs_attention','failed','deferred','login_required','unknown','not_started']){
    tasks.push({origin:'https://fixture.example',observedStatus});
    if(!['signed','already_signed','not_available'].includes(observedStatus)){
      tasks.push({origin:'https://fixture.example',observedStatus,condition:'site_maintenance'});
      tasks.push({origin:'https://fixture.example',observedStatus,condition:'submission_outcome_unknown'});
    }
  }
  tasks.push({origin:'https://cancelled.example',observedStatus:'not_available',condition:'task_disabled',
    evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}});
  const counts=overviewStatusCounts({counts:{executionUnits:tasks.length},tasks});
  for(const [status,count] of Object.entries(counts))assert.equal(tasks.filter(task=>matchesTask(task,{status})).length,count,status);
  assert.equal(tasks.filter(task=>matchesTask(task,{status:'needs_attention'})).length,1);
  assert.equal(tasks.filter(task=>matchesTask(task,{status:'attention'})).length,4);
});

test('configuration cancellation is distinct from feature unavailability and completion',()=>{
  const task={observedStatus:'not_available',condition:'task_disabled',evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}};
  assert.equal(cancelledTask(task),true);assert.equal(taskStatusLabel(task),'已取消');
  for(const status of ['unavailable','completed','pending','attention'])assert.equal(matchesTask(task,{status}),false,status);
  assert.equal(matchesTask(task,{status:'cancelled'}),true);
  assert.equal(cancelledTask({...task,evidence:{...task.evidence,authoritative:false}}),false);
  assert.equal(cancelledTask({...task,observedStatus:'signed'}),false);
  const record={counts:{executionUnits:1,status:{not_available:1}},taskSummaries:[task]};
  assert.equal(ledgerCancelledCount(record),1);assert.equal(ledgerPendingCount(record),0);
});

test('ledger review filters keep pending and drift records distinct', () => {
  const pending = {counts:{executionUnits:2,status:{signed:1}}};
  const changed = {counts:{executionUnits:1,status:{signed:1}},drift:{statusChanges:[{taskId:'sample'}]}};
  assert.equal(ledgerPendingCount(pending), 1);
  assert.equal(matchesLedger(pending, 'pending'), true);
  assert.equal(matchesLedger(changed, 'pending'), false);
  assert.equal(matchesLedger(changed, 'changed'), true);
  const successReview={counts:{executionUnits:1,status:{already_signed:1}},
    drift:{classification:'status_changed',statusChanges:[{from:'signed',to:'already_signed'}]},
    changes:[{kind:'status',from:'signed',to:'already_signed'}]};
  const original=JSON.stringify(successReview);
  assert.equal(matchesLedger(successReview,'changed'),false);
  assert.equal(matchesLedger(successReview,'pending'),false);
  assert.equal(JSON.stringify(successReview),original);
  successReview.changes.push({kind:'status',from:'login_required',to:'already_signed'});
  assert.equal(matchesLedger(successReview,'changed'),true);
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
