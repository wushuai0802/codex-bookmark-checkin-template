import test from 'node:test';
import assert from 'node:assert/strict';
import {dayVerdict} from '../public/day-verdict.mjs';
import {verdictSnapshot} from '../src/daily-reconciliation.mjs';
import {authorizedWorkload} from '../src/workload-view.mjs';

const now=new Date('2026-10-31T04:00:00Z'),businessDate='2026-10-31',at=now.toISOString();
const task=(taskId,extra={})=>({taskId,origin:`https://${taskId}.example`,businessDate,observedStatus:'needs_attention',observedAt:at,...extra});
const snapshot=tasks=>({businessDate,generatedAt:at,tasks,receipts:[]});
const project=(value,time=now)=>dayVerdict(verdictSnapshot(value,{now:time}),{now:time});
const completed={status:'signed',source:'harvest',authoritative:true,fresh:true,observedAt:at,
  evidence:{source:'harvest',authoritative:true,businessDate,confirmedAt:at}};

test('an old unknown plus today authoritative Harvest completion is done without changing facts',()=>{
  const old='2026-10-06T01:00:00Z',value=snapshot([task('one',{observedAt:old,failureCode:'submission_outcome_unknown'})]);
  value.receipts=[{taskId:'one',status:'needs_attention',observedAt:old,evidence:{authoritative:false}}];
  value.ptStatus={businessDate,sites:[{origin:value.tasks[0].origin,effective:completed}]};
  const before=JSON.stringify(value),verdict=project(value);
  assert.equal(verdict.counts.done,1);assert.equal(verdict.settled,true);assert.equal(JSON.stringify(value),before);
  assert.deepEqual(verdict.items,[{taskId:'one',class:'done'}]);
});

test('unknown outcomes and stale rows without today evidence remain verifying',()=>{
  const verdict=project(snapshot([task('unknown',{submissionAttempted:true,failureCode:'submission_outcome_unknown'}),
    task('old',{observedAt:'2026-10-06T01:00:00Z',retryable:false})]));
  assert.equal(verdict.counts.verifying,2);assert.equal(verdict.counts.actionNeeded,0);assert.equal(verdict.settled,false);
});

test('12 paused and two disabled features are excluded from effective work',()=>{
  const tasks=[...Array.from({length:12},(_,i)=>task('paused'+i,{availabilityKind:'task_disabled',disabledByConfig:true})),
    ...Array.from({length:2},(_,i)=>task('feature'+i,{availabilityKind:'feature_disabled'})),task('pending')];
  const verdict=project(snapshot(tasks));
  assert.deepEqual(verdict.counts,{done:0,verifying:1,actionNeeded:0,external:0,paused:12,noFeature:2});
  assert.equal(verdict.total,1);assert.equal(verdict.items.length,15);
});

test('completion must belong to today, including Shanghai midnight and future evidence',()=>{
  const value=snapshot([task('success',{observedStatus:'signed',observedAt:'2026-10-30T15:59:59Z',evidence:{source:'pt_page',authoritative:true}})]);
  const boundary=new Date('2026-10-30T16:00:00Z');
  assert.equal(project(value,boundary).counts.done,0);
  value.tasks[0].observedAt=boundary.toISOString();
  assert.equal(project(value,boundary).counts.done,1);
  value.tasks[0].evidence.businessDate='2026-10-30';assert.equal(project(value,boundary).counts.done,0);
  value.tasks[0].evidence.businessDate=businessDate;value.tasks[0].observedAt='2026-11-01T01:00:00Z';
  assert.equal(project(value,boundary).counts.done,0);
});

test('health, report completion, clicks and HTTP success never become a receipt',()=>{
  const value={...snapshot([task('healthy',{observedStatus:'clicked',httpStatus:200}),
    task('reported',{observedStatus:'signed',evidence:{authoritative:false}})]),healthy:true,isComplete:true};
  assert.equal(project(value).counts.done,0);assert.equal(project(value).counts.verifying,2);
});

test('maintenance, TLS, migration and current external evidence stay outside the denominator',()=>{
  const value=snapshot([task('maintenance',{siteCondition:'site_maintenance',submissionAttempted:true}),
    task('tls',{failureCode:'tls_certificate_invalid'}),task('moved',{failureCode:'site_migration'})]);
  const verdict=project(value);assert.equal(verdict.counts.external,3);assert.equal(verdict.total,0);assert.equal(verdict.settled,true);
});

test('exhausted login, manual verification and reauthorization need action; automatic retries do not',()=>{
  const verdict=project(snapshot([task('exhausted',{observedStatus:'login_required',retryExhaustedForDay:true}),
    task('retry',{observedStatus:'login_required',retryable:true,nextEligibleAt:'2026-10-31T05:00:00Z'}),
    task('manual',{observedStatus:'interactive_challenge',retryable:false}),
    task('factor',{failureCode:'two_factor_required',retryable:false}),
    task('unknown',{failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false}),
    task('notexhausted',{observedStatus:'login_required'})]));
  assert.equal(verdict.counts.actionNeeded,3);assert.equal(verdict.counts.verifying,3);
});

test('same site accounts remain independent and an unbound site receipt cannot complete both',()=>{
  const tasks=[task('a',{origin:'https://shared.example',accountRef:'acct_a'}),task('b',{origin:'https://shared.example',accountRef:'acct_b'})];
  const value={...snapshot(tasks),ptStatus:{businessDate,sites:[{origin:tasks[0].origin,accountRef:'acct_a',effective:completed}]}};
  assert.deepEqual(project(value).items,[{taskId:'a',class:'done'},{taskId:'b',class:'verifying'}]);
  delete value.ptStatus.sites[0].accountRef;assert.equal(project(value).counts.done,0);
  value.ptStatus.sites[0].accountRef='acct_a';value.receipts=[{taskId:'a',observedAt:at,evidence:{verification:'identity_conflict'}}];
  assert.equal(project(value).counts.done,0);
});

test('PT supplement inventory is exactly authorizedWorkload, deduplicated on repeated projection',()=>{
  const tasks=[task('regular')],value={...snapshot(tasks),ptStatus:{businessDate,sites:[
    {origin:tasks[0].origin,inLegacyPlan:true,fallbackEnabled:true,effective:completed},
    {origin:'https://supplement.example',fallbackEnabled:true,effective:completed},
    {origin:'https://monitor.example',fallbackEnabled:false,effective:completed},
    {origin:'https://paused.example',disabledByConfig:true,effective:{status:'unknown'}}]}};
  const workload=authorizedWorkload({...value,now:now.getTime()}),verdict=project(value);
  assert.deepEqual(verdict.items.map(item=>item.taskId).sort(),workload.tasks.map(task=>task.taskId).sort());
  assert.equal(verdict.items.length,3);assert.equal(verdict.counts.done,2);assert.equal(verdict.counts.paused,1);
  assert.deepEqual(project(verdictSnapshot(value,{now})),verdict);
});

test('Harvest waiting stays verifying; temporary maintenance is external even with an unavailable receipt',()=>{
  const verdict=project(snapshot([task('waiting',{observedStatus:'deferred',retryCause:'harvest_waiting'}),
    task('temporary',{observedStatus:'not_available',availabilityKind:'temporary_unavailable',
      evidence:{source:'pt_page',authoritative:true,verification:'feature_unavailable'}})]));
  assert.equal(verdict.counts.verifying,1);assert.equal(verdict.counts.external,1);
  assert.equal(verdict.counts.noFeature,0);assert.equal(verdict.total,1);
});

test('published explicit login-recovery refusal is actionable, health-cache success is not done',()=>{
  const verdict=project(snapshot([task('login',{retryableLoginRecovery:false}),
    task('exhausted-deferred',{observedStatus:'deferred',retryCause:'login_required',retryExhaustedForDay:true}),
    task('health',{observedStatus:'signed',evidence:{source:'health_cache',authoritative:true}})]));
  assert.equal(verdict.counts.actionNeeded,2);assert.equal(verdict.counts.verifying,1);assert.equal(verdict.counts.done,0);
});

test('newer authoritative unsigned evidence and wrong-account receipts cannot complete a task',()=>{
  const one=task('positive',{accountRef:'acct_a',observedStatus:'signed',observedAt:'2026-10-31T01:00:00Z',
    evidence:{source:'pt_page',authoritative:true}});
  const value={...snapshot([one]),ptStatus:{businessDate,sites:[{origin:one.origin,accountRef:'acct_a',
    effective:{status:'not_signed',fresh:true,authoritative:true,observedAt:at}}]}};
  assert.equal(project(value).counts.done,0);
  value.ptStatus.sites=[];value.receipts=[{taskId:one.taskId,accountRef:'acct_b',status:'signed',observedAt:at,evidence:one.evidence}];
  assert.equal(project(value).counts.done,0);
});
