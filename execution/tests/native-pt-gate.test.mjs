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
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:profile,nativeWafPreflightUrls:[url],
    ptReadOnlyPolicies:{[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block'}}}));
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
  const readbackCooldown={status:'deferred',retryCause:'native_readback_unavailable',nextEligibleAt:'2026-10-02T04:00:00Z'};
  assert.equal(nativePtDecision({prior:readbackCooldown,unsigned,now}),null);
  assert.equal(nativePtDecision({prior:readbackCooldown,now}).status,'deferred');
  assert.equal(nativePtDecision({prior:{...readbackCooldown,retryCause:'rate_limit'},unsigned,now}).status,'deferred');
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

test('native intent permits navigation then click only and rejects terminal replay',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'});
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId,action:'click'})).allow,true);
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'})).allow,false);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  journal.attempts[0].state='resolved_not_signed';fs.writeFileSync(path.join(args.root,'data/native-pt-attempts.json'),JSON.stringify(journal));
  assert.equal((await runNativePtGate({...args,phase:'begin',attemptId,action:'click'})).allow,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0].actions,['navigation','click']);
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

test('native finish rejects an explicitly wrong profile or evidence scope',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'click'});
  const binding=crypto.createHash('sha256').update(path.resolve(args.profile).toLowerCase()).digest('hex');
  const bad={...proof(args.now),profileBinding:'b'.repeat(64),evidenceScope:'other'};
  await runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:bad});
  const saved=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0];
  assert.equal(saved.state,'submitted');assert.equal(saved.profileBinding,binding);
});

test('registered formal attendance success closes its bound journal across restart and the next day',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  const started=await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'});
  const finished=new Date(args.now.getTime()+1000),evidence={...proof(finished),pagePath:'/attendance.php',
    statusSignal:'same_day_page_text',profileBinding:started.profileBinding,evidenceScope:'site_account_day'};
  const result=await runNativePtGate({...args,now:finished,phase:'finish',attemptId,status:'signed',evidence});
  assert.equal(result.allow,true);assert.equal(result.confirmed,true);assert.equal(result.confirmationState,'confirmed');
  const file=path.join(args.root,'data/native-pt-attempts.json');
  const saved=JSON.parse(fs.readFileSync(file)).attempts[0];
  assert.equal(saved.state,'confirmed');assert.equal(saved.evidence.pagePath,'/attendance.php');
  assert.equal(saved.profileBinding,started.profileBinding);
  // Re-import the gate, simulating a fresh executor with only durable state.
  const restarted=await import('../src/native-pt-gate.mjs?restart='+crypto.randomUUID());
  const noReplay=await restarted.runNativePtGate({...args,now:new Date(finished.getTime()+1000),
    phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  assert.equal(noReplay.allow,false);assert.equal(noReplay.decision.status,'already_signed');
  assert.equal(noReplay.decision.submissionAttempted,false);
  assert.equal(JSON.parse(fs.readFileSync(file)).attempts.length,1);
  const tomorrow=await restarted.runNativePtGate({...args,now:new Date('2026-10-03T03:00:00Z'),phase:'inspect'});
  assert.equal(tomorrow.allow,true);assert.equal(tomorrow.decision,undefined);
  assert.equal(JSON.parse(fs.readFileSync(file)).attempts[0].state,'confirmed');
});

test('formal finish rejects foreign, unsafe, unregistered or undated paths without pretending to confirm',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'});
  for(const pagePath of [undefined,'https://foreign.example/attendance.php','/logout.php','/submit.php',
    '/unregistered.php','/attendance.php?sign=1','/attendance.php#done']){
    const result=await runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:{...proof(args.now),pagePath}});
    assert.equal(result.allow,false,String(pagePath));assert.equal(result.confirmed,false);
    assert.equal(result.confirmationState,'rejected');assert.equal(result.decision.failureCode,'submission_outcome_unknown');
    assert.equal(result.submissionAttempted,true);assert.equal(result.decision.retryable,false);
    const saved=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json'))).attempts[0];
    assert.equal(saved.state,'submitted');assert.equal(saved.evidence,undefined);
  }
});

test('formal finish refuses stale or corrupt intent dates and absent owners',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'navigation'});
  const file=path.join(args.root,'data/native-pt-attempts.json'),journal=JSON.parse(fs.readFileSync(file));
  journal.attempts[0].businessDate='2026-10-01';fs.writeFileSync(file,JSON.stringify(journal));
  const invalid=await runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:proof(args.now)});
  assert.equal(invalid.allow,false);assert.equal(invalid.confirmed,false);
  journal.attempts[0].businessDate='2026-10-02';fs.writeFileSync(file,JSON.stringify(journal));
  const nextDay=new Date('2026-10-03T03:00:00Z');
  const stale=await runNativePtGate({...args,now:nextDay,phase:'finish',attemptId,status:'signed',
    evidence:{...proof(nextDay),businessDate:'2026-10-03',pagePath:'/attendance.php'}});
  assert.equal(stale.allow,false);assert.equal(stale.confirmed,false);
  const absent=await runNativePtGate({...args,phase:'finish',attemptId:crypto.randomUUID(),status:'signed',evidence:proof(args.now)});
  assert.equal(absent.allow,false);assert.equal(absent.confirmed,false);
  assert.equal(JSON.parse(fs.readFileSync(file)).attempts[0].state,'submitted');
});

test('current positive proof does not fabricate a binding or success for an unbound historical intent',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  const started=await runNativePtGate({...args,now:new Date('2026-10-01T03:00:00Z'),phase:'begin',attemptId,action:'navigation'});
  const file=path.join(args.root,'data/native-pt-attempts.json'),journal=JSON.parse(fs.readFileSync(file));
  delete journal.attempts[0].profileBinding;fs.writeFileSync(file,JSON.stringify(journal));
  const result=await runNativePtGate({...args,phase:'inspect',verify:()=>({status:'already_signed',
    profileBinding:started.profileBinding,evidence:proof(args.now)})});
  assert.equal(result.allow,false);assert.equal(result.decision.status,'already_signed');
  const saved=JSON.parse(fs.readFileSync(file)).attempts[0];
  assert.equal(saved.state,'submitted');assert.equal(saved.profileBinding,undefined);
  assert.equal(saved.businessDate,'2026-10-01');assert.equal(saved.evidence,undefined);
  await assert.rejects(()=>runNativePtGate({...args,phase:'finish',attemptId,status:'signed',evidence:proof(args.now)}),
    /binding mismatch/);
});

test('explicit main Chrome binding leaves an inactive automation intent as audit-only',async t=>{
  const args=fixture(t),mainRoot=path.join(args.root,'main-chrome'),mainProfile=path.join(mainRoot,'Default');
  fs.mkdirSync(mainProfile,{recursive:true});fs.writeFileSync(path.join(mainRoot,'Local State'),'fixture');
  fs.writeFileSync(path.join(mainProfile,'Bookmarks'),'{}');
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  config.sourceUserDataDir=mainRoot;config.bookmarksPath=path.join(mainProfile,'Bookmarks');
  config.ptReadOnlyPolicies={[args.origin]:{reviewed:true,mode:'safe_history_page',url:args.origin+'/index.php',selector:'#info_block',nativeMainChrome:true}};
  config.mainChromeFallbackUrls=[{url:args.url,autoCheckin:true}];
  fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify(config));
  const oldBinding=crypto.createHash('sha256').update(path.resolve(args.profile).toLowerCase()).digest('hex');
  const old={attemptId:crypto.randomUUID(),origin:args.origin,accountKey:'site-default',profileBinding:oldBinding,
    businessDate:'2026-10-02',startedAt:args.now.toISOString(),state:'submitted',actions:['click']};
  fs.writeFileSync(path.join(args.root,'data/native-pt-attempts.json'),JSON.stringify({schemaVersion:1,attempts:[old]}));
  attachController(t,args);
  const result=await runNativePtGate({...args,profile:mainProfile,mainProfile:true,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  assert.equal(result.allow,true);assert.equal(result.inactiveHistoricalIntentCount,1);
  const journal=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(journal.attempts[0].state,'submitted');assert.equal(journal.attempts.length,2);
  assert.notEqual(journal.attempts[1].profileBinding,oldBinding);
});

test('native readback refuses a journal intent whose stored business day disagrees',async t=>{
  const args=fixture(t),attemptId=crypto.randomUUID();
  await runNativePtGate({...args,phase:'begin',attemptId,action:'click'});
  const file=path.join(args.root,'data/native-pt-attempts.json'),journal=JSON.parse(fs.readFileSync(file));
  journal.attempts[0].businessDate='2026-10-01';fs.writeFileSync(file,JSON.stringify(journal));
  const binding=journal.attempts[0].profileBinding;
  const result=await runNativePtGate({...args,phase:'inspect',verify:()=>({status:'already_signed',profileBinding:binding,evidence:proof(args.now)})});
  assert.equal(result.allow,false);assert.equal(result.decision.failureCode,'submission_outcome_unknown');
  assert.equal(JSON.parse(fs.readFileSync(file)).attempts[0].state,'submitted');
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

function localReadbackFixture(args,binding,now=args.now,status='not_signed'){
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  config.ptReadOnlyPolicies[args.origin].unsignedTexts=['签到'];
  fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify(config));
  return {origin:args.origin,url:args.origin+'/index.php',accountKey:'site-default',profileBinding:binding,
    status,businessDate:'2026-10-02',observedAt:now.toISOString(),submissionAttempted:false,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',
    evidence:{...proof(now),evidenceScope:'site_account_day',
      statusSignal:status==='not_signed'?'nexus_daily_header_unsigned':'nexus_daily_header_signed'},
    inspection:{currentUrl:args.origin+'/index.php',sameOrigin:true,pageContentAvailable:true,siteBodyLoaded:true,
      authenticated:true,waf:false,securityVerification:false,loginRoute:false,
      signedControlCount:status==='not_signed'?0:1,unsignedControlCount:status==='not_signed'?1:0,
      success:status!=='not_signed',successControl:status==='not_signed'?'':'已签到',
      unsignedControl:status==='not_signed'?'[签到]':'',successText:'',bodyText:'PRIVATE_FIXTURE_TEXT'}};
}

test('bind supplies the actual execution identity without creating or resolving an intent or requiring a write lease',async t=>{
  const args=fixture(t),file=path.join(args.root,'data/native-pt-attempts.json');
  const first=await runNativePtGate({...args,phase:'bind'});
  assert.equal(first.allow,true);assert.equal(first.accountKey,'site-default');
  const key=process.platform==='win32'?path.resolve(args.profile).toLowerCase():path.resolve(args.profile);
  assert.equal(first.profileBinding,crypto.createHash('sha256').update(key).digest('hex'));
  assert.equal(fs.existsSync(file),false);
  await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  const before=fs.readFileSync(file,'utf8');
  fs.writeFileSync(path.join(args.root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:args.root}));
  assert.equal((await runNativePtGate({...args,phase:'bind'})).allow,true);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  await assert.rejects(()=>runNativePtGate({...args,phase:'readback',receipt:localReadbackFixture(args,first.profileBinding)}),/lease/);
  assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('a persisted same-profile negative readback authorizes one current-day intent and preserves an older unknown',async t=>{
  const args=fixture(t),old=await runNativePtGate({...args,now:new Date('2026-10-01T03:00:00Z'),
    phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  attachController(t,args);
  const receipt=localReadbackFixture(args,old.profileBinding);
  const registered=await runNativePtGate({...args,phase:'readback',receipt});
  assert.equal(registered.receiptAccepted,true);assert.equal(registered.submissionAttempted,false);
  const file=path.join(args.root,'data/native-pt-attempts.json'),saved=JSON.parse(fs.readFileSync(file));
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'submitted');
  assert.equal(saved.readbacks.length,1);assert.equal(saved.readbacks[0].evidence.evidenceScope,'site_account_day');
  assert.equal(JSON.stringify(saved).includes('PRIVATE_FIXTURE_TEXT'),false);
  assert.equal('inspection' in saved.readbacks[0],false);assert.equal('unsignedControl' in saved.readbacks[0],false);
  const restarted=await import('../src/native-pt-gate.mjs?local-readback='+crypto.randomUUID());
  assert.equal((await restarted.runNativePtGate({...args,phase:'inspect'})).allow,true);
  const current=crypto.randomUUID();
  assert.equal((await restarted.runNativePtGate({...args,phase:'begin',attemptId:current,action:'navigation'})).allow,true);
  assert.equal((await restarted.runNativePtGate({...args,phase:'begin',attemptId:current,action:'click'})).allow,true);
  assert.equal((await restarted.runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'})).allow,false);
  const after=JSON.parse(fs.readFileSync(file));
  assert.equal(after.attempts.length,2);assert.equal(after.attempts[0].state,'submitted');
  assert.equal(after.attempts[0].businessDate,'2026-10-01');assert.equal(after.attempts[0].resolvedAt,undefined);
  assert.deepEqual(after.attempts[1].actions,['navigation','click']);
});

test('local readback rejects foreign, ambiguous, stale, unbound or possibly submitted proofs without changing the journal',async t=>{
  const args=fixture(t),started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  attachController(t,args);
  const now=new Date(args.now.getTime()+1000),base=localReadbackFixture(args,started.profileBinding,now);
  const invalid=[{...base,profileBinding:'b'.repeat(64)},{...base,accountKey:'other'},
    {...base,origin:'https://foreign.example'}, {...base,url:args.origin+'/attendance.php'},
    {...base,submissionAttempted:true},{...base,clicked:true},{...base,checkinClickAttempted:true},
    {...base,readSafety:'unchecked'},{...base,operationMode:'submit'},{...base,businessDate:'2026-10-01'},
    {...base,observedAt:'invalid'},{...base,observedAt:new Date(now.getTime()+1).toISOString()},
    ...[{source:'api'},{authoritative:false},{pagePath:'/attendance.php'},{evidenceScope:'other'},
      {statusSignal:'generic_page_text'},{businessDate:'2026-10-01'},
      {confirmedAt:new Date(now.getTime()+1).toISOString()},{confirmedAt:new Date(now.getTime()-300001).toISOString()}]
      .map(change=>({...base,evidence:{...base.evidence,...change}})),
    ...[{sameOrigin:false},{authenticated:false},{pageContentAvailable:false},{siteBodyLoaded:false},
      {waf:true},{securityVerification:true},{loginRoute:true},{unsignedControlCount:2},{signedControlCount:1},
      {unsignedControl:'历史签到'},{unsignedControl:'未签'},{success:true},{successControl:'已签到'},
      {currentUrl:args.origin+'/index.php?sign=1'}].map(change=>({...base,inspection:{...base.inspection,...change}}))];
  const file=path.join(args.root,'data/native-pt-attempts.json'),before=fs.readFileSync(file,'utf8');
  for(const receipt of invalid){
    const result=await runNativePtGate({...args,now,phase:'readback',receipt});
    assert.equal(result.allow,false);assert.equal(result.receiptAccepted,false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
});

test('persisted positive daily readback closes only the matching current-day intent and defeats an older negative proof',async t=>{
  const args=fixture(t),started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  attachController(t,args);
  const negativeAt=new Date(args.now.getTime()+1000),negative=localReadbackFixture(args,started.profileBinding,negativeAt);
  assert.equal((await runNativePtGate({...args,now:negativeAt,phase:'readback',receipt:negative})).allow,true);
  const positiveAt=new Date(args.now.getTime()+2000),positive=localReadbackFixture(args,started.profileBinding,positiveAt,'already_signed');
  assert.equal((await runNativePtGate({...args,now:positiveAt,phase:'readback',receipt:positive})).allow,true);
  const decision=await runNativePtGate({...args,now:positiveAt,phase:'inspect'});
  assert.equal(decision.allow,false);assert.equal(decision.decision.status,'already_signed');
  const saved=JSON.parse(fs.readFileSync(path.join(args.root,'data/native-pt-attempts.json')));
  assert.equal(saved.attempts[0].state,'confirmed');assert.equal(saved.attempts[0].resolution,'passive_readback');
  assert.equal((await runNativePtGate({...args,now:new Date('2026-10-03T03:00:00Z'),phase:'inspect'})).allow,true);
});

test('a valid negative readback cannot override a malformed or differently bound unresolved intent',async t=>{
  const args=fixture(t),started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'click'});
  attachController(t,args);
  const now=new Date(args.now.getTime()+1000),receipt=localReadbackFixture(args,started.profileBinding,now);
  assert.equal((await runNativePtGate({...args,now,phase:'readback',receipt})).allow,true);
  const file=path.join(args.root,'data/native-pt-attempts.json'),base=JSON.parse(fs.readFileSync(file));
  for(const change of [{businessDate:'2026-10-01'},{profileBinding:'b'.repeat(64)},{profileBinding:undefined}]){
    const journal=structuredClone(base);Object.assign(journal.attempts[0],change);
    fs.writeFileSync(file,JSON.stringify(journal));
    const result=await runNativePtGate({...args,now,phase:'inspect'});
    assert.equal(result.allow,false);assert.equal(result.decision.failureCode,'submission_outcome_unknown');
    assert.equal(JSON.parse(fs.readFileSync(file)).attempts[0].state,'submitted');
  }
});

test('positive readback requires a unique signed daily control or the reviewed audiences account header',async t=>{
  const args=fixture(t),binding=(await runNativePtGate({...args,phase:'bind'})).profileBinding;
  const base=localReadbackFixture(args,binding,args.now,'already_signed');
  for(const change of [{authenticated:false},{signedControlCount:2},{unsignedControlCount:1},
    {successControl:'历史已签到'},{successControl:'签到已得25'},{audiencesDailyHeaderVerified:true,authenticated:false,signedControlCount:0}]){
    assert.equal((await runNativePtGate({...args,phase:'readback',receipt:{...base,inspection:{...base.inspection,...change}}})).allow,false);
  }
  assert.equal((await runNativePtGate({...args,phase:'readback',receipt:base})).allow,true);
  const audience={...args,origin:'https://audiences.me',url:'https://audiences.me/attendance.php',
    readPlan:async()=>({targets:[{origin:'https://audiences.me',allowedOrigins:['https://audiences.me'],folderNames:['PT']}]})};
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  config.nativeWafPreflightUrls=[audience.url];config.ptReadOnlyPolicies[audience.origin]={reviewed:true,mode:'safe_history_page',url:audience.origin+'/index.php',selector:'#info_block'};
  fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify(config));
  const audienceReceipt=localReadbackFixture(audience,binding,args.now,'already_signed');
  Object.assign(audienceReceipt.inspection,{authenticated:false,successControl:'',signedControlCount:0,audiencesDailyHeaderVerified:true});
  assert.equal((await runNativePtGate({...audience,phase:'readback',receipt:audienceReceipt})).allow,true);
  audienceReceipt.inspection.currentUrl='https://www.audiences.me/index.php';
  assert.equal((await runNativePtGate({...audience,phase:'readback',receipt:audienceReceipt})).allow,true);
  for(const currentUrl of ['http://www.audiences.me/index.php','https://www.audiences.me:8443/index.php',
    'https://www.audiences.me/index.php?sign=1','https://www.audiences.me/attendance.php','https://audiences.me.evil.example/index.php']){
    audienceReceipt.inspection.currentUrl=currentUrl;
    assert.equal((await runNativePtGate({...audience,phase:'readback',receipt:audienceReceipt})).allow,false);
  }
});

test('Ourbits scoped account header closes a bound intent and rejects ambiguity, wrong identity and stale facts',async t=>{
  const args={...fixture(t),origin:'https://ourbits.club',url:'https://ourbits.club/attendance.php'};
  args.readPlan=async()=>({targets:[{origin:args.origin,candidates:[args.url],allowedOrigins:[args.origin],folderNames:['PT']}]});
  const configFile=path.join(args.root,'config/config.json'),config=JSON.parse(fs.readFileSync(configFile));
  config.nativeWafPreflightUrls=[args.url];config.ptReadOnlyPolicies={[args.origin]:{reviewed:true,mode:'safe_history_page',url:args.origin+'/index.php',selector:'#info_block'}};
  fs.writeFileSync(configFile,JSON.stringify(config));
  const started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  attachController(t,args);
  const now=new Date(args.now.getTime()+1000),receipt=localReadbackFixture(args,started.profileBinding,now,'already_signed');
  Object.assign(receipt.inspection,{success:false,successControl:'',signedControlCount:0,ourbitsDailyHeaderVerified:true,
    ourbitsHeaderContextClear:true,ourbitsHeaderLogoutCount:1,ourbitsHeaderStatsCount:4,ourbitsHeaderRewardCount:1,
    ourbitsHeaderUnsignedControlCount:0,ourbitsHeaderText:'PRIVATE_ACCOUNT_HEADER'});
  const file=path.join(args.root,'data/native-pt-attempts.json'),before=fs.readFileSync(file,'utf8');
  const invalid=[{...receipt,profileBinding:'b'.repeat(64)},{...receipt,accountKey:'other'},
    {...receipt,observedAt:new Date(now.getTime()-300001).toISOString(),
      evidence:{...receipt.evidence,confirmedAt:new Date(now.getTime()-300001).toISOString()}},
    {...receipt,businessDate:'2026-10-01',evidence:{...receipt.evidence,businessDate:'2026-10-01'}},
    ...[{ourbitsDailyHeaderVerified:false},{ourbitsDailyHeaderVerified:'true'},{ourbitsHeaderContextClear:false},
      {ourbitsHeaderContextClear:'true'},{ourbitsHeaderLogoutCount:0},{ourbitsHeaderLogoutCount:2},
      {ourbitsHeaderLogoutCount:'1'},{ourbitsHeaderStatsCount:3},{ourbitsHeaderStatsCount:'4'},
      {ourbitsHeaderRewardCount:0},{ourbitsHeaderRewardCount:2},{ourbitsHeaderRewardCount:'1'},
      {ourbitsHeaderUnsignedControlCount:1},{ourbitsHeaderUnsignedControlCount:'0'},
      {authenticated:false},{siteBodyLoaded:false},{unsignedControlCount:1},{unsignedControl:'签到'},
      {signedControlCount:2},{successControl:'任意已签到'},{waf:true},{securityVerification:true},{loginRoute:true},
      {currentUrl:'https://www.ourbits.club/index.php'},{currentUrl:'https://ourbits.club/attendance.php'},
      {currentUrl:'https://ourbits.club/index.php?day=2026-10-01'}].map(change=>({...receipt,inspection:{...receipt.inspection,...change}}))];
  for(const value of invalid){
    const rejected=await runNativePtGate({...args,now,phase:'readback',receipt:value});
    assert.equal(rejected.allow,false);assert.equal(rejected.receiptAccepted,false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  const conflictingNegative=localReadbackFixture(args,started.profileBinding,now);
  Object.assign(conflictingNegative.inspection,{ourbitsDailyHeaderVerified:false,ourbitsHeaderRewardCount:1});
  const rejectedNegative=await runNativePtGate({...args,now,phase:'readback',receipt:conflictingNegative});
  assert.equal(rejectedNegative.allow,false);assert.equal(rejectedNegative.receiptAccepted,false);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  const accepted=await runNativePtGate({...args,now,phase:'readback',receipt});
  assert.equal(accepted.allow,true);assert.equal(accepted.receiptAccepted,true);assert.equal(accepted.submissionAttempted,false);
  const noReplay=await runNativePtGate({...args,now,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  assert.equal(noReplay.allow,false);assert.equal(noReplay.decision.status,'already_signed');
  const saved=JSON.parse(fs.readFileSync(file));
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'confirmed');assert.equal(saved.readbacks.length,1);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_|ourbitsHeader|successControl|bodyText/);
});

test('reviewed private PigGo daily reward readback closes its bound intent without broadening the public labels',async t=>{
  const args={...fixture(t),origin:'https://piggo.me',url:'https://piggo.me/attendance.php'};
  args.readPlan=async()=>({targets:[{origin:args.origin,candidates:[args.url],allowedOrigins:[args.origin],folderNames:['PT']}]});
  const configFile=path.join(args.root,'config/config.json'),config=JSON.parse(fs.readFileSync(configFile));
  config.nativeWafPreflightUrls=[args.url];
  const policy={reviewed:true,mode:'safe_history_page',url:args.origin+'/index.php',selector:'#info_block',
    dailyHeader:true,actionPath:'/attendance.php',signedRewardControl:true,unsignedTexts:['签到','签到得魔力']};
  config.ptReadOnlyPolicies={[args.origin]:policy};
  fs.writeFileSync(configFile,JSON.stringify(config));
  const started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  attachController(t,args);
  const now=new Date(args.now.getTime()+1000),receipt=localReadbackFixture(args,started.profileBinding,now,'already_signed');
  receipt.inspection.successControl='[签到已得840, 补签卡: 3]';
  const file=path.join(args.root,'data/native-pt-attempts.json'),before=fs.readFileSync(file,'utf8');
  for(const change of [{signedRewardControl:false},{signedRewardControl:undefined},{signedRewardControl:'true'},
    {dailyHeader:false},{dailyHeader:undefined},{dailyHeader:'true'},
    {signedRewardControl:false,signedTexts:['签到已得840,补签卡:3']},{reviewed:false}]){
    config.ptReadOnlyPolicies[args.origin]={...policy,...change};fs.writeFileSync(configFile,JSON.stringify(config));
    const rejected=await runNativePtGate({...args,now,phase:'readback',receipt});
    assert.equal(rejected.allow,false);assert.equal(rejected.receiptAccepted,false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  config.ptReadOnlyPolicies[args.origin]=policy;fs.writeFileSync(configFile,JSON.stringify(config));
  const invalid=[{...receipt,accountKey:'other'},{...receipt,profileBinding:'b'.repeat(64)},
    {...receipt,observedAt:new Date(now.getTime()-300001).toISOString(),
      evidence:{...receipt.evidence,confirmedAt:new Date(now.getTime()-300001).toISOString()}},
    {...receipt,businessDate:'2026-10-01',evidence:{...receipt.evidence,businessDate:'2026-10-01'}},
    ...[{signedControlCount:2},{unsignedControlCount:1,unsignedControl:'签到得魔力'},
      {authenticated:false},{waf:true},{securityVerification:true},{loginRoute:true},
      {successControl:'历史签到已得840, 补签卡: 3'},{successControl:'任意成功文字'}]
      .map(change=>({...receipt,inspection:{...receipt.inspection,...change}}))];
  for(const invalidReceipt of invalid){
    const rejected=await runNativePtGate({...args,now,phase:'readback',receipt:invalidReceipt});
    assert.equal(rejected.allow,false);assert.equal(rejected.receiptAccepted,false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  const registered=await runNativePtGate({...args,now,phase:'readback',receipt});
  assert.equal(registered.allow,true);assert.equal(registered.receiptAccepted,true);assert.equal(registered.submissionAttempted,false);
  const restarted=await import('../src/native-pt-gate.mjs?piggo-reward='+crypto.randomUUID());
  const noReplay=await restarted.runNativePtGate({...args,now,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  assert.equal(noReplay.allow,false);assert.equal(noReplay.decision.status,'already_signed');assert.equal(noReplay.decision.submissionAttempted,false);
  const saved=JSON.parse(fs.readFileSync(file));
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'confirmed');
  assert.equal(saved.attempts[0].resolution,'passive_readback');assert.equal(saved.readbacks.length,1);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE_FIXTURE_TEXT|签到已得840|successControl|bodyText/);
});

test('a reviewed bound home positive is persisted and closes today without accepting home negative proof',async t=>{
  const args=fixture(t),started=await runNativePtGate({...args,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation'});
  attachController(t,args);
  const now=new Date(args.now.getTime()+1000),positive=localReadbackFixture(args,started.profileBinding,now,'already_signed');
  positive.inspection.currentUrl=args.origin+'/';positive.evidence.pagePath='/';
  assert.equal(positive.url,args.origin+'/index.php');
  const registered=await runNativePtGate({...args,now,phase:'readback',receipt:positive});
  assert.equal(registered.allow,true);assert.equal(registered.receiptAccepted,true);
  const restarted=await import('../src/native-pt-gate.mjs?home-positive='+crypto.randomUUID());
  const decision=await restarted.runNativePtGate({...args,now,phase:'inspect'});
  assert.equal(decision.allow,false);assert.equal(decision.decision.status,'already_signed');
  assert.equal(decision.decision.evidence.pagePath,'/');
  const file=path.join(args.root,'data/native-pt-attempts.json'),saved=JSON.parse(fs.readFileSync(file));
  assert.equal(saved.readbacks[0].evidence.pagePath,'/');assert.equal(saved.attempts[0].state,'confirmed');
  assert.equal(saved.attempts[0].resolution,'passive_readback');
  const before=fs.readFileSync(file,'utf8');
  for(const pagePath of ['/index.php','/attendance.php']){
    assert.equal((await runNativePtGate({...args,now,phase:'readback',
      receipt:{...positive,evidence:{...positive.evidence,pagePath}}})).allow,false);
  }
  const negative=localReadbackFixture(args,started.profileBinding,now);
  negative.inspection.currentUrl=args.origin+'/';negative.evidence.pagePath='/';
  assert.equal((await runNativePtGate({...args,now,phase:'readback',receipt:negative})).allow,false);
  assert.equal(fs.readFileSync(file,'utf8'),before);
  assert.equal((await restarted.runNativePtGate({...args,now:new Date(now.getTime()+1000),
    phase:'begin',attemptId:crypto.randomUUID(),action:'click'})).decision.status,'already_signed');
});
