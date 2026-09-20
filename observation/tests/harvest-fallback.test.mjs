import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planHarvestFallback,runHarvestFallback} from '../src/harvest-fallback.mjs';

const now=new Date('2026-09-20T02:00:00Z');
const failed=(origin,account='7')=>({origin,userId:account,status:'failed',observedAt:'2026-09-20T09:55:00+08:00',evidence:{source:'harvest',authoritative:false}});
const fixture=()=>({
  now,harvest:{source:'harvest',businessDate:'2026-09-20',generatedAt:'2026-09-20T09:58:00+08:00',sites:[
    failed('https://ourbits.club'),failed('https://external.example'),{origin:'https://signed.example',status:'signed',observedAt:'2026-09-20T09:55:00+08:00',evidence:{authoritative:true}},
    {origin:'https://uncertain.example',userId:'7',status:'unknown',observedAt:null}
  ],taskCompletion:{resultId:5,status:'completed',startedAt:'2026-09-20T09:14:00+08:00',completedAt:'2026-09-20T09:16:00+08:00'}},catalog:{sites:[{origin:'https://ourbits.club'},{origin:'https://external.example'},{origin:'https://signed.example'}]},
  plan:{targets:[{origin:'https://ourbits.club',folderNames:['PT白名单']}]},latest:{runId:'20260920-fixture',runState:'final',isComplete:true,results:[{origin:'https://ourbits.club',status:'deferred'}]}
});

test('only fresh explicit failure at a registered unique PT origin is eligible',()=>{
  const report=planHarvestFallback(fixture());
  assert.deepEqual(report.eligible.map(item=>item.origin),['https://ourbits.club']);
  assert.equal(report.observedSuccess,1);
  assert.deepEqual(report.blocked.map(item=>item.reason),['requires_v1_registration','outside_confirmed_bookmark_scope']);
});
test('unknown Harvest status is reviewed only after its daily task completes',()=>{
  const f=fixture();f.harvest.sites=[{origin:'https://ourbits.club',userId:'7',status:'unknown',observedAt:null,evidence:{authoritative:false}}];
  const reviewed=planHarvestFallback(f);
  assert.equal(reviewed.eligible[0].trigger,'harvest_task_done_status_unknown');
  f.harvest.taskCompletion.status='failed';assert.equal(planHarvestFallback(f).blocked[0].reason,'harvest_task_not_complete');
  f.harvest.taskCompletion.status='completed';f.latest.results[0].status='already_signed';assert.equal(planHarvestFallback(f).eligible.length,0);
  f.latest.results[0].status='needs_attention';assert.equal(planHarvestFallback(f).eligible[0].origin,'https://ourbits.club');
});
test('success, unknown, wrong account, ambiguous and stale observations never submit',()=>{
  const f=fixture();
  f.plan.targets[0].accountId='8';assert.equal(planHarvestFallback(f).eligible.length,0);
  assert.equal(planHarvestFallback(f).blocked[0].reason,'cross_system_identity_unverified');
  f.plan.targets[0].accountId='7';assert.equal(planHarvestFallback(f).eligible.length,0);
  f.plan.targets[0].accountId='7';f.harvest.sites[0].observedAt='2026-09-19T09:55:00+08:00';
  assert.equal(planHarvestFallback(f).blocked[0].reason,'stale_failure');
  f.harvest.sites[0].observedAt='2026-09-20T09:55:00+08:00';
  f.latest.results[0].status='already_signed';assert.equal(planHarvestFallback(f).eligible.length,0);
  f.latest.results[0].status='needs_attention';f.plan.targets.push({...f.plan.targets[0],accountKey:'another'});
  assert.equal(planHarvestFallback(f).blocked[0].reason,'ambiguous_legacy_account');
  f.harvest.generatedAt='2026-09-19T09:58:00+08:00';assert.throws(()=>planHarvestFallback(f),/stale/);
});
test('Harvest completion audits every registered PT task, including one absent from Harvest',()=>{
  const f=fixture();
  f.plan.targets.push({origin:'https://unobserved.example',folderNames:['PT白名单']});
  f.harvest.sites[0].status='unknown';f.harvest.sites[0].observedAt=null;f.harvest.sites[0].userId=null;
  const audit=planHarvestFallback(f);
  assert.equal(audit.registeredCount,2);
  assert.deepEqual(audit.eligible.map(item=>item.origin),['https://ourbits.club','https://unobserved.example']);
  assert.equal(audit.eligible[1].trigger,'registered_pt_status_unobserved');
  assert.equal(audit.assessments.filter(item=>item.state==='executor_recheck_queued').length,2);
  f.latest.results.push({origin:'https://unobserved.example',accountKey:'site-default',status:'already_signed'});
  assert.equal(planHarvestFallback(f).eligible.length,1);
});
test('uncertain earlier submission remains blocked even after Harvest failure',()=>{
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  f.latest.results[0].failureCode='submission_outcome_unknown';
  assert.equal(planHarvestFallback(f).blocked[0].reason,'submission_outcome_unknown');
});
test('an explicit V1 site/account disable and disabled feature cannot enter fallback',()=>{
 const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
 for(const config of [{disabledCheckinOrigins:['https://ourbits.club']},{disabledAccountKeys:['site-default']}]){
   const result=planHarvestFallback({...f,config});assert.equal(result.eligible.length,0);
   assert.equal(result.blocked[0].reason,'disabled_by_v1_configuration');
 }
 f.latest.results[0]={...f.latest.results[0],status:'not_available',availabilityKind:'feature_disabled'};
 const result=planHarvestFallback(f);assert.equal(result.eligible.length,0);
 assert.equal(result.blocked[0].reason,'v1_feature_or_task_unavailable');
});
test('a Harvest failure waits for a same-day complete V1 execution plan',()=>{
 const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
 f.latest.runId='20260919-old';assert.equal(planHarvestFallback(f).blocked[0].reason,'v1_day_not_ready');
 f.latest.runId='20260920-fixture';f.latest.isComplete=false;
 assert.equal(planHarvestFallback(f).blocked[0].reason,'v1_day_not_ready');
});
test('attempt is durable before execution, never blindly repeated and busy can retry',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  let calls=0;const success=async options=>{calls++;assert.deepEqual(options.origins,['https://ourbits.club']);return {runId:'today',results:[{origin:'https://ourbits.club',accountKey:'site-default',status:'signed'}]};};
  assert.equal((await runHarvestFallback({...f,root,execute:true,runEngine:success})).outcomes[0].v1Status,'signed');
  assert.equal((await runHarvestFallback({...f,root,execute:true,runEngine:success})).outcomes[0].state,'already_attempted');
  assert.equal(calls,1);
  const stored=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json'),'utf8'));
  assert.equal(stored.attempts[0].state,'completed');assert.equal(fs.existsSync(path.join(root,'data/harvest-fallback.lock')),false);
});
test('a V2 lock collision is not counted as an actual attempt',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-busy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  const busy=await runHarvestFallback({...f,root,execute:true,runEngine:async()=>{throw Error('V2 runner is already active');}});
  assert.equal(busy.outcomes[0].state,'deferred_busy');
  const second=await runHarvestFallback({...f,root,execute:true,runEngine:async()=>({runId:'later',results:[]})});
  assert.equal(second.outcomes[0].state,'completed');
});

test('rollback to independent V2 mode refuses Harvest fallback before a claim',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-rollback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  await assert.rejects(()=>runHarvestFallback({...f,root,execute:true,runEngine:async()=>{throw Error('must not execute');}}),/requires the V1 execution engine/);
  assert.equal(fs.existsSync(path.join(root,'outputs')),false);
});

function configureUnifiedFixture(root){
  const legacyRoot=path.join(root,'legacy');fs.mkdirSync(path.join(root,'config'),{recursive:true});
  fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot}));
  fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
}
