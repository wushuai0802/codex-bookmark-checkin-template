import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {recoverPiggoSpaLogin,inspectPiggoSpaLogin,inspectPiggoIdleUnlock} from '../src/piggo-login.mjs';
import {readNativePtApiHeaderInContext} from '../src/native-pt-api.mjs';
import {loginHelperOutcome,authoritativeLoginDailyCheckin,piggoLoginDailyCheckin} from '../src/login-recovery.mjs';
import {withBitwardenLogin} from '../src/bitwarden-totp.mjs';
import {fixture,response,piggoLoginDom,observedLoginRequests,calendarData} from './helpers/piggo-spa-fixture.mjs';
import {runOfflinePiggoIndex} from './helpers/piggo-index-fixture.mjs';

function loginFixture(t,{status=200,captcha=false,otp=false,afterChallenge=false,srp=false,replay=false,unknown=false,body,
  blockedEndpoint,unlock=false,passiveOnly=true,network=[],post={},stale=false,noResponse=false}={}){
  const f=fixture(t,{network,post}),context=f.createContext(),waits=[],filled={},fills=[];
  const file=path.join(f.root,'data/bitwarden/recovery-state.json');
  f.config.nativePtTwoFactorRecovery={[f.origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
    loginSource:'bitwarden',spaPasswordFormReviewed:true}};
  f.config.nativeWafPreflightUrls[0].passiveOnly=passiveOnly;f.save();
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
      return piggoLoginDom({captcha:captcha||afterChallenge&&posts>0,otp,unlock}).evaluate(fn,args);
    },
    waitForResponse:predicate=>new Promise(resolve=>waits.push({predicate,resolve,done:false})),
    goto:async url=>{assert.equal(url,f.origin+(unlock?'/locked':'/login'));currentUrl=url;
      if(unlock){assert.equal(await dispatch('GET',url),true);return;}
      for(const [method,route,allowed] of observedLoginRequests)
        assert.equal(await dispatch(method,new URL(route,f.origin).href),allowed,method+' '+route);
      emit(response(f.origin+'/v1/web/auth/guest-config',{captcha,srp}));},
    locator:selector=>{
      const elements=piggoLoginDom({unlock}).document.querySelectorAll(selector);assert.equal(elements.length,1,selector);
      return {fill:async value=>{
      assert.equal(elements[0].tagName,'INPUT');
      if(value){const audit=JSON.parse(fs.readFileSync(file));assert.equal(audit.attempts.at(-1).state,'pending');}
      filled[selector]=value;
      fills.push(selector);
    },click:async()=>{
      assert.equal(elements[0].tagName,'BUTTON');assert.equal(elements[0].type,'submit');
      clicks++;
      if(unlock){
        assert.equal(await dispatch('POST',f.origin+'/v1/web/me/lab-unlock/srp'),false,'SRP cannot precede challenge');
        for(const endpoint of ['/v1/web/me/lab-unlock/passkey','/v1/web/me/lab-lock','/v1/web/calendar/attendance','/v1/web/login'])
          assert.equal(await dispatch('POST',f.origin+endpoint),false,endpoint);
        assert.equal(await dispatch('GET',f.origin+'/v1/web/me/lab-unlock/passkey/options'),false);
      }
      const challengeUrl=f.origin+(unlock?'/v1/web/me/lab-unlock/srp/challenge':'/v1/web/auth/srp/challenge');
      if(srp||unlock){assert.equal(await dispatch('POST',challengeUrl),true);
        if(replay&&unlock)assert.equal(await dispatch('POST',challengeUrl),false);}
      if(blockedEndpoint){
        // The page needs a request the firewall never allows, so the login response never comes.
        assert.equal(await dispatch('POST',new URL(blockedEndpoint,f.origin).href),false);
        for(const waiter of waits)if(!waiter.done){waiter.done=true;waiter.resolve(null);}
        return;
      }
      const url=f.origin+(unlock?'/v1/web/me/lab-unlock/srp':srp?'/v1/web/auth/srp/login':'/v1/web/login');
      if(await dispatch('POST',url)){
        posts++;authenticated=status===200&&!unknown;
        if(replay)assert.equal(await dispatch('POST',unlock?url:f.origin+'/v1/web/login'),false);
        if(noResponse){for(const waiter of waits)if(!waiter.done){waiter.done=true;waiter.resolve(null);}return;}
        emit(response(url,body??(unlock?{code:0,msg:'synthetic',data:{m2:'synthetic-proof'}}:{}),
          {status,method:'POST',...(stale?{date:'invalid'}:{})}));
      }
    }};}};
  const credential={username:'fixture-user',password:['WO12','MARKED','CREDENTIAL'].join('_')};
  const args={...f,page,profileProof:async()=>true,validateLease:async()=>{},
    prepare:async()=>{prepares++;return {ready:true};},
    withLogin:async({consume})=>{reads++;await consume(credential);return {ready:true};},
    readHeader:async options=>authenticated?readNativePtApiHeaderInContext(options):{status:'login_required',...(unlock?{failureCode:'idle_locked'}:{})}};
  return {f,args,file,credential,filled,fills,dispatch,context,setAuthenticated:()=>{authenticated=true;},
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
  assert.deepEqual(prepared.nativeTwoFactorRecovery,{phase:'password_login',recoveryMode:'password_login',attempted:false,accepted:false,reason:'provider_unavailable',providerReason:'vault_locked'});
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

test('idle unlock reviews the supplied StepUpGate without ever reading an input value',async()=>{
  for(const webauthn of [false,true])for(const passkey of [false,true]){
    const dom=piggoLoginDom({unlock:true,webauthn,passkey});
    assert.throws(()=>dom.username.value,/never read/);assert.throws(()=>dom.password.value,/never read/);
    assert.deepEqual(await inspectPiggoIdleUnlock({url:()=> 'https://piggo.me/locked',evaluate:dom.evaluate}),
      {reviewed:true,challenge:false,otp:false});
  }
  for(const url of ['https://foreign.example/locked','https://piggo.me/login','https://piggo.me/locked?next=1',
    'https://piggo.me/locked#fixture','http://piggo.me/locked'])assert.equal(await inspectPiggoIdleUnlock({url:()=>url}),null);
});

test('unlock review rejects each changed or ambiguous control, hidden extras, CAPTCHA, OTP and foreign form destinations',async()=>{
  for(const options of [{captcha:true},{otp:true},{iframe:true},{loading:true},{extra:[{type:'hidden'}]},
    {action:'https://foreign.example/locked'},{action:'/locked?next=1'},{target:'_blank'}]){
    const dom=piggoLoginDom({unlock:true,...options});
    assert.equal((await inspectPiggoIdleUnlock({url:()=> 'https://piggo.me/locked',evaluate:dom.evaluate})).reviewed,false,JSON.stringify(options));
  }
  for(const mutate of [dom=>{delete dom.form.attrs.class;},dom=>{dom.root.children.push(dom.form);},
    dom=>{delete dom.username.attrs.readonly;},dom=>{dom.username.attrs.class='other';},dom=>{dom.username.attrs.type='hidden';},
    dom=>{dom.username.attrs.name='other';},dom=>{dom.username.attrs.autocomplete='other';},dom=>{dom.username.attrs.tabindex='0';},
    dom=>{dom.form.children.push(dom.username);},dom=>{dom.password.attrs.hidden='';},dom=>{dom.password.attrs.readonly='';},
    dom=>{dom.password.attrs.disabled='';},dom=>{dom.password.attrs.name='other';},dom=>{dom.password.attrs.type='text';},
    dom=>{dom.password.attrs.autocomplete='new-password';},dom=>{delete dom.password.attrs.required;},
    dom=>{dom.form.children.push(dom.password);},dom=>{dom.submit.textContent='登录';},dom=>{dom.submit.attrs.disabled='';},
    dom=>{dom.submit.attrs.type='button';},dom=>{dom.form.children.push(dom.submit);},dom=>{dom.submit.attrs.hidden='';}]){
    const dom=piggoLoginDom({unlock:true});mutate(dom);
    assert.equal((await inspectPiggoIdleUnlock({url:()=> 'https://piggo.me/locked',evaluate:dom.evaluate})).reviewed,false,String(mutate));
  }
});

test('idle unlock fills only the password, admits each SRP POST once and persists the shared password_login audit',async t=>{
  const f=loginFixture(t,{unlock:true,replay:true}),result=await recoverPiggoSpaLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.nativeTwoFactorRecovery.recoveryMode,'idle_unlock');
  assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(result.nativeTwoFactorRecovery.submitStage,'unlock_accepted');
  assert.equal(result.nativeTwoFactorRecovery.challengePosts,1);assert.equal(result.nativeTwoFactorRecovery.loginPosts,1);
  assert.equal(f.posts,1);assert.equal(f.clicks,1);assert.equal(f.f.launches,0);assert.equal(f.f.contexts.length,1);
  assert.ok(f.fills.length>0&&f.fills.every(selector=>selector.includes('name="password"')));
  const journal=JSON.parse(fs.readFileSync(f.file));assert.equal(journal.attempts.length,1);
  assert.equal(journal.attempts[0].phase,'password_login');assert.equal(journal.attempts[0].state,'accepted');
  assert.equal(result.dailyCheckin.status,'not_signed');assert.equal(result.dailyCheckin.receiptAccepted,true);
  assert.equal(loginHelperOutcome(JSON.stringify(result)).recoveryMode,'idle_unlock');
  assert.doesNotMatch(JSON.stringify(result)+fs.readFileSync(f.file,'utf8'),/WO12_MARKED_CREDENTIAL|synthetic-proof/);
});

test('unlock HTTP/envelope rejection and missing, stale or ambiguous responses keep the proper state and cannot replay',async t=>{
  for(const [options,state] of [
    ...[400,401,403,422].map(status=>[{status},'rejected']),
    [{body:{code:12,msg:'PRIVATE RESPONSE',data:{}}},'rejected'],[{body:{code:'denied',msg:'PRIVATE RESPONSE'}},'rejected'],
    [{status:500},'unknown'],[{status:302},'unknown'],[{noResponse:true},'unknown'],[{stale:true},'unknown'],
    [{body:{}},'unknown'],[{body:{code:0,msg:'x'.repeat(100_001)}},'unknown'],[{unknown:true},'unknown'],
    [{network:[{me:{user:{id:43}}}]},'unknown'],
  ]){
    const f=loginFixture(t,{unlock:true,...options}),result=await recoverPiggoSpaLogin(f.args);
    assert.equal(result.status,'needs_attention',JSON.stringify(options).slice(0,160));assert.equal(result.nativeTwoFactorRecovery.accepted,false);
    assert.equal(JSON.parse(fs.readFileSync(f.file)).attempts[0].state,state);
    assert.equal((await recoverPiggoSpaLogin(f.args)).nativeTwoFactorRecovery.reason,'daily_recovery_limit');
    assert.equal(f.posts,1);assert.equal(f.reads,1);assert.doesNotMatch(JSON.stringify(result),/PRIVATE RESPONSE|synthetic-proof/);
  }
});

test('login and idle unlock consume the same daily password budget in both directions',async t=>{
  for(const unlock of [false,true]){
    const f=loginFixture(t,{unlock}),first=await recoverPiggoSpaLogin(f.args);
    assert.equal(first.nativeTwoFactorRecovery.accepted,true);
    const second=await recoverPiggoSpaLogin({...f.args,readHeader:async()=>({status:'login_required',...(unlock?{}:{failureCode:'idle_locked'})})});
    assert.equal(second.nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(f.posts,1);assert.equal(f.reads,1);
  }
});

for(const unlock of [false,true])for(const mode of ['submit','passive','checked'])test(`accepted ${unlock?'unlock':'login'} completes its configured calendar flow in the same context: ${mode}`,async t=>{
  const network=mode==='checked'?[{data:calendarData('checked')},{data:calendarData('checked')}]:[];
  const f=loginFixture(t,{unlock,passiveOnly:mode!=='submit',network}),result=await recoverPiggoSpaLogin(f.args);
  const outcome=loginHelperOutcome(JSON.stringify(result)),binding={origin:f.f.origin,accountKey:'site-default',profileBinding:f.f.profileBinding,now:f.f.clock()};
  assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(f.f.launches,0);assert.equal(f.f.contexts.length,1);
  assert.equal(f.context.closed,false);assert.equal(f.f.posts.length,mode==='submit'?1:0);
  const saved=JSON.parse(fs.readFileSync(path.join(f.f.root,'data/native-pt-attempts.json')));
  if(mode==='submit'){
    assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'confirmed');
    assert.equal(authoritativeLoginDailyCheckin('native_saved_password',outcome,binding).status,'signed');
    const phases=f.f.events.filter(value=>['readback','inspect','begin','POST','finish'].includes(value));
    assert.deepEqual(phases.slice(-5),['readback','inspect','begin','POST','finish']);
  }else{
    assert.equal(saved.attempts.length,0);
    assert.equal(piggoLoginDailyCheckin('native_saved_password',outcome,binding).status,mode==='checked'?'already_signed':'not_signed');
    assert.equal(authoritativeLoginDailyCheckin('native_saved_password',outcome,binding)?.status,mode==='checked'?'already_signed':undefined);
  }
});

test('same-session submission uncertainty survives helper projection and blocks another attendance attempt',async t=>{
  const f=loginFixture(t,{unlock:true,passiveOnly:false,post:{error:true}}),result=await recoverPiggoSpaLogin(f.args);
  assert.equal(result.status,'logged_in');assert.equal(result.dailyCheckin.failureCode,'submission_outcome_unknown');
  assert.equal(result.dailyCheckin.retryable,false);assert.equal(f.f.posts.length,1);
  const outcome=loginHelperOutcome(JSON.stringify(result)),binding={origin:f.f.origin,profileBinding:f.f.profileBinding,now:f.f.clock()};
  assert.equal(piggoLoginDailyCheckin('native_saved_password',outcome,binding).failureCode,'submission_outcome_unknown');
  assert.equal(authoritativeLoginDailyCheckin('native_saved_password',outcome,binding),null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.f.root,'data/native-pt-attempts.json'))).attempts[0].state,'submitted');
  await recoverPiggoSpaLogin(f.args);assert.equal(f.f.posts.length,1);
});

for(const unlock of [false,true])for(const mode of ['submit','passive','checked','unknown'])test(`real index consumes the same-session ${unlock?'unlock':'login'} result without deferring: ${mode}`,async t=>{
  const network=mode==='checked'?[{data:calendarData('checked')},{data:calendarData('checked')}]:[];
  const f=loginFixture(t,{unlock,passiveOnly:['passive','checked'].includes(mode),network,
    post:mode==='unknown'?{error:true}:{}}),helper=await recoverPiggoSpaLogin(f.args);
  const out=await runOfflinePiggoIndex(f.f,helper);
  assert.equal(out.calls.length,1);assert.equal(out.report.results.length,1);
  const row=out.report.results[0],expected={submit:'signed',passive:'not_signed',checked:'already_signed',unknown:'needs_attention'}[mode];
  assert.equal(row.status,expected,JSON.stringify(row));assert.notEqual(row.status,'deferred');
  assert.equal(out.code,['submit','checked'].includes(mode)?0:2,out.stderr);
  assert.equal(row.recovery.history[0].login.attempts[0].recoveryMode,unlock?'idle_unlock':'password_login');
  if(mode==='unknown'){assert.equal(row.failureCode,'submission_outcome_unknown');assert.equal(row.retryable,false);}
  assert.equal(f.f.posts.length,['submit','unknown'].includes(mode)?1:0);
});

test('real index keeps submission-marked preflight quarantined and leaves other native sites deferred after login',async t=>{
  const tainted=loginFixture(t),helper={origin:tainted.f.origin,status:'logged_in'};
  const held=await runOfflinePiggoIndex(tainted.f,helper,{preflightChange:{clicked:true}});
  assert.equal(held.report.results[0].failureCode,'submission_outcome_unknown');assert.equal(held.calls.length,0);
  const other=loginFixture(t),out=await runOfflinePiggoIndex(other.f,{status:'logged_in'},{otherOrigin:'https://tracker.example'});
  assert.equal(out.calls.length,1);assert.equal(out.report.results[0].status,'deferred');
  assert.equal(out.report.results[0].loginRecovered,true);
});
