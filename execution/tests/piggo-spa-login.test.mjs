import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {recoverPiggoSpaLogin,inspectPiggoSpaLogin} from '../src/piggo-login.mjs';
import {readNativePtApiHeader} from '../src/native-pt-api.mjs';
import {withBitwardenLogin} from '../src/bitwarden-totp.mjs';
import {fixture,response,piggoLoginDom,observedLoginRequests} from './helpers/piggo-spa-fixture.mjs';

function loginFixture(t,{status=200,captcha=false,otp=false,afterChallenge=false,srp=false,replay=false,unknown=false,body={},blockedEndpoint}={}){
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
      if(blockedEndpoint){
        // The page needs a request the firewall never allows, so the login response never comes.
        assert.equal(await dispatch('POST',new URL(blockedEndpoint,f.origin).href),false);
        for(const waiter of waits)if(!waiter.done){waiter.done=true;waiter.resolve(null);}
        return;
      }
      const url=f.origin+(srp?'/v1/web/auth/srp/login':'/v1/web/login');
      if(await dispatch('POST',url)){
        posts++;authenticated=status===200&&!unknown;
        if(replay)assert.equal(await dispatch('POST',f.origin+'/v1/web/login'),false);
        emit(response(url,body,{status,method:'POST'}));
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
  const recovery=result.nativeTwoFactorRecovery;
  assert.equal(recovery.submitStage,'accepted');assert.equal(recovery.loginHttpStatus,200);
  assert.equal(recovery.loginPosts,1);assert.equal(recovery.challengePosts,srp?1:0);
  // The pre-click analytics POST is not kept; only the blocked replay after the click is.
  assert.deepEqual(recovery.blockedPosts,['/v1/web/login']);
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

test('an unavailable passive proof retains only code diagnostics and never reaches the provider',async t=>{
  for(const before of [
    {status:'unconfirmed',failureCode:'native_readback_unavailable',nativeReadback:{apiStage:'binding'}},
    {status:'unconfirmed',failureCode:'authoritative_status_unavailable',nativeReadback:{apiStage:'http_status'}},
    {status:'not_signed',failureCode:'PRIVATE RESPONSE',nativeReadback:{apiStage:'https://private.example/path'}},
  ]){
    const f=loginFixture(t),result=await recoverPiggoSpaLogin({...f.args,readHeader:async()=>before});
    assert.equal(result.nativeTwoFactorRecovery.reason,'passive_proof_unavailable');
    assert.equal(result.nativeTwoFactorRecovery.passiveStatus,before.status);
    if(before.failureCode==='PRIVATE RESPONSE'){
      assert.equal(result.nativeTwoFactorRecovery.passiveFailure,undefined);
      assert.equal(result.nativeTwoFactorRecovery.passiveStage,undefined);
    }else{
      assert.equal(result.nativeTwoFactorRecovery.passiveFailure,before.failureCode);
      assert.equal(result.nativeTwoFactorRecovery.passiveStage,before.nativeReadback.apiStage);
    }
    assert.equal(result.failureCode,'two_factor_required');
    assert.equal(f.reads,0);assert.equal(f.prepares,0);assert.equal(f.posts,0);assert.equal(fs.existsSync(f.file),false);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private\.example/);
  }
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
  for(const [options,expected] of [
    [{status:401},{submitStage:'login_http_status',loginHttpStatus:401,loginPosts:1,challengePosts:0}],
    [{unknown:true},{submitStage:'post_login_receipt',loginHttpStatus:200,postLoginForm:'unchanged',afterStatus:'login_required',loginPagePath:'/login'}],
    [{afterChallenge:true},{submitStage:'post_login_form',loginHttpStatus:200,postLoginForm:'otp'}],
  ]){
    const f=loginFixture(t,options),result=await recoverPiggoSpaLogin(f.args);
    assert.equal(result.status,'needs_attention');assert.equal(f.posts,1);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).attempts[0].state,options.status===401?'rejected':'unknown');
    for(const [key,value] of Object.entries(expected))assert.equal(result.nativeTwoFactorRecovery[key],value,key);
    assert.equal((await recoverPiggoSpaLogin(f.args)).nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.posts,1);
    assert.ok(!JSON.stringify(result).includes(f.credential.password));
  }
});

test('an unknown submission says how far it got without carrying the response message or private paths',async t=>{
  const failed=loginFixture(t,{unknown:true,body:{code:1001,msg:'PRIVATE RESPONSE',data:null}});
  const result=await recoverPiggoSpaLogin(failed.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'authentication_unknown');assert.equal(result.nativeTwoFactorRecovery.loginApiCode,1001);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  const blocked=loginFixture(t,{srp:true,blockedEndpoint:'/v1/web/auth/srp/verify'}),stopped=await recoverPiggoSpaLogin(blocked.args);
  assert.equal(stopped.nativeTwoFactorRecovery.reason,'authentication_unknown');assert.equal(blocked.posts,0);
  assert.equal(JSON.parse(fs.readFileSync(blocked.file)).attempts[0].state,'unknown');
  assert.deepEqual(Object.fromEntries(['submitStage','loginPosts','challengePosts','blockedPosts','loginHttpStatus']
    .map(key=>[key,stopped.nativeTwoFactorRecovery[key]])),
    {submitStage:'login_response',loginPosts:0,challengePosts:1,blockedPosts:['/v1/web/auth/srp/verify'],loginHttpStatus:undefined});
  for(const endpoint of ['/v1/web/PRIVATE_PATH','/other/private','https://foreign.example/v1/web/x','/v1/web/user/42/heartbeat']){
    const f=loginFixture(t,{blockedEndpoint:endpoint}),outcome=await recoverPiggoSpaLogin(f.args);
    assert.equal(outcome.nativeTwoFactorRecovery.submitStage,'login_response');assert.equal(outcome.nativeTwoFactorRecovery.blockedPosts,undefined);
    assert.doesNotMatch(JSON.stringify(outcome),/PRIVATE|foreign/);
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
