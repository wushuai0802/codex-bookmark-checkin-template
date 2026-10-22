import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recoverHddolbyTwoFactor,hddolbyTwoFactorFormReviewed,hddolbyPassiveContext} from '../src/hddolby-two-factor.mjs';
import {tryHddolbyPostRedirectVerification} from '../src/browser.mjs';

const origin='https://www.hddolby.com',adapterId='hddolby-nexus-stepup-v1';
const now=new Date('2026-10-14T01:00:10.000Z'),binding='a'.repeat(64),code='246810';
function proof(status='not_signed',at=now){return {status,submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
  confirmedAt:at.toISOString(),businessDate:'2026-10-14',pagePath:'/log.php',
  statusSignal:status==='not_signed'?'hddolby_account_header_unsigned':'hddolby_account_header_signed'}};}
function form(){return {sameOrigin:true,path:'/take2fa.php',method:'POST',returntoPath:'/attendance.php',returntoUnsafe:false,
  passwordPresent:false,visible:true,sameWindow:true,fields:[{name:'type',type:'hidden'},{name:'returnto',type:'hidden'},
    {name:'2fa',type:'text',visible:true,enabled:true},{name:'',type:'submit',visible:true,enabled:true}]};}
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdd-two-factor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const counts={prepare:0,provider:0,submit:0,release:0},fills=[];
  const response={url:()=>origin+'/take2fa.php',request:()=>({method:()=> 'POST'}),status:()=>302,
    allHeaders:async()=>({location:origin+'/attendance.php'}),text:async()=>''};
  const input={count:async()=>1,fill:async value=>{fills.push(value);}},submit={count:async()=>1,click:async()=>{counts.submit++;}};
  const page={url:()=>origin+'/take2fa.php',locator:selector=>selector.includes('[name="2fa"]')?input:submit,
    waitForResponse:async predicate=>predicate(response)?response:null,waitForLoadState:async()=>{}};
  const config={automationUserDataDir:path.join(root,'data/chrome-user-data'),siteTwoFactorRecovery:{[origin]:{
    enabled:true,reviewed:true,provider:'bitwarden',adapterId,expectedAccountId:'7'}}};
  const scope={binding:{accountKey:'site-default',profileBinding:binding,adapterId},assertCurrent:async()=>true,
    release:async()=>{counts.release++;}};
  let reads=0;
  const args={page,root,config,clock:()=>now.getTime(),validate:async()=>scope,inspect:async()=>form(),
    passive:()=>({}),read:async()=>proof(++reads>3?'already_signed':'not_signed'),
    acquire:async()=>({}),release:async()=>{},prepare:async()=>{counts.prepare++;return {ready:true};},
    withTotp:async({consume})=>{counts.provider++;await consume(code,{validUntilMs:now.getTime()+15_000});return {ready:true};},...overrides};
  return {args,counts,fills,response,scope,root};
}

test('only the exact same-origin two-step form and reviewed return targets can consume a code',()=>{
  assert.equal(hddolbyTwoFactorFormReviewed(form()),true);
  for(const change of [{sameOrigin:false},{path:'/takelogin.php'},{method:'GET'},
    {returntoPath:'/logout.php'},{returntoUnsafe:true},{passwordPresent:true},{visible:false},{sameWindow:false},
    {fields:[...form().fields,{name:'unexpected',type:'hidden'}]},
    {fields:form().fields.filter(f=>f.name!=='returnto')}])assert.equal(hddolbyTwoFactorFormReviewed({...form(),...change}),false);
});
test('already signed skips both cache preparation and current-code access',async t=>{
  const f=fixture(t,{read:async()=>proof('already_signed')});
  const value=await recoverHddolbyTwoFactor(f.args);
  assert.equal(value.twoFactorRecovery.reason,'already_signed');assert.equal(value.readback.status,'already_signed');
  assert.equal(f.counts.prepare,0);assert.equal(f.counts.provider,0);assert.equal(f.counts.submit,0);
});
test('a bound accepted authentication needs account/day proof and clears the ephemeral field',async t=>{
  const f=fixture(t),value=await recoverHddolbyTwoFactor(f.args);
  assert.deepEqual(value.twoFactorRecovery,{reason:'authentication_accepted',attempted:true,accepted:true});
  assert.equal(value.readback.status,'already_signed');assert.equal(f.counts.submit,1);assert.equal(f.counts.provider,1);
  assert.deepEqual(f.fills,[code,'']);assert.equal(f.counts.release,1);
  assert.ok(!JSON.stringify(value).includes(code));
  const journal=fs.readFileSync(path.join(f.root,'data/bitwarden/hddolby-authentication.json'),'utf8');
  assert.ok(!journal.includes(code));assert.equal(JSON.parse(journal).attempts[0].state,'accepted');
});
test('disabled, unbound, changed protocol, missing account proof and mismatched account cannot request a TOTP',async t=>{
  for(const overrides of [{config:{}},{validate:async()=>null},{inspect:async()=>({...form(),sameOrigin:false})},
    {read:async()=>({status:'unknown',failureCode:'account_mismatch'})},
    {read:async()=>({...proof(),evidence:{...proof().evidence,authoritative:false}})}]){
    const f=fixture(t,overrides);await recoverHddolbyTwoFactor(f.args);
    assert.equal(f.counts.provider,0);assert.equal(f.counts.submit,0);
  }
});
test('rejected or unknown authentication is never repeated on the same business day',async t=>{
  for(const kind of ['rejected','unknown']){
    const f=fixture(t,{read:async()=>proof()});
    f.response.status=()=>200;f.response.text=async()=>kind==='rejected'?'二步验证码错误':'未确认';
    const first=await recoverHddolbyTwoFactor(f.args);
    assert.equal(first.twoFactorRecovery.reason,'authentication_'+kind);
    const second=await recoverHddolbyTwoFactor(f.args);
    assert.equal(second.twoFactorRecovery.reason,'daily_recovery_limit');
    assert.equal(f.counts.provider,1);assert.equal(f.counts.submit,1);
  }
});
test('pending crash guard, stale proof and business-day changes stop authentication',async t=>{
  const pending=fixture(t);fs.mkdirSync(path.join(pending.root,'data/bitwarden'),{recursive:true});
  fs.writeFileSync(path.join(pending.root,'data/bitwarden/hddolby-authentication.json'),JSON.stringify({schemaVersion:1,attempts:[{
    origin,accountKey:'site-default',profileBinding:binding,businessDate:'2026-10-14',state:'pending',attemptedAt:now.toISOString()}]}));
  assert.equal((await recoverHddolbyTwoFactor(pending.args)).twoFactorRecovery.reason,'daily_recovery_limit');
  assert.equal(pending.counts.provider,0);
  const stale=fixture(t,{read:async()=>proof('not_signed',new Date(now.getTime()-30_001))});
  assert.equal((await recoverHddolbyTwoFactor(stale.args)).twoFactorRecovery.reason,'passive_proof_unavailable');
  assert.equal(stale.counts.provider,0);
  const changed=fixture(t);changed.scope.assertCurrent=async()=>false;
  await recoverHddolbyTwoFactor(changed.args);assert.equal(changed.counts.provider,0);
});
test('a proven pre-dispatch failure never spends the daily authentication allowance',async t=>{
  const f=fixture(t,{read:async()=>proof()});
  const original=f.args.page.locator;let available=false;
  f.args.page.locator=selector=>{
    const field=original(selector);
    return {...field,count:async()=>available?1:0};
  };
  const first=await recoverHddolbyTwoFactor(f.args);
  assert.equal(first.twoFactorRecovery.attempted,false);assert.equal(f.counts.submit,0);
  assert.equal(fs.existsSync(path.join(f.root,'data/bitwarden/hddolby-authentication.json')),false);
  available=true;
  const second=await recoverHddolbyTwoFactor(f.args);
  assert.equal(second.twoFactorRecovery.attempted,true);assert.equal(second.twoFactorRecovery.accepted,true);
  assert.equal(f.counts.submit,1);
});
test('provider callback cannot duplicate a pending authentication or leak private failures',async t=>{
  const f=fixture(t);f.args.withTotp=async({consume})=>{
    f.counts.provider++;await Promise.all([consume(code,{validUntilMs:now.getTime()+15_000}),consume(code,{validUntilMs:now.getTime()+15_000})]);
    throw new Error('SYNTHETIC_SECRET '+code);
  };
  const value=await recoverHddolbyTwoFactor(f.args);
  assert.equal(f.counts.submit,1);assert.ok(!JSON.stringify(value).includes(code));assert.ok(!JSON.stringify(value).includes('SYNTHETIC_SECRET'));
});
test('passive browser transport refuses foreign origins, attendance and redirects before fetch',async()=>{
  let calls=0;
  const page={url:()=>origin+'/take2fa.php',context:()=>({}),evaluate:async()=>{calls++;return {url:origin+'/login.php',status:302,body:'',date:''};}};
  const context=hddolbyPassiveContext(page);
  for(const url of [origin+'/attendance.php','https://other.example/index.php',origin+'/log.php?key=secret'])
    await assert.rejects(()=>context.request.get(url),/rejected/);
  assert.equal(calls,0);await assert.rejects(()=>context.request.get(origin+'/index.php'),/redirect/);
});
test('the original mature browser hook preserves the no-duplicate success path',async()=>{
  const at=new Date(),signed={...proof('already_signed',at),evidence:{...proof('already_signed',at).evidence,
    businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(at)}};
  let recoveryCalls=0,navigations=0;
  const page={url:()=>origin+'/take2fa.php',context:()=>({}),goto:async()=>{navigations++;}};
  const value=await tryHddolbyPostRedirectVerification(page,origin,{},async()=>signed,async()=>{recoveryCalls++;});
  assert.equal(value.status,'already_signed');assert.equal(recoveryCalls,0);assert.equal(navigations,0);
});
