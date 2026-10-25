import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {runHddolbyNativeFlow} from '../src/hddolby-native-flow.mjs';
import {ptExecutionBinding} from '../src/pt-read-policy.mjs';
import {freshPtUnsignedObservation} from '../src/pt-observation-receipt.mjs';
import {publicSupplementResult} from '../src/pt-supplement.mjs';
import {recoverPtLogin,runHddolbyNative} from '../src/pt-login-recovery.mjs';
import {recordPtVerification} from '../../observation/src/pt-verification.mjs';
import {projectPtSiteResult} from '../../observation/src/pt-site-execution.mjs';

const origin='https://www.uhddolby.com',initial=new Date('2026-10-25T04:00:00Z');
function setup(t,{intentAge=5_000,mode='Checkin',variant}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdd-native-lifecycle-')),controller=path.join(root,'controller'),profile=path.join(root,'data/profile');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const folder of ['data/profile','controller/data','controller/config','controller/outputs'])fs.mkdirSync(path.join(root,folder),{recursive:true});
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  const config={automationUserDataDir:profile,savedLoginUrls:{[origin]:origin+'/login.php'},siteTwoFactorRecovery:{[origin]:{
    enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,adapterId:'hddolby-nexus-stepup-v1',expectedAccountId:'7'}}};
  write(path.join(root,'data/v2-integration.json'),{executionEngine:'v1',v2ProjectRoot:controller});
  write(path.join(controller,'config/runtime.local.json'),{executionEngine:'v1',legacyRoot:root});
  const binding=ptExecutionBinding(config,root,{origin,accountKey:'site-default'}),attemptId=crypto.randomUUID();
  const evidence={source:'pt_page',authoritative:true,confirmedAt:initial.toISOString(),businessDate:'2026-10-25',
    pagePath:'/log.php',statusSignal:'hddolby_account_header_unsigned',evidenceScope:'site_account_day'};
  const receipt={origin,status:'not_signed',accountKey:'site-default',profileBinding:binding.profileBinding,businessDate:'2026-10-25',
    observedAt:initial.toISOString(),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,evidence};
  const file=path.join(controller,'outputs/pt-fallback-results-2026-10-25.json');
  write(file,{source:'execution-supplement',businessDate:'2026-10-25',sites:[receipt]});
  write(path.join(controller,'data/harvest-fallback.lock'),{pid:process.pid,nonce:'synthetic-worker'});
  write(path.join(controller,'outputs/harvest-fallback-attempts-2026-10-25.json'),{attempts:[{
    attemptId,origin,accountKey:'site-default',businessDate:'2026-10-25',state:'in_progress',workerPid:process.pid,workerNonce:'synthetic-worker',
    startedAt:new Date(initial.getTime()+intentAge).toISOString(),recoveryEvidence:receipt}]});
  const previous=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=attemptId;
  t.after(()=>{if(previous===undefined)delete process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;else process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=previous;});
  let at=initial.getTime()+40_000,reads=0,submits=0,published=0,proofs=0;
  const context={route:async()=>{},unroute:async()=>{}},page={url:()=>origin+'/index.php',context:()=>context};
  const args={root,config,profile,page,mode,clock:()=>new Date(at),
    scope:async()=>({binding:{accountKey:'site-default',profileBinding:binding.profileBinding},assertCurrent:async()=>true,release:async()=>{}}),
    profileProof:async()=>{if(++proofs===2&&variant==='slow-current-read')at+=31_000;return true;},
    publishUnsigned:async({receipt,now})=>{published++;return recordPtVerification(controller,receipt,{now,lockHeld:true});},
    readHeader:async()=>{const signed=(reads++>0&&variant!=='diagnostic')||variant==='already-signed';return {status:signed?'already_signed':'not_signed',
      submissionAttempted:false,evidence:{...evidence,confirmedAt:new Date(at).toISOString(),statusSignal:signed?'hddolby_account_header_signed':'hddolby_account_header_unsigned'}};},
    runTarget:async()=>{
      submits++;
      const fresh=freshPtUnsignedObservation(root,{origin,accountKey:'site-default'},config,{now:new Date(at),profileBinding:binding.profileBinding});
      assert.ok(fresh,'the mature submit guard must see the new native proof');
      assert.notEqual(fresh.evidence.confirmedAt,initial.toISOString());
      at+=2_000;
      return variant==='diagnostic'?{status:'needs_attention',failureCode:'submission_outcome_unknown',underlyingFailureCode:'two_factor_required',
        submissionAttempted:true,twoFactorRecovery:{reason:'protocol_unverified',attempted:false,accepted:false},privateText:'PRIVATE_PAGE_BODY'}:
        {status:'signed',submissionAttempted:true};
    }};
  return {args,file,binding,get at(){return at;},get submits(){return submits;},get published(){return published;}};
}

test('a valid parent intent survives browser startup while fresh native evidence reaches the real submit receipt reader',async t=>{
  const f=setup(t),result=await runHddolbyNativeFlow(f.args);
  assert.equal(result.status,'signed');assert.equal(result.submissionAttempted,true);assert.equal(f.submits,1);assert.equal(f.published,1);
  assert.equal(result.nativeFlow.parentEvidenceAgeMs,40_000);
  assert.equal(result.nativeFlow.stage,'complete');
});

test('a parent that was stale when authorized and a native proof that ages before dispatch both stop without a submit',async t=>{
  for(const options of [{intentAge:31_000},{variant:'slow-current-read'}]){
    const f=setup(t,options),result=await runHddolbyNativeFlow(f.args);
    assert.equal(f.submits,0);assert.equal(f.published,0);assert.equal(result.submissionAttempted,false);
    assert.equal(result.nativeFlow.code,options.intentAge?'parent_intent_unavailable':'fresh_unsigned_required');
  }
});

test('read-only native verification does not publish a receipt or mutate attendance, and an already-signed formal run also stops',async t=>{
  for(const options of [{mode:'ReadOnly'},{variant:'already-signed'}]){
    const f=setup(t,options),before=fs.readFileSync(f.file,'utf8'),result=await runHddolbyNativeFlow(f.args);
    assert.equal(f.submits,0);assert.equal(f.published,0);assert.equal(result.submissionAttempted,false);
    assert.equal(fs.readFileSync(f.file,'utf8'),before);
  }
});

test('mature failure diagnostics survive execution and observation projection without page content',async t=>{
  const f=setup(t,{variant:'diagnostic'}),raw=await runHddolbyNativeFlow(f.args);
  const result=projectPtSiteResult(publicSupplementResult(origin,raw,new Date(f.at)),origin);
  assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.underlyingFailureCode,'two_factor_required');
  assert.equal(result.nativeFlow.twoFactorReason,'protocol_unverified');assert.equal(result.nativeFlow.readbackStatus,'not_signed');
  assert.equal(result.submissionAttempted,true);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_PAGE_BODY|privateText/);
});

test('native transport distinguishes a failed passive helper from an interrupted write and login cannot choose an attendance mode',async t=>{
  const f=setup(t);
  for(const mode of ['ReadOnly','Checkin']){
    const result=await runHddolbyNative({...f.args,origin,mode,execute:async()=>{throw Error('synthetic helper failure');}});
    assert.equal(result.submissionAttempted,mode==='Checkin');
    assert.equal(result.failureCode,mode==='Checkin'?'submission_outcome_unknown':'native_readback_unavailable');
  }
  let invoked=false;
  const result=await recoverPtLogin({...f.args,origin,mode:'Checkin',execute:async()=>{invoked=true;}});
  assert.equal(result.handled,false);assert.equal(invoked,false);
});
