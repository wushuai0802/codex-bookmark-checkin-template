import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {runNativePtGate,nativePtDecision,nativePtNavigationRisk} from '../src/native-pt-gate.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pt-gate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data/profile','logs','tmp'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const origin='https://native.example',profile=path.join(root,'data/profile'),url=origin+'/attendance.php';
  const target={origin,candidates:[url],allowedOrigins:[origin],folderNames:['PT']};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:profile,nativeWafPreflightUrls:[url]}));
  const now=new Date('2026-10-02T03:00:00Z');
  return {root,origin,url,profile,now,readPlan:async()=>({targets:[target]}),harvest:()=>null,verify:()=>null};
}
const proof=now=>({source:'page_text',authoritative:true,businessDate:'2026-10-02',confirmedAt:now.toISOString(),pagePath:'/index.php'});
function attachController(t,args){
  const controller=path.join(args.root,'controller'),nonce=crypto.randomUUID();
  for(const dir of ['config','data','outputs'])fs.mkdirSync(path.join(controller,dir),{recursive:true});
  fs.writeFileSync(path.join(args.root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:args.root}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  const oldRoot=process.env.CHECKIN_V2_ENGINE_ROOT,oldLease=process.env.CHECKIN_V2_ENGINE_LEASE;
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{if(oldRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=oldRoot;
    if(oldLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=oldLease;});
  return value=>fs.writeFileSync(path.join(controller,'outputs/pt-fallback-results-2026-10-02.json'),
    JSON.stringify({source:'execution-supplement',businessDate:'2026-10-02',sites:[value]}));
}
const unsignedReceipt=(args,binding,now)=>({origin:args.origin,accountKey:'site-default',profileBinding:binding,
  status:'not_signed',businessDate:'2026-10-02',observedAt:now.toISOString(),submissionAttempted:false,
  readSafety:'reviewed_passive',operationMode:'safe_history_page',
  evidence:{...proof(now),evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}});

test('native selection refuses unknown submissions and future cooldown before opening a browser',()=>{
  const now=new Date('2026-10-02T03:00:00Z');
  const uncertain=nativePtDecision({prior:{status:'needs_attention',submissionAttempted:true,failureCode:'submission_outcome_unknown'},now});
  assert.equal(uncertain.failureCode,'submission_outcome_unknown');assert.equal(uncertain.retryable,false);
  const delayed=nativePtDecision({prior:{status:'deferred',retryCause:'rate_limit',nextEligibleAt:'2026-10-02T04:00:00Z'},now});
  assert.equal(delayed.nextEligibleAt,'2026-10-02T04:00:00Z');assert.equal(delayed.submissionAttempted,false);
  assert.equal(nativePtDecision({prior:{status:'deferred',nextEligibleAt:'2026-10-02T02:59:00Z'},now}),null);
  const readback={status:'already_signed',evidence:proof(now)};
  assert.equal(nativePtDecision({pending:true,receipt:readback,now}).status,'already_signed');
  assert.equal(nativePtDecision({pending:true,unsigned:true,now}).failureCode,'submission_outcome_unknown');
  const unsigned=proof(new Date(now.getTime()-1000));
  assert.equal(nativePtDecision({prior:{status:'already_signed'},receipt:{status:'already_signed',evidence:proof(now)},unsigned,now}).status,'already_signed');
  assert.equal(nativePtDecision({pending:true,receipt:{status:'already_signed',evidence:proof(now)},unsigned,now}).status,'already_signed');
  assert.equal(nativePtDecision({pending:true,unsigned:proof(now),now}),null);
  assert.equal(nativePtDecision({pending:true,unsigned:proof(new Date(now.getTime()-300001)),now}).failureCode,'submission_outcome_unknown');
  assert.equal(nativePtDecision({pending:true,unsigned:proof(new Date(now.getTime()+1)),now}).failureCode,'submission_outcome_unknown');
  assert.equal(nativePtDecision({prior:{status:'deferred',retryCause:'rate_limit',nextEligibleAt:'2026-10-02T04:00:00Z'},unsigned:proof(now),now}).retryCause,'rate_limit');
  assert.equal(nativePtDecision({prior:{status:'signed'},reportedToday:true,now}).failureCode,'authoritative_status_unavailable');
  assert.equal(nativePtDecision({prior:{status:'signed'},reportedToday:false,now}),null);
  assert.equal(nativePtNavigationRisk('https://native.example/index.php'),false);
  assert.equal(nativePtNavigationRisk('https://native.example/attendance.php'),true);
  assert.equal(nativePtNavigationRisk('https://native.example/index.php?action=sign'),true);
});

test('native intent is durable before dispatch; new processes and midnight cannot replay it',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();let checks=0;
  const harvest=()=>{checks++;return null;};
  const start=await runNativePtGate({...args,harvest,phase:'begin',attemptId,action:'navigation'});
  assert.equal(start.allow,true);assert.equal(start.submissionAttempted,true);assert.equal(checks,1);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts[0].state,'submitted');
  assert.equal((await runNativePtGate({...args,phase:'inspect',attemptId:crypto.randomUUID()})).decision.failureCode,'submission_outcome_unknown');
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'})).allow,false);
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId,action:'click',now:new Date('2026-10-02T16:00:01Z')})).allow,false);
});

test('Harvest is checked again before a click and a closed gate creates no second action intent',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'});
  const result=await runNativePtGate({...args,phase:'begin',attemptId,action:'click',harvest:()=>({status:'deferred',retryCause:'harvest_waiting',submissionAttempted:false})});
  assert.equal(result.allow,false);assert.equal(result.decision.retryCause,'harvest_waiting');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0].actions,['navigation']);
});

test('only dated authoritative completion closes an intent; current proof prevents another submission',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'click'});
  await runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:{authoritative:true,businessDate:'2026-10-01',confirmedAt:'2026-10-01T03:00:00Z'}});
  assert.equal((await runNativePtGate({...args,phase:'inspect'})).allow,false);
  await runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:proof(args.now)});
  assert.equal(JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0].state,'confirmed');
  const afterCrash=await runNativePtGate({...args,phase:'inspect'});
  assert.equal(afterCrash.allow,false);assert.equal(afterCrash.decision.status,'already_signed');
  const binding=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0].profileBinding;
  const result=await runNativePtGate({...args,phase:'inspect',verify:()=>({status:'already_signed',profileBinding:binding,evidence:proof(args.now)})});
  assert.equal(result.allow,false);assert.equal(result.decision.status,'already_signed');assert.equal(result.decision.submissionAttempted,false);
});

test('bound same-day readback durably resolves a lost native response without poisoning the next business day',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId,action:'click'});
  const confirmed=new Date(args.now.getTime()+1000);
  const verify=()=>({status:'already_signed',profileBinding:started.profileBinding,evidence:proof(confirmed)});
  assert.equal((await runNativePtGate({...args,now:confirmed,verify})).decision.status,'already_signed');
  const saved=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0];
  assert.equal(saved.state,'confirmed');assert.equal(saved.resolution,'passive_readback');
  assert.equal((await runNativePtGate({...args,now:new Date('2026-10-02T16:00:01Z')})).allow,true);
});

test('scope, lease and profile changes fail before a durable write',async t=>{
  const args=fixture(t),base={...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'};
  assert.equal((await runNativePtGate({...base,readPlan:async()=>({targets:[]})})).allow,false);
  await assert.rejects(()=>runNativePtGate({...base,profile:path.join(args.root,'other')}),/profile mismatch/);
  const controller=path.join(args.root,'controller');fs.mkdirSync(path.join(controller,'config'),{recursive:true});
  fs.writeFileSync(path.join(args.root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  await assert.rejects(()=>runNativePtGate(base),/lease/);
  assert.equal(fs.existsSync(path.join(args.root,'data/native-pt-attempts.json')),false);
});

test('fresh bound not-signed proof permits one guarded recovery and retains the old intent audit',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId,action:'click'});
  const controller=path.join(args.root,'controller'),nonce=crypto.randomUUID();
  for(const dir of ['config','data','outputs'])fs.mkdirSync(path.join(controller,dir),{recursive:true});
  fs.writeFileSync(path.join(args.root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:args.root}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  const oldRoot=process.env.CHECKIN_V2_ENGINE_ROOT,oldLease=process.env.CHECKIN_V2_ENGINE_LEASE;
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{if(oldRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=oldRoot;
    if(oldLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=oldLease;});
  const now=new Date(args.now.getTime()+2000),receipt={origin:args.origin,accountKey:'site-default',profileBinding:started.profileBinding,
    status:'not_signed',businessDate:'2026-10-02',observedAt:now.toISOString(),submissionAttempted:false,readSafety:'reviewed_passive',operationMode:'safe_history_page',
    evidence:{...proof(now),evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};
  const file=path.join(controller,'outputs/pt-fallback-results-2026-10-02.json');
  const save=value=>fs.writeFileSync(file,JSON.stringify({source:'execution-supplement',businessDate:'2026-10-02',sites:[value]}));
  save({...receipt,profileBinding:'b'.repeat(64)});
  assert.equal((await runNativePtGate({...args,now,phase:'inspect'})).allow,false);
  save(receipt);
  const recovered=await runNativePtGate({...args,now,phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  assert.equal(recovered.allow,true);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts.length,2);assert.equal(journal.attempts[0].state,'resolved_not_signed');
  assert.equal(journal.attempts[1].state,'submitted');
});

test('an older unsigned proof cannot replay after a newer confirmed native success',async t=>{
  const args=fixture(t),initial=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId:initial,action:'click'});
  const save=attachController(t,args),unsignedAt=new Date(args.now.getTime()+2000);
  save(unsignedReceipt(args,started.profileBinding,unsignedAt));
  const recovery=crypto.randomUUID();
  assert.equal((await runNativePtGate({...args,now:unsignedAt,phase:'begin',attemptId:recovery,action:'navigation'})).allow,true);
  const confirmed=new Date(args.now.getTime()+3000);
  await runNativePtGate({...args,now:confirmed,phase:'finish',attemptId:recovery,status:'signed',evidence:proof(confirmed)});
  const blocked=await runNativePtGate({...args,now:new Date(args.now.getTime()+4000),phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  assert.equal(blocked.allow,false);assert.equal(blocked.decision.status,'already_signed');
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts.length,2);assert.equal(journal.attempts[0].state,'resolved_not_signed');
  assert.equal(journal.attempts[1].state,'confirmed');
});

test('a newer unsigned proof can supersede an old completion once, then a new intent consumes it',async t=>{
  const args=fixture(t),initial=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId:initial,action:'click'});
  const completeAt=new Date(args.now.getTime()+1000);
  await runNativePtGate({...args,now:completeAt,phase:'finish',attemptId:initial,status:'signed',evidence:proof(completeAt)});
  const save=attachController(t,args),unsignedAt=new Date(args.now.getTime()+2000);
  const staleVerified=()=>({status:'already_signed',profileBinding:started.profileBinding,evidence:proof(args.now)});
  save(unsignedReceipt(args,started.profileBinding,unsignedAt));
  const recovery=crypto.randomUUID();
  assert.equal((await runNativePtGate({...args,verify:staleVerified,now:unsignedAt,phase:'begin',attemptId:recovery,action:'navigation'})).allow,true);
  assert.equal((await runNativePtGate({...args,verify:staleVerified,now:new Date(args.now.getTime()+3000),phase:'begin',attemptId:recovery,action:'click'})).allow,true);
  const blocked=await runNativePtGate({...args,now:new Date(args.now.getTime()+4000),phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  assert.equal(blocked.allow,false);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts.length,2);assert.equal(journal.attempts[0].state,'confirmed');
  assert.deepEqual(journal.attempts[1].actions,['navigation','click']);
});

test('newest persisted success wins over an older readback and malformed unsigned receipts',async t=>{
  const args=fixture(t),initial=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId:initial,action:'click'});
  const completeAt=new Date(args.now.getTime()+1000);
  await runNativePtGate({...args,now:completeAt,phase:'finish',attemptId:initial,status:'signed',evidence:proof(completeAt)});
  const save=attachController(t,args),unsignedAt=new Date(args.now.getTime()+2000),base=unsignedReceipt(args,started.profileBinding,unsignedAt);
  const verify=()=>({status:'already_signed',profileBinding:started.profileBinding,evidence:proof(args.now)});
  for(const value of [{...base,observedAt:'invalid'},
    {...base,evidence:{...base.evidence,statusSignal:'generic_page_text'}},
    {...base,profileBinding:'b'.repeat(64)}]){
    save(value);
    const result=await runNativePtGate({...args,now:unsignedAt,verify});
    assert.equal(result.allow,false);assert.equal(result.decision.evidence.confirmedAt,completeAt.toISOString());
  }
});

test('a bound newer passive non-completion closes the old intent audit without dispatching a new action',async t=>{
  const args=fixture(t),initial=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId:initial,action:'click'});
  const save=attachController(t,args),now=new Date(args.now.getTime()+2000);
  save(unsignedReceipt(args,started.profileBinding,now));
  const result=await runNativePtGate({...args,now,phase:'inspect'});
  assert.equal(result.allow,true);assert.equal(result.submissionAttempted,undefined);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts.length,1);assert.deepEqual(journal.attempts[0].actions,['click']);
  assert.equal(journal.attempts[0].state,'resolved_not_signed');
  assert.equal(journal.attempts[0].resolution,'passive_readback_not_signed');
  assert.equal(journal.attempts[0].readbackEvidence.confirmedAt,now.toISOString());
});

test('today negative readback can authorize today without rewriting a historical unknown outcome',async t=>{
  const args=fixture(t),initial=crypto.randomUUID(),yesterday=new Date('2026-10-01T03:00:00Z');
  const started=await runNativePtGate({...args,now:yesterday,phase:'begin',attemptId:initial,action:'click'});
  const save=attachController(t,args);
  save(unsignedReceipt(args,started.profileBinding,args.now));
  assert.equal((await runNativePtGate({...args,phase:'inspect'})).allow,true);
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'})).allow,true);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts.length,2);assert.equal(journal.attempts[0].state,'submitted');
  assert.equal(journal.attempts[0].businessDate,'2026-10-01');assert.equal(journal.attempts[0].resolvedAt,undefined);
  assert.equal(journal.attempts[1].businessDate,'2026-10-02');
});
