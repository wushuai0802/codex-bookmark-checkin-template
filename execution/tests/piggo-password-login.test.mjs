import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {recoverPiggoPasswordLogin,piggoPasswordFormReviewed,piggoPasswordLoginEnabled,guardPiggoPasswordAutofill} from '../src/native-pt-two-factor.mjs';
import {runNativePtGate} from '../src/native-pt-gate.mjs';

const origin='https://piggo.me',home=origin+'/index.php',login=origin+'/login.php';
const now=new Date('2026-10-24T03:00:00Z'),code='123456';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'piggo-password-login-')),profile=path.join(root,'data/piggo'),controller=path.join(root,'controller');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['config','data/piggo','data/default','tmp','controller/config','controller/data','controller/src'])fs.mkdirSync(path.join(root,name),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'synthetic profile');
  const binding=crypto.createHash('sha256').update(process.platform==='win32'?profile.toLowerCase():profile).digest('hex');
  const config={automationUserDataDir:path.join(root,'data/default'),bookmarksPath:path.join(root,'Bookmarks'),
    nativeWafPreflightUrls:[{url:origin+'/attendance.php',automationUserDataDir:profile,passiveOnly:true}],
    nativeAccessibilityCheckinOrigins:[],ptReadOnlyPolicies:{[origin]:{reviewed:true,mode:'safe_history_page',url:home,selector:'#info_block',
      actionPath:'/attendance.php',dailyHeader:true,nativeIsolatedChrome:true,nativeApiHeaderFallback:true,proxyServer:'http://127.0.0.1:7890',
      unsignedText:'签到得魔力',unsignedTexts:['签到','签到得魔力'],signedRewardControl:true}},
    nativePtTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true}}};
  const configFile=path.join(root,'config/config.json'),save=()=>fs.writeFileSync(configFile,JSON.stringify(config));save();
  fs.writeFileSync(path.join(root,'tmp/run.lock'),JSON.stringify({pid:process.pid,nonce:crypto.randomUUID()}));
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  const nonce=crypto.randomUUID();fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  fs.writeFileSync(path.join(controller,'src/legacy-engine.mjs'),`export {validateEngineLease} from ${JSON.stringify(new URL('../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  const previous=[process.env.CHECKIN_V2_ENGINE_ROOT,process.env.CHECKIN_V2_ENGINE_LEASE];
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{for(const [i,key] of ['CHECKIN_V2_ENGINE_ROOT','CHECKIN_V2_ENGINE_LEASE'].entries()){
    if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];}});
  const form={sameOrigin:true,actionPath:'/takelogin.php',method:'POST',sameWindow:true,basePresent:false,fieldsReviewed:true,
    usernameFilled:true,passwordFilled:true,otpEmpty:true,logoutChecked:false,usernameHash:'a'.repeat(64)};
  const journal=path.join(root,'data/bitwarden/recovery-state.json');
  let route,filled='',posts=0,prepares=0,reads=0,authReads=0,submitted=false,proof=true,profileMatched=true,ttl=20000,duplicate=false,autoSubmit=false,submitCalls=0;
  const post=async()=>{
    assert.equal(JSON.parse(fs.readFileSync(journal)).attempts.at(-1).state,'pending');
    await route({request:()=>({url:()=>origin+'/takelogin.php',method:()=> 'POST'}),continue:async()=>{posts++;submitted=true;},abort:async()=>{throw Error('unexpected block');}});
  };
  const page={url:()=>login,context:()=>({}),route:async(_pattern,handler)=>{route=handler;},unroute:async()=>{route=null;},
    locator:()=>({fill:async value=>{filled=value;if(value===code&&autoSubmit)await post();}}),waitForLoadState:async()=>{}};
  const receipt=()=>{
    const evidence={source:'page_text',authoritative:true,businessDate:'2026-10-24',confirmedAt:now.toISOString(),
      pagePath:'/index.php',statusSignal:'nexus_daily_header_unsigned',evidenceScope:'site_account_day'};
    const inspection={currentUrl:home,sameOrigin:true,pageContentAvailable:true,siteBodyLoaded:true,authenticated:true,waf:false,
      securityVerification:false,loginRoute:false,signedControlCount:0,unsignedControlCount:1,successControl:'',unsignedControl:'签到得魔力',success:false};
    const value={origin,url:home,status:'not_signed',accountKey:'site-default',profileBinding:binding,observedAt:now.toISOString(),
      businessDate:'2026-10-24',submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',evidence,inspection};
    return {...value,readbackReceipt:value};
  };
  const gate=options=>runNativePtGate({...options,readPlan:async()=>({targets:[{origin,allowedOrigins:[origin],folderNames:['PT'],candidates:[origin+'/attendance.php']}]}),
    verify:()=>null,harvest:()=>null});
  const args={root,origin,page,profile,profileProof:async()=>profileMatched,clock:()=>now,gate,inspectForm:async()=>({...form}),
    prepare:async()=>{prepares++;return {ready:true};},
    withTotp:async({consume})=>{reads++;await consume(code,{validUntilMs:now.getTime()+ttl});if(duplicate)await consume(code,{validUntilMs:now.getTime()+ttl});return {ready:true};},
    readHeader:async()=>{authReads++;return submitted&&proof?receipt():{status:'login_required',failureCode:'login_required',submissionAttempted:false};},
    submit:async()=>{
      submitCalls++;
      assert.equal(filled,code);assert.equal(JSON.parse(fs.readFileSync(journal)).attempts.at(-1).state,'pending');
      await post();
    }};
  return {root,profile,binding,config,save,form,journal,args,receipt,
    get posts(){return posts;},get prepares(){return prepares;},get reads(){return reads;},get filled(){return filled;},get authReads(){return authReads;},
    get submitCalls(){return submitCalls;},autoSubmitOnFill:()=>{autoSubmit=true;},
    rejectProof:()=>{proof=false;},rejectProfile:()=>{profileMatched=false;},expireCode:()=>{ttl=2000;},duplicateProvider:()=>{duplicate=true;}};
}
function noSecrets(value,file){assert.doesNotMatch(JSON.stringify(value)+(fs.existsSync(file)?fs.readFileSync(file,'utf8'):''),new RegExp(code+'|usernameHash|passwordFilled'));}

test('PigGo normal-login assistance needs explicit private consent and a reviewed same-origin form with existing credentials',()=>{
  const config={nativePtTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true}}};
  assert.equal(piggoPasswordLoginEnabled(config),true);assert.equal(piggoPasswordLoginEnabled(config,'https://other.example'),false);
  for(const key of ['enabled','reviewed','allowPasswordLogin'])assert.equal(piggoPasswordLoginEnabled({nativePtTwoFactorRecovery:{[origin]:{...config.nativePtTwoFactorRecovery[origin],[key]:false}}}),false);
  const form={sameOrigin:true,actionPath:'/takelogin.php',method:'POST',sameWindow:true,basePresent:false,fieldsReviewed:true,
    usernameFilled:true,passwordFilled:true,otpEmpty:true,logoutChecked:false,usernameHash:'a'.repeat(64)};
  assert.equal(piggoPasswordFormReviewed(form),true);
  for(const changed of [{sameOrigin:false},{actionPath:'/attendance.php'},{method:'GET'},{sameWindow:false},{basePresent:true},
    {fieldsReviewed:false},{usernameFilled:false},{passwordFilled:false},{otpEmpty:false},{logoutChecked:true},{usernameHash:''}])
    assert.equal(piggoPasswordFormReviewed({...form,...changed}),false);
});

test('the real default provider path loads lazily and stops safely before CLI use when the fixture has no vault authorization',async t=>{
  const f=fixture(t),{prepare,withTotp,...args}=f.args;
  const result=await recoverPiggoPasswordLogin(args);
  assert.equal(result.status,'needs_attention');assert.equal(result.nativeTwoFactorRecovery.reason,'provider_disabled');
  assert.equal(f.posts,0);assert.equal(f.reads,0);assert.equal(fs.existsSync(f.journal),false);noSecrets(result,f.journal);
});

test('autofill Enter cannot submit the password form before the reviewed OTP consumer takes ownership',async()=>{
  let handler;
  await guardPiggoPasswordAutofill({route:async(_pattern,value)=>{handler=value;}});
  for(const [method,url,allowed] of [['POST',origin+'/takelogin.php',false],['GET',origin+'/takelogin.php',false],
    ['GET',origin+'/attendance.php',false],['GET',origin+'/index.php',true],['GET',origin+'/login.php',true]]){
    let continued=false,aborted=false;
    await handler({request:()=>({url:()=>url,method:()=>method}),continue:async()=>{continued=true;},abort:async()=>{aborted=true;}});
    assert.equal(continued,allowed);assert.equal(aborted,!allowed);
  }
});

test('one scoped OTP login persists intent first, registers authoritative native proof and never reads or exports a password',async t=>{
  const f=fixture(t);f.duplicateProvider();
  const value=await recoverPiggoPasswordLogin(f.args);
  assert.equal(value.status,'logged_in');assert.equal(value.nativeTwoFactorRecovery.accepted,true);
  assert.equal(f.posts,1);assert.equal(f.reads,1);assert.equal(f.filled,'');
  const journal=JSON.parse(fs.readFileSync(f.journal));assert.equal(journal.attempts[0].state,'accepted');assert.equal(journal.attempts[0].phase,'password_login');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'data/native-pt-attempts.json'))).readbacks[0].status,'not_signed');
  noSecrets(value,f.journal);
});

test('an OTP input listener cannot authenticate before durable intent or cause a second submit',async t=>{
  const f=fixture(t);f.autoSubmitOnFill();
  const value=await recoverPiggoPasswordLogin(f.args);
  assert.equal(value.status,'logged_in');assert.equal(f.posts,1);assert.equal(f.submitCalls,0);noSecrets(value,f.journal);
});

test('missing consent, root lease, main lock, Profile proof and malformed form all stop before reading TOTP or submitting',async t=>{
  for(const variant of ['consent','lease','lock','profile','form']){
    const f=fixture(t);
    if(variant==='consent'){f.config.nativePtTwoFactorRecovery[origin].allowPasswordLogin=false;f.save();}
    if(variant==='lease')delete process.env.CHECKIN_V2_ENGINE_LEASE;
    if(variant==='lock')fs.unlinkSync(path.join(f.root,'tmp/run.lock'));
    if(variant==='profile')f.rejectProfile();
    if(variant==='form')f.form.method='GET';
    const value=await recoverPiggoPasswordLogin(f.args);
    assert.notEqual(value.status,'logged_in');assert.equal(f.prepares,0,variant);assert.equal(f.reads,0,variant);assert.equal(f.posts,0,variant);
    assert.equal(fs.existsSync(f.journal),false);noSecrets(value,f.journal);
  }
});

test('an old step-up record is preserved; an unknown password login cannot be replayed',async t=>{
  const f=fixture(t);fs.mkdirSync(path.dirname(f.journal),{recursive:true});
  const old={origin,accountKey:'site-default',profileBinding:f.binding,businessDate:'2026-10-24',state:'unknown',attemptedAt:now.toISOString()};
  fs.writeFileSync(f.journal,JSON.stringify({schemaVersion:1,attempts:[old]}));f.rejectProof();
  const first=await recoverPiggoPasswordLogin(f.args),second=await recoverPiggoPasswordLogin(f.args);
  assert.equal(first.status,'needs_attention');assert.equal(first.nativeTwoFactorRecovery.attempted,true);
  assert.equal(second.nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.posts,1);assert.equal(f.reads,1);
  const journal=JSON.parse(fs.readFileSync(f.journal));assert.deepEqual(journal.attempts[0],old);assert.equal(journal.attempts[1].state,'unknown');
  noSecrets(first,f.journal);noSecrets(second,f.journal);
});

test('an expiring code and a configuration change never create authentication intent',async t=>{
  const expired=fixture(t);expired.expireCode();
  const result=await recoverPiggoPasswordLogin(expired.args);assert.equal(result.nativeTwoFactorRecovery.reason,'totp_expired');
  assert.equal(expired.posts,0);assert.equal(fs.existsSync(expired.journal),false);
  const changed=fixture(t);changed.args.prepare=async()=>{changed.config.changedDuringPrepare=true;changed.save();return {ready:true};};
  const rejected=await recoverPiggoPasswordLogin(changed.args);assert.equal(rejected.nativeTwoFactorRecovery.reason,'login_form_changed');
  assert.equal(changed.reads,0);assert.equal(changed.posts,0);assert.equal(fs.existsSync(changed.journal),false);
});

test('an authenticated daily receipt avoids both a vault read and a password login',async t=>{
  const f=fixture(t),value=f.receipt();
  value.status=value.readbackReceipt.status='already_signed';value.evidence.statusSignal='nexus_daily_header_signed';
  Object.assign(value.inspection,{signedControlCount:1,unsignedControlCount:0,successControl:'已签到',unsignedControl:'',success:true});
  f.args.readHeader=async()=>value;
  const result=await recoverPiggoPasswordLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.nativeTwoFactorRecovery.attempted,false);
  assert.equal(f.prepares,0);assert.equal(f.reads,0);assert.equal(f.posts,0);assert.equal(fs.existsSync(f.journal),false);
});

test('detached OTP consumers finish before releasing the scope and late callbacks cannot submit',async t=>{
  const detached=fixture(t);detached.args.withTotp=async({consume})=>{
    void consume(code,{validUntilMs:now.getTime()+20000});return {ready:true};
  };
  assert.equal((await recoverPiggoPasswordLogin(detached.args)).status,'logged_in');assert.equal(detached.posts,1);
  const late=fixture(t);let callback;
  late.args.withTotp=async({consume})=>{callback=consume;return {ready:true};};
  assert.equal((await recoverPiggoPasswordLogin(late.args)).status,'needs_attention');
  await callback(code,{validUntilMs:now.getTime()+20000});assert.equal(late.posts,0);assert.equal(fs.existsSync(late.journal),false);
});
