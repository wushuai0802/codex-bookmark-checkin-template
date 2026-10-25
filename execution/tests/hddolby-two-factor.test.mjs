import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {recoverHddolbyTwoFactor,hddolbyTwoFactorFormReviewed,hddolbyPassiveContext,inspectHddolbyTwoFactorForm} from '../src/hddolby-two-factor.mjs';
import {tryHddolbyPostRedirectVerification} from '../src/browser.mjs';

const origin='https://www.hddolby.com',adapterId='hddolby-nexus-stepup-v1';
const now=new Date('2026-10-14T01:00:10.000Z'),binding='a'.repeat(64),code='246810';
function proof(status='not_signed',at=now){return {status,submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
  confirmedAt:at.toISOString(),businessDate:'2026-10-14',pagePath:'/log.php',
  statusSignal:status==='not_signed'?'hddolby_account_header_unsigned':'hddolby_account_header_signed'}};}
function form(){return {sameOrigin:true,path:'/take2fa.php',method:'POST',returntoPath:'/attendance.php',returntoUnsafe:false,
  passwordPresent:false,visible:true,sameWindow:true,fields:[{name:'type',type:'hidden'},{name:'returnto',type:'hidden'},
    {name:'2fa',type:'text',visible:true,enabled:true},{name:'',type:'submit',visible:true,enabled:true}]};}

test('Nexus table-owned controls work without DOM ancestry, persist before input, and submit at most one authentication request',async t=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  t.after(()=>browser.close());
  for(const variant of ['click','input-submit','foreign-form']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdd-form-owner-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const site='https://www.uhddolby.com',context=await browser.newContext(),page=await context.newPage();
    let posts=0,providerCalls=0;
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==site)return route.abort();
      if(request.method()==='POST'){
        assert.equal(url.pathname,'/take2fa.php');posts++;
        const audit=JSON.parse(fs.readFileSync(path.join(root,'data/bitwarden/hddolby-authentication.json'),'utf8'));
        assert.equal(audit.attempts.length,1);assert.equal(audit.attempts[0].state,'pending');
        const body=new URLSearchParams(request.postData());
        assert.equal(body.get('2fa'),code);assert.equal(body.get('type'),'fixture');assert.equal(body.get('returnto'),'/index.php');
        return route.fulfill({status:302,headers:{location:site+'/index.php'}});
      }
      if(url.pathname==='/index.php')return route.fulfill({status:200,body:'fixture authenticated'});
      const action=variant==='foreign-form'?'https://other.example/take2fa.php':'/take2fa.php';
      return route.fulfill({status:200,contentType:'text/html',body:
        '<table><form method="post" action="'+action+'"><tr><td><input type="hidden" name="type" value="fixture">'+
        '<input type="hidden" name="returnto" value="/index.php"><input name="2fa" type="text"><input type="submit" value="Continue">'+
        '</td></tr></form></table><button type="button">Theme</button>'+
        (variant==='input-submit'?'<script>document.getElementsByName("2fa")[0].addEventListener("input",function(){if(this.value.length===6){window.name="fixture-input-submit";this.form.requestSubmit();}});</script>':'')});
    });
    await page.goto(site+'/take2fa.php');
    assert.equal(await page.locator('form input').count(),0);
    const inspected=await inspectHddolbyTwoFactorForm(page);
    assert.equal(Boolean(inspected),variant!=='foreign-form');
    const value=await recoverHddolbyTwoFactor({root,page,config:{automationUserDataDir:path.join(root,'data/profile'),siteTwoFactorRecovery:{[site]:{
      enabled:true,reviewed:true,provider:'bitwarden',adapterId,expectedAccountId:'7'}}},clock:()=>now.getTime(),
      validate:async()=>({binding:{accountKey:'site-default',profileBinding:binding,adapterId},assertCurrent:async()=>true,release:async()=>{}}),
      read:async()=>proof(posts?'already_signed':'not_signed'),prepare:async()=>({ready:true}),
      withTotp:async({consume})=>{providerCalls++;await consume(code,{validUntilMs:now.getTime()+15_000});}});
    assert.equal(posts,variant==='foreign-form'?0:1);assert.equal(providerCalls,variant==='foreign-form'?0:1);
    assert.equal(value.twoFactorRecovery.accepted,variant!=='foreign-form',JSON.stringify({variant,...value}));
    if(variant==='input-submit')assert.equal(await page.evaluate(()=>window.name),'fixture-input-submit');
    assert.doesNotMatch(JSON.stringify(value),new RegExp(code));
    await context.close();
  }
});
function fixture(t,overrides={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hdd-two-factor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const counts={prepare:0,provider:0,submit:0,release:0},fills=[];
  const response={url:()=>origin+'/take2fa.php',request:()=>({method:()=> 'POST'}),status:()=>302,
    allHeaders:async()=>({location:origin+'/attendance.php'}),text:async()=>''};
  const input={count:async()=>1,evaluate:async()=>true,fill:async value=>{fills.push(value);}},submit={count:async()=>1,evaluate:async()=>true,click:async()=>{counts.submit++;}};
  const page={url:()=>origin+'/take2fa.php',locator:selector=>selector.includes('[name="2fa"]')?input:submit,
    waitForResponse:async predicate=>predicate(response)?response:null,waitForLoadState:async()=>{},route:async()=>{},unroute:async()=>{}};
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

test('known vault failures retain a bounded cause without reading or exposing a code',async t=>{
  for(const stage of ['prepare','get']){
    const f=fixture(t,{read:async()=>proof()});
    if(stage==='prepare')f.args.prepare=async()=>({ready:false,reason:'profile_mismatch'});
    else f.args.withTotp=async()=>({ready:false,reason:'vault_locked'});
    const value=await recoverHddolbyTwoFactor(f.args);
    assert.equal(value.twoFactorRecovery.reason,stage==='prepare'?'provider_profile_mismatch':'provider_vault_locked');
    assert.equal(value.twoFactorRecovery.attempted,false);assert.equal(f.counts.submit,0);
  }
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
