import test from 'node:test';
import assert from 'node:assert/strict';
import {dayVerdict} from '../public/day-verdict.mjs';
import {verdictSnapshot} from '../src/daily-reconciliation.mjs';
import {authorizedWorkload} from '../src/workload-view.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {retainHarvestPresentation} from '../src/pt-evidence-repair.mjs';

const now=new Date('2026-10-31T04:00:00Z'),businessDate='2026-10-31',at=now.toISOString();
const task=(taskId,extra={})=>({taskId,origin:`https://${taskId}.example`,businessDate,observedStatus:'needs_attention',observedAt:at,...extra});
const snapshot=tasks=>({businessDate,generatedAt:at,tasks,receipts:[]});
const project=(value,time=now)=>dayVerdict(verdictSnapshot(value,{now:time}),{now:time});
const completed={status:'signed',source:'harvest',authoritative:true,fresh:true,observedAt:at,
  evidence:{source:'harvest',authoritative:true,businessDate,confirmedAt:at}};

function stalledSnapshot(){
  const value=snapshot([task('stalled',{observedAt:'2026-10-06T01:00:00Z',failureCode:'submission_outcome_unknown'})]);
  value.ptStatus=buildPtStatus({businessDate,generatedAt:at,monitorCatalog:{sites:[{origin:value.tasks[0].origin}]},
    externalReport:{source:'harvest',businessDate,generatedAt:at,checkinInventoryComplete:true,taskCompletion:{status:'completed'},
      sites:[{origin:value.tasks[0].origin,checkinEnabled:true,lastReceiptDay:'2026-10-28',latestActive:'2026-10-28T19:42:00+08:00',
        observedAt:null,status:'unknown',evidence:{source:'harvest',authoritative:false}}]}});
  return value;
}

test('stalled Harvest uses read-only observation context and preserves old unknown facts',()=>{
  const value=stalledSnapshot(),before=JSON.stringify(value),verdict=project(value);
  assert.equal(verdict.counts.actionNeeded,1);assert.equal(verdict.counts.verifying,0);
  assert.deepEqual(verdict.items[0],{taskId:'stalled',class:'actionNeeded',reasonCode:'harvest_stalled',lastReceiptDay:'2026-10-28',missingDays:3,
    summary:'Harvest 已 3 天没有处理这个站点，最后一次回执在 10-28，可能是站点已关闭或登录失效，请核对'});
  assert.equal(value.ptStatus.sites[0].harvestObservation.latestActive,'2026-10-28T11:42:00.000Z');
  assert.equal(JSON.stringify(value),before);
});

const notStalled={
  disabled:site=>{site.harvestObservation.checkinEnabled=false;},
  unmanaged:site=>{site.harvestManaged=false;},
  running:site=>{site.harvestObservation.taskCompletion.status='running';},
  failed:site=>{site.harvestObservation.taskCompletion.status='failed';},
  missingTask:site=>{delete site.harvestObservation.taskCompletion;},
  staleHarvest:site=>{site.harvestObservation.businessDate='2026-10-30';},
  yesterdayReceipt:site=>{site.harvestObservation.lastReceiptDay='2026-10-30';},
  nullReceipt:site=>{site.harvestObservation.lastReceiptDay=null;},
  futureReceipt:site=>{site.harvestObservation.lastReceiptDay='2026-11-01';},
  invalidReceipt:site=>{site.harvestObservation.lastReceiptDay='2026-02-30';},
  reader:site=>{site.capabilities.read=true;},
  unknownReader:site=>{delete site.capabilities;},
  todayReceipt:site=>{site.harvestObservation.lastReceiptDay=businessDate;},
  todayNegative:site=>{site.effective={...completed,status:'not_signed'};},
  observedReceipt:site=>{site.observations=[{...completed,status:'not_signed'}];}
};
for(const [name,change] of Object.entries(notStalled))test('Harvest stalled rejects '+name,()=>{
  const value=stalledSnapshot();change(value.ptStatus.sites[0]);
  assert.equal(project(value).items[0].class,'verifying');assert.equal(project(value).items[0].reasonCode,undefined);
});

test('two missing calendar days qualify; today recovery and another legal completion win',()=>{
  const value=stalledSnapshot(),site=value.ptStatus.sites[0];
  site.harvestObservation.lastReceiptDay='2026-10-29';assert.equal(project(value).items[0].reasonCode,'harvest_stalled');
  site.effective=completed;assert.equal(project(value).items[0].class,'done');
  site.effective={...completed,source:'execution-supplement',evidence:{...completed.evidence,source:'pt_page'}};
  assert.equal(project(value).items[0].class,'done');
  // A maintenance gap that recovered today is not stalled, even with old unknown history.
  site.harvestObservation.lastReceiptDay=businessDate;site.recovery={code:'prior_outcome_unknown',blockedSince:'2026-10-06'};
  assert.equal(project(value).items[0].class,'done');
  // A site the user paused stays out of the denominator even with a receipt today.
  value.tasks[0].disabledByConfig=true;assert.equal(project(value).items[0].class,'paused');
});

test('paused and current external conditions precede stalled Harvest',()=>{
  const value=stalledSnapshot(),site=value.ptStatus.sites[0];
  site.effective={...completed,status:'unknown',authoritative:false,siteCondition:'site_maintenance'};
  assert.equal(project(value).items[0].class,'external');
  value.tasks[0].disabledByConfig=true;assert.equal(project(value).items[0].class,'paused');
  const paused=stalledSnapshot();paused.ptStatus.sites[0].disabledByConfig=true;
  assert.equal(project(paused).items[0].reasonCode,undefined);
});

test('passive dashboard rebuild retains dated Harvest display context without a waiting window',()=>{
  const previous=stalledSnapshot(),rebuilt=structuredClone(previous);
  delete rebuilt.ptStatus.sites[0].harvestObservation;delete rebuilt.ptStatus.sites[0].harvestManaged;
  retainHarvestPresentation(rebuilt,previous);assert.deepEqual(project(rebuilt),project(previous));
  assert.notEqual(rebuilt.ptStatus.sites[0].harvestObservation,previous.ptStatus.sites[0].harvestObservation);
  const foreign={...rebuilt,businessDate:'2026-11-01',ptStatus:{sites:[{origin:previous.tasks[0].origin}]}};
  retainHarvestPresentation(foreign,previous);assert.equal(foreign.ptStatus.sites[0].harvestObservation,undefined);
});

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
