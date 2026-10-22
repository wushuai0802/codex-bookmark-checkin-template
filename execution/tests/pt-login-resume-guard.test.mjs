import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validatePtLoginResume} from '../src/pt-login-resume-guard.mjs';
import {ptExecutionBinding} from '../src/pt-read-policy.mjs';
import {acquireRunLock,releaseRunLock} from '../src/run-lock.mjs';

const origin='https://hhanclub.net',date='2026-10-14',now=new Date(date+'T01:00:00Z');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pt-login-resume-')),
    root=path.join(directory,'execution'),controller=path.join(directory,'controller');
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const part of ['execution/config','execution/data/profile','execution/tmp','controller/config','controller/data','controller/outputs','controller/src'])
    fs.mkdirSync(path.join(directory,part),{recursive:true});
  const config={automationUserDataDir:path.join(root,'data/profile')},configFile=path.join(root,'config/config.json');
  write(configFile,config);
  const binding=ptExecutionBinding(config,root,{origin,accountKey:'site-default'}),nonce=crypto.randomUUID(),workerNonce=crypto.randomUUID();
  const runtimeFile=path.join(controller,'config/runtime.local.json');
  write(runtimeFile,{executionEngine:'v1',legacyRoot:root,ptFallbackOnlyEnabled:true});
  write(path.join(root,'data/v2-integration.json'),{executionEngine:'v1',v2ProjectRoot:controller});
  const leaseFile=path.join(controller,'data/v2-run.lock'),workerFile=path.join(controller,'data/harvest-fallback.lock'),lockFile=path.join(root,'tmp/run.lock');
  write(leaseFile,{schemaVersion:1,pid:process.pid,nonce});
  write(workerFile,{schemaVersion:1,pid:process.pid,nonce:workerNonce,startedAt:now.toISOString()});
  const processStartedAt=new Date(now.getTime()-60_000).toISOString();
  write(lockFile,{version:1,pid:process.pid,nonce:crypto.randomUUID(),processStartedAt});
  fs.writeFileSync(path.join(controller,'src/legacy-engine.mjs'),
    `export {validateEngineLease} from ${JSON.stringify(new URL('../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  fs.writeFileSync(path.join(controller,'src/pt-reconciliation.mjs'),
    `export {ptAttemptReconciled} from ${JSON.stringify(new URL('../../observation/src/pt-reconciliation.mjs',import.meta.url).href)};`);
  const saved=new Map(['CHECKIN_V2_ENGINE_ROOT','CHECKIN_V2_ENGINE_LEASE'].map(key=>[key,process.env[key]]));
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{for(const [key,value] of saved)if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const attempt={attemptId:crypto.randomUUID(),origin,accountKey:'site-default',businessDate:date,
    startedAt:now.toISOString(),state:'in_progress',workerPid:process.pid,workerNonce};
  const journal={schemaVersion:1,businessDate:date,attempts:[attempt]},file=path.join(controller,'outputs/harvest-fallback-attempts-'+date+'.json');
  write(file,journal);
  return {root,controller,config,configFile,runtimeFile,leaseFile,workerFile,lockFile,attempt,journal,file,
    save:()=>write(file,journal),saveConfig:()=>write(configFile,config),
    args:{root,origin,accountKey:'site-default',profileBinding:binding.profileBinding,attemptId:attempt.attemptId,now,
      inspectOwner:async pid=>({alive:pid===process.pid,startedAt:processStartedAt})}};
}

test('only its live parent attempt authorizes a first dispatch and no evidence or journal is written',async t=>{
  const f=fixture(t),before=fs.readFileSync(f.file,'utf8'),files=fs.readdirSync(path.dirname(f.file));
  assert.deepEqual(await validatePtLoginResume(f.args),{allowed:true,reason:'first_dispatch_after_login'});
  assert.equal(fs.readFileSync(f.file,'utf8'),before);assert.deepEqual(fs.readdirSync(path.dirname(f.file)),files);
});

test('the actual current Node process ownership satisfies the production execution-lock inspection',async t=>{
  const f=fixture(t);fs.rmSync(f.lockFile);
  const lease=await acquireRunLock(f.lockFile);
  try{
    delete f.args.inspectOwner;
    assert.deepEqual(await validatePtLoginResume(f.args),{allowed:true,reason:'first_dispatch_after_login'});
  }finally{await releaseRunLock(lease);}
});

test('the real PT CLI forwards only an explicitly supplied parent attempt and keeps old invocations unchanged',t=>{
  const f=fixture(t),script=path.join(f.root,'scripts/Run-PtSupplement.mjs'),sourceRoot=fileURLToPath(new URL('../',import.meta.url));
  fs.mkdirSync(path.dirname(script));fs.mkdirSync(path.join(f.root,'src'));
  fs.copyFileSync(path.join(sourceRoot,'scripts/Run-PtSupplement.mjs'),script);
  fs.writeFileSync(path.join(f.root,'src/pt-supplement.mjs'),
    'export async function runPtSupplement(options){return {receivedAttempt:options.fallbackAttemptId??null,readOnly:options.readOnly,verify:options.verifyBeforeSubmit};}');
  fs.writeFileSync(path.join(f.root,'src/bookmarks.mjs'),'export async function readBookmarkPlan(){return {targets:[]};}');
  fs.writeFileSync(path.join(f.controller,'src/monitor-catalog.mjs'),'export function validateCurrentPtCatalog(){return true;}');
  const args=[script,origin,path.join(f.root,'catalog.json'),'a'.repeat(64)];
  for(const supplied of [false,true]){
    const env={...process.env};delete env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
    if(supplied)env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=f.attempt.attemptId;
    const value=JSON.parse(execFileSync(process.execPath,args,{env,encoding:'utf8',windowsHide:true}));
    assert.deepEqual(value,{receivedAttempt:supplied?f.attempt.attemptId:null,readOnly:false,verify:false});
  }
});

test('exact account, profile, request identity and pause configuration are required',async t=>{
  for(const change of ['account','profile','id','origin','pause'])await t.test(change,async t=>{
    const f=fixture(t);
    if(change==='account')f.args.accountKey='other';
    if(change==='profile')f.args.profileBinding='a'.repeat(64);
    if(change==='id')f.args.attemptId='not-an-attempt';
    if(change==='origin')f.args.origin='https://other.example';
    if(change==='pause'){f.config.disabledCheckinOrigins=[origin];f.saveConfig();}
    assert.equal((await validatePtLoginResume(f.args)).allowed,false);
  });
});

test('missing controller lease or execution ownership cannot borrow or release a task lock',async t=>{
  for(const change of ['lease','runtime','execution_owner','execution_nonce','worker','worker_nonce'])await t.test(change,async t=>{
    const f=fixture(t);
    if(change==='lease')process.env.CHECKIN_V2_ENGINE_LEASE='wrong';
    if(change==='runtime')write(f.runtimeFile,{executionEngine:'v1',legacyRoot:f.root,ptFallbackOnlyEnabled:false});
    if(change==='execution_owner')write(f.lockFile,{...read(f.lockFile),pid:process.pid+1});
    if(change==='execution_nonce')write(f.lockFile,{...read(f.lockFile),nonce:'invalid'});
    if(change==='worker')fs.rmSync(f.workerFile);
    if(change==='worker_nonce'){f.attempt.workerNonce=crypto.randomUUID();f.save();}
    const lockBefore=fs.readFileSync(f.lockFile,'utf8');
    assert.equal((await validatePtLoginResume(f.args)).allowed,false);
    assert.equal(fs.readFileSync(f.lockFile,'utf8'),lockBefore);
  });
});

test('only one current in-progress attempt can be excluded and it must remain undispatched',async t=>{
  for(const change of ['duplicate','missing','completed','future','wrong_day','wrong_owner','outcome'])await t.test(change,async t=>{
    const f=fixture(t);
    if(change==='duplicate')f.journal.attempts.push({...f.attempt});
    if(change==='missing')f.args.attemptId=crypto.randomUUID();
    if(change==='completed')f.attempt.state='completed';
    if(change==='future')f.attempt.startedAt=new Date(now.getTime()+1).toISOString();
    if(change==='wrong_day')f.attempt.businessDate='2026-10-13';
    if(change==='wrong_owner')delete f.attempt.workerPid;
    if(change==='outcome')f.attempt.outcome={submissionAttempted:false};
    f.save();assert.equal((await validatePtLoginResume(f.args)).allowed,false);
  });
});

test('another same-day write, unknown or completed attempt is never ignored by origin',async t=>{
  for(const extra of [
    {state:'in_progress'}, {state:'outcome_unknown'}, {state:'completed_cross_day'},
    {state:'completed',v1Status:'unknown',outcome:{}},
    {state:'completed',v1Status:'needs_attention',outcome:{submissionAttempted:true}},
    {state:'completed',v1Status:'already_signed',outcome:{submissionAttempted:false}},
    {state:'completed',outcome:{status:'failed',submissionAttempted:true}},
  ]){
    const f=fixture(t);f.journal.attempts.push({...f.attempt,attemptId:crypto.randomUUID(),...extra});f.save();
    assert.equal((await validatePtLoginResume(f.args)).allowed,false);
  }
});

test('historical unresolved attempts block, while prior-day confirmed/manual closure remains audit-only',async t=>{
  for(const closed of [false,true]){
    const f=fixture(t),priorDate='2026-10-13',priorAttempt={...f.attempt,attemptId:crypto.randomUUID(),businessDate:priorDate,
      startedAt:priorDate+'T01:00:00Z',state:'outcome_unknown'},prior={schemaVersion:1,businessDate:priorDate,attempts:[priorAttempt]};
    if(closed)prior.reconciliations=[{attemptId:priorAttempt.attemptId,origin,accountKey:'site-default',businessDate:priorDate,
      kind:'closed_manual',operatorConfirmed:true}];
    write(path.join(f.controller,'outputs/harvest-fallback-attempts-'+priorDate+'.json'),prior);
    assert.equal((await validatePtLoginResume(f.args)).allowed,closed);
  }
});

test('manual same-day closure does not manufacture permission to replay a prior unknown',async t=>{
  const f=fixture(t),old={...f.attempt,attemptId:crypto.randomUUID(),state:'outcome_unknown'};
  f.journal.attempts.push(old);f.journal.reconciliations=[{attemptId:old.attemptId,origin,accountKey:'site-default',businessDate:date,
    kind:'closed_manual',operatorConfirmed:true}];f.save();
  assert.equal((await validatePtLoginResume(f.args)).allowed,false);
});

test('explicit non-submission outcomes and other sites do not turn into unknown submissions',async t=>{
  const f=fixture(t);
  f.journal.attempts.push({...f.attempt,attemptId:crypto.randomUUID(),state:'completed',v1Status:'login_required',
    submissionState:'not_submitted',outcome:{submissionAttempted:false}});
  f.journal.attempts.push({...f.attempt,attemptId:crypto.randomUUID(),origin:'https://other.example',state:'outcome_unknown'});
  f.save();assert.equal((await validatePtLoginResume(f.args)).allowed,true);
});

test('existing same-day success or a malformed status report cannot grant another dispatch',async t=>{
  for(const value of [
    {schemaVersion:1,source:'execution-supplement',businessDate:date,sites:[{origin,accountKey:'site-default',status:'signed'}]},
    {schemaVersion:1,source:'execution-supplement',businessDate:date,sites:[{origin,status:'needs_attention',submissionOutcomeUnknown:true}]},
    {schemaVersion:1,source:'other',businessDate:date,sites:[]},
  ]){
    const f=fixture(t);write(path.join(f.controller,'outputs/pt-fallback-results-'+date+'.json'),value);
    assert.equal((await validatePtLoginResume(f.args)).allowed,false);
  }
});

test('missing, damaged or inconsistent audit files fail closed',async t=>{
  for(const change of ['missing','json','schema','date','rows','row']){
    const f=fixture(t);
    if(change==='missing')fs.rmSync(f.file);
    if(change==='json')fs.writeFileSync(f.file,'{broken');
    if(change==='schema')write(f.file,{...f.journal,schemaVersion:2});
    if(change==='date')write(f.file,{...f.journal,businessDate:'2026-10-13'});
    if(change==='rows')write(f.file,{...f.journal,attempts:{}});
    if(change==='row')write(f.file,{...f.journal,attempts:[null]});
    assert.deepEqual(await validatePtLoginResume(f.args),{allowed:false,reason:'journal_unavailable'});
  }
});

test('business-day and execution nonce changes prevent a resumed first dispatch',async t=>{
  const next=fixture(t);next.args.now=new Date('2026-10-15T01:00:00Z');
  assert.equal((await validatePtLoginResume(next.args)).allowed,false);
  const changed=fixture(t),inspect=changed.args.inspectOwner;
  changed.args.inspectOwner=async pid=>{const value=await inspect(pid);write(changed.lockFile,{...read(changed.lockFile),nonce:crypto.randomUUID()});return value;};
  assert.deepEqual(await validatePtLoginResume(changed.args),{allowed:false,reason:'execution_lock_unavailable'});
});
