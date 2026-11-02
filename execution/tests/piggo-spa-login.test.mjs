import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {recoverPiggoSpaLogin,inspectPiggoSpaLogin} from '../src/piggo-login.mjs';
import {readNativePtApiHeader} from '../src/native-pt-api.mjs';
import {withBitwardenLogin} from '../src/bitwarden-totp.mjs';
import {fixture,response,piggoLoginDom,observedLoginRequests} from './helpers/piggo-spa-fixture.mjs';

function loginFixture(t,{status=200,captcha=false,otp=false,afterChallenge=false,srp=false,replay=false,unknown=false}={}){
  const f=fixture(t),context=f.createContext(),waits=[],filled={};
  const file=path.join(f.root,'data/bitwarden/recovery-state.json');
  f.config.nativePtTwoFactorRecovery={[f.origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
    loginSource:'bitwarden',spaPasswordFormReviewed:true}};f.save();
  let route,currentUrl='about:blank',posts=0,clicks=0,prepares=0,reads=0,authenticated=false;
  const emit=value=>{for(const waiter of waits)if(!waiter.done&&waiter.predicate(value)){waiter.done=true;waiter.resolve(value);}};
  const dispatch=async(method,url)=>{
    let allowed=false;
    const next={request:()=>({url:()=>url,method:()=>method}),continue:async()=>{allowed=true;},abort:async()=>{},
      fallback:async()=>{allowed=await context.request(method,url);}};
    await route(next);return allowed;
  };
  let formRendered=false;
  const page={url:()=>currentUrl,context:()=>context,route:async(pattern,handler)=>{route=handler;},unroute:async()=>{route=null;},
    // The real form only exists after the lazy chunk loads, so inspecting first must fail.
    waitForSelector:async()=>{formRendered=true;},
    evaluate:(fn,args)=>{
      if(!formRendered)throw Error('form inspected before it rendered');
      return piggoLoginDom({captcha:captcha||afterChallenge&&posts>0,otp}).evaluate(fn,args);
    },
    waitForResponse:predicate=>new Promise(resolve=>waits.push({predicate,resolve,done:false})),
    goto:async url=>{assert.equal(url,f.origin+'/login');currentUrl=url;
      for(const [method,route,allowed] of observedLoginRequests)
        assert.equal(await dispatch(method,new URL(route,f.origin).href),allowed,method+' '+route);
      emit(response(f.origin+'/v1/web/auth/guest-config',{captcha,srp}));},
    locator:selector=>{
      const elements=piggoLoginDom().document.querySelectorAll(selector);assert.equal(elements.length,1,selector);
      return {fill:async value=>{
      assert.equal(elements[0].tagName,'INPUT');
      if(value){const audit=JSON.parse(fs.readFileSync(file));assert.equal(audit.attempts.at(-1).state,'pending');}
      filled[selector]=value;
    },click:async()=>{
      assert.equal(elements[0].tagName,'BUTTON');assert.equal(elements[0].type,'submit');
      clicks++;
      if(srp)assert.equal(await dispatch('POST',f.origin+'/v1/web/auth/srp/challenge'),true);
      const url=f.origin+(srp?'/v1/web/auth/srp/login':'/v1/web/login');
      if(await dispatch('POST',url)){
        posts++;authenticated=status===200&&!unknown;
        if(replay)assert.equal(await dispatch('POST',f.origin+'/v1/web/login'),false);
        emit(response(url,{}, {status,method:'POST'}));
      }
    }};}};
  const credential={username:'fixture-user',password:['WO12','MARKED','CREDENTIAL'].join('_')};
  const args={...f,page,profileProof:async()=>true,validateLease:async()=>{},
    prepare:async()=>{prepares++;return {ready:true};},
    withLogin:async({consume})=>{reads++;await consume(credential);return {ready:true};},
    readHeader:async()=>authenticated?readNativePtApiHeader(f):{status:'login_required'}};
  return {f,args,file,credential,filled,dispatch,setAuthenticated:()=>{authenticated=true;},
    get posts(){return posts;},get clicks(){return clicks;},get prepares(){return prepares;},get reads(){return reads;}};
}

for(const srp of [false,true])test('SPA login submits once through the real form contract and registers same-account calendar readback '+srp,async t=>{
  const f=loginFixture(t,{srp,replay:true}),result=await recoverPiggoSpaLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(f.posts,1);assert.equal(f.clicks,1);
  assert.equal(JSON.parse(fs.readFileSync(f.file)).attempts[0].state,'accepted');
  assert.ok(Object.values(f.filled).every(value=>value===''));
  assert.ok(!JSON.stringify(result).includes(f.credential.password));assert.ok(!fs.readFileSync(f.file,'utf8').includes(f.credential.password));
  const again=await recoverPiggoSpaLogin(f.args);
  assert.equal(again.nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.posts,1);assert.equal(f.reads,1);
});

test('provider failures keep their reason code and leave the daily login budget unused',async t=>{
  const prepareFails=loginFixture(t),prepared=await recoverPiggoSpaLogin({...prepareFails.args,prepare:async()=>({ready:false,reason:'vault_locked'})});
  assert.deepEqual(prepared.nativeTwoFactorRecovery,{phase:'password_login',attempted:false,accepted:false,reason:'provider_unavailable',providerReason:'vault_locked'});
  assert.equal(prepareFails.posts,0);assert.equal(fs.existsSync(prepareFails.file),false);
  const loginFails=loginFixture(t),read=await recoverPiggoSpaLogin({...loginFails.args,withLogin:async()=>({ready:false,reason:'login_read_failed'})});
  assert.equal(read.nativeTwoFactorRecovery.reason,'provider_unavailable');assert.equal(read.nativeTwoFactorRecovery.providerReason,'login_read_failed');
  assert.equal(loginFails.posts,0);assert.equal(fs.existsSync(loginFails.file),false);
});

test('observed Vue form accepts default GET/no action and autocomplete token lists without reading values',async()=>{
  for(const webauthn of [false,true])for(const action of [undefined,'/login','https://piggo.me/login']){
    const dom=piggoLoginDom({webauthn,action,invite:true}),page={url:()=> 'https://piggo.me/login',evaluate:dom.evaluate};
    assert.equal(dom.form.getAttribute('method'),null);assert.equal(dom.submit.getAttribute('type'),null);
    assert.deepEqual(await inspectPiggoSpaLogin(page),{reviewed:true,challenge:false,otp:false});
  }
});

test('setup/loading/captcha/OTP, foreign actions, extra inputs and ambiguous form controls never authorize login',async()=>{
  const credentialAction=new URL('https://piggo.me/login');credentialAction.username='fixture';
  const rejected=[{setup:true},{loading:true},{action:'https://foreign.example/login'},{action:'/login?next=fixture'},
    {action:'/login#fixture'},{action:credentialAction.href},{target:'_blank'},{extra:[{type:'checkbox'}]},
    {extra:[{name:'username',autocomplete:'username'}]}];
  for(const options of rejected){
    const dom=piggoLoginDom(options),result=await inspectPiggoSpaLogin({url:()=> 'https://piggo.me/login',evaluate:dom.evaluate});
    assert.equal(result.reviewed,false,JSON.stringify(options));
  }
  for(const options of [{captcha:true},{otp:true},{iframe:true}]){
    const dom=piggoLoginDom(options),result=await inspectPiggoSpaLogin({url:()=> 'https://piggo.me/login',evaluate:dom.evaluate});
    assert.ok(!result.reviewed||result.challenge||result.otp);
    assert.equal(result.challenge,!!(options.captcha||options.iframe));assert.equal(result.otp,!!(options.captcha||options.otp));
  }
  for(const mutate of [dom=>{dom.username.attrs.autocomplete='notusername';},dom=>{dom.password.attrs.name='other';},
    dom=>{dom.password.attrs.autocomplete='new-password';},dom=>{dom.password.attrs.readonly='';},
    dom=>{dom.username.attrs.hidden='';},dom=>{dom.submit.textContent='完成并登录';},
    dom=>{dom.submit.attrs.type='button';},dom=>{dom.root.children.push(dom.submit);},
    dom=>{dom.root.children.push({tagName:'BASE',attrs:{href:'https://foreign.example/'},children:[],
      getAttribute:name=>name==='href'?'https://foreign.example/':null});}]){
    const dom=piggoLoginDom();mutate(dom);
    assert.equal((await inspectPiggoSpaLogin({url:()=> 'https://piggo.me/login',evaluate:dom.evaluate})).reviewed,false);
  }
});

test('rejected or ambiguous authentication remains in the existing audit and cannot replay that day',async t=>{
  for(const options of [{status:401},{unknown:true},{afterChallenge:true}]){
    const f=loginFixture(t,options),result=await recoverPiggoSpaLogin(f.args);
    assert.equal(result.status,'needs_attention');assert.equal(f.posts,1);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).attempts[0].state,options.status===401?'rejected':'unknown');
    assert.equal((await recoverPiggoSpaLogin(f.args)).nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.posts,1);
    assert.ok(!JSON.stringify(result).includes(f.credential.password));
  }
});

test('read-only, CAPTCHA, OTP, missing new-form review and changed scope never request login credentials',async t=>{
  for(const mode of ['readonly','captcha','otp','unreviewed','scope']){
    const f=loginFixture(t,{captcha:mode==='captcha',otp:mode==='otp'});
    if(mode==='readonly')f.args.mode='ReadOnly';
    if(mode==='unreviewed'){delete f.f.config.nativePtTwoFactorRecovery[f.f.origin].spaPasswordFormReviewed;f.f.save();}
    if(mode==='scope')f.args.profileProof=async()=>false;
    const result=await recoverPiggoSpaLogin(f.args);
    assert.equal(result.status,'needs_attention');assert.equal(f.reads,0);assert.equal(f.prepares,0);assert.equal(f.posts,0);assert.equal(fs.existsSync(f.file),false);
  }
  assert.equal(await inspectPiggoSpaLogin({url:()=> 'https://piggo.me/login.php'}),null);
});

test('already-authenticated account/day proof avoids the vault and new authentication intent',async t=>{
  const f=loginFixture(t);f.setAuthenticated();
  const result=await recoverPiggoSpaLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.nativeTwoFactorRecovery.attempted,false);
  assert.equal(f.reads,0);assert.equal(f.prepares,0);assert.equal(f.posts,0);assert.equal(fs.existsSync(f.file),false);
});

test('an early-returned provider is awaited and a late credential callback cannot escape the authentication scope',async t=>{
  const detached=loginFixture(t);
  detached.args.withLogin=async({consume})=>{void consume(detached.credential);return {ready:true};};
  assert.equal((await recoverPiggoSpaLogin(detached.args)).status,'logged_in');assert.equal(detached.posts,1);
  const late=loginFixture(t);let callback;
  late.args.withLogin=async({consume})=>{callback=consume;return {ready:true};};
  assert.equal((await recoverPiggoSpaLogin(late.args)).status,'needs_attention');
  await callback(late.credential);assert.equal(late.posts,0);assert.equal(fs.existsSync(late.file),false);
});

test('Bitwarden Login enables only the PigGo opt-in while retaining the sealed protocol tuple and wiping its consumer object',async t=>{
  const f=fixture(t),origin=f.origin,contract={enabled:true,itemName:'piggo.me',itemId:'10000000-0000-4000-8000-000000000001',
    accountKey:'site-default',profileBinding:f.profileBinding,adapterId:'piggo-nexus-stepup-v1'};
  const config={...f.config,nativePtTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,allowPasswordLogin:true,loginSource:'bitwarden'}},
    bitwardenTotp:{enabled:true,serverUrl:'https://vault.example',cliEntryPoint:path.join(f.root,'tools/bitwarden-cli/bw.js'),
      appDataDir:path.join(f.root,'data/bitwarden/client'),sessionFile:path.join(f.root,'data/bitwarden/session.dpapi'),routes:{[origin]:contract}}};
  let consumed,calls=0;const marker=['WO12','PROVIDER','MARKER'].join('_');
  const args={root:f.root,origin,binding:{accountKey:'site-default',profileBinding:f.profileBinding,adapterId:contract.adapterId},config,
    execute:async(file,argv)=>{calls++;assert.equal(argv.includes(marker),false);assert.equal(argv.at(-1),'Login');
      return {stdout:JSON.stringify({ready:true,reason:'login_ready',username:'fixture-user',password:marker}),stderr:''};},
    consume:value=>{consumed=value;assert.equal(value.password,marker);}};
  const result=await withBitwardenLogin(args);
  assert.deepEqual(result,{ready:true,reason:'login_consumed'});assert.deepEqual(consumed,{username:'',password:''});assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes(marker),false);
  for(const binding of [{...args.binding,profileBinding:'b'.repeat(64)},{...args.binding,adapterId:'piggo-spa-unsealed'},
    {...args.binding,accountKey:'other'}])assert.equal((await withBitwardenLogin({...args,binding})).ready,false);
  assert.equal(calls,1);
});
