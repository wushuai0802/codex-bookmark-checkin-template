import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {recoverNativePtTwoFactor} from '../src/native-pt-two-factor.mjs';
import {runNativePtGate} from '../src/native-pt-gate.mjs';
import {readNativePtApiHeader} from '../src/native-pt-api.mjs';

const ORIGIN='https://piggo.me',HOME=ORIGIN+'/index.php',AUTH=ORIGIN+'/bank/authentication';
const PROTOCOL=ORIGIN+'/inputWrap/js/index.js',CODE='123456',OWN='71823940';
const SECRET=['PRIVATE','VAULT','SECRET'].join('_'),now=new Date('2026-10-13T04:00:00Z');
const PUBLIC_SCRIPT=`const formData=new FormData();formData.append('two_step_code',prevVal);
jQuery.ajax({url:'/bank/authentication',type:'POST',data:formData,processData:false,contentType:false})
.done(function(response){const message=lodashGet(response,'msg',null);
if(lodashGet(response,'ret',null)!==0){showError(message);return;}
if(message==='ok'){window.location.reload();}});`;

function fixture(t,{scope=true,disabled=false,prepareReady=true,readings=[],protocol={},authentication={},lease=true,
  realReader=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pt-2fa-')),profile=path.join(root,'data/piggo');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data/piggo','data/default','tmp','controller/config','controller/data','controller/src'])
    fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'SYNTHETIC_PROFILE');
  const profileBinding=crypto.createHash('sha256').update(process.platform==='win32'?profile.toLowerCase():profile).digest('hex');
  const policy={reviewed:true,mode:'safe_history_page',url:HOME,selector:'#info_block',actionPath:'/attendance.php',
    dailyHeader:true,nativeIsolatedChrome:true,nativeApiHeaderFallback:true,unsignedText:'签到得魔力',
    unsignedTexts:['签到','签到得魔力'],signedRewardControl:true,proxyServer:'http://127.0.0.1:7890'};
  const config={automationUserDataDir:path.join(root,'data/default'),bookmarksPath:path.join(root,'bookmarks'),
    nativeWafPreflightUrls:[{url:ORIGIN+'/attendance.php',automationUserDataDir:profile,passiveOnly:true}],
    nativeAccessibilityCheckinOrigins:[],ptReadOnlyPolicies:{[ORIGIN]:policy},
    nativePtTwoFactorRecovery:{[ORIGIN]:{reviewed:true,enabled:!disabled,provider:'bitwarden'}}};
  const configFile=path.join(root,'config/config.json');fs.writeFileSync(configFile,JSON.stringify(config));
  const controller=path.join(root,'controller'),nonce=crypto.randomUUID();
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  fs.writeFileSync(path.join(controller,'src/legacy-engine.mjs'),
    `export {validateEngineLease} from ${JSON.stringify(new URL('../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  const oldRoot=process.env.CHECKIN_V2_ENGINE_ROOT,oldLease=process.env.CHECKIN_V2_ENGINE_LEASE;
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;
  if(lease)process.env.CHECKIN_V2_ENGINE_LEASE=nonce;else delete process.env.CHECKIN_V2_ENGINE_LEASE;
  t.after(()=>{
    if(oldRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=oldRoot;
    if(oldLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=oldLease;
  });
  let at=now.getTime(),closed=0,launched=0,readCount=0,prepareCount=0,totpCount=0;
  const calls=[],events=[],snapshots=new Map();
  const gate=options=>runNativePtGate({...options,readPlan:async()=>({targets:scope?[
    {origin:ORIGIN,candidates:[ORIGIN+'/attendance.php'],allowedOrigins:[ORIGIN],folderNames:['PT']}]:[]}),
    verify:()=>null,harvest:()=>null});
  const launch=async options=>{
    events.push('launch');launched++;
    assert.equal(options.automationUserDataDir,profile);assert.equal(options.backgroundWindowMode,'offscreen');
    assert.equal(options.failureScreenshots,false);assert.equal(options.ptPassiveReadOnly,true);
    assert.equal(options.ptReadProxyServer,policy.proxyServer);
    for(const key of ['BW_SESSION','BW_PASSWORD','BW_CLIENTID','BW_CLIENTSECRET'])assert.equal(process.env[key],undefined);
    return {route:async()=>{},close:async()=>{events.push('close');closed++;},
      newPage:async()=>({route:async()=>{},setContent:async(content)=>{
        assert.match(content,/Content-Security-Policy/);assert.doesNotMatch(content,/PRIVATE/);
      },evaluate:async(fn,args)=>{
        if(!realReader)return {controls:[{path:'/userdetails.php',accountId:readings[readCount-1]?.ownId??OWN}]};
        const snapshot=snapshots.get(args.html),previous=globalThis.DOMParser;
        assert.ok(snapshot,'only a verified fetched response reaches the parser');
        globalThis.DOMParser=class{
          parseFromString(){
            const block={textContent:snapshot.headerText,querySelectorAll:()=>snapshot.controls.map(control=>({
              textContent:control.text,tagName:'A',getAttribute:name=>name==='href'?control.href:null,matches:()=>false,
            }))};
            const inputs=snapshot.inputs.map(attributes=>({getAttribute:attribute=>{
              assert.notEqual(attribute,'value','the native parser must never read a TOTP or password value');
              return Object.hasOwn(attributes,attribute)?attributes[attribute]:null;
            }}));
            return {querySelectorAll:selector=>selector===args.selector?Array.from({length:snapshot.headerCount},()=>block):
              selector==='base[href]'?snapshot.bases.map(href=>({getAttribute:()=>href})):
              selector==='input'?inputs:selector==='form[action]'?snapshot.forms.map(action=>({getAttribute:()=>action})):
              selector==='h1,h2,h3,legend'?snapshot.headings.map(textContent=>({textContent})):
              selector==='input[type="password"]'&&snapshot.hasPassword?[{}]:[],body:{textContent:snapshot.bodyText}};
          }
        };
        try{return fn(args);}finally{if(previous===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=previous;}
      },close:async()=>{}}),request:{get:async(url,options)=>{
        if(realReader&&url===HOME){
          events.push('header');const entry=readings[readCount++]??{},token='synthetic-page-'+readCount;
          const controls=entry.controls??[
            {text:'PRIVATE_ACCOUNT',href:'/userdetails.php?id='+(entry.ownId??OWN)},
            {text:'控制面板',href:'/usercp.php?action=security'},
            {text:entry.status==='already_signed'?'[签到已得840, 补签卡: 3]':'签到得魔力',href:'/attendance.php'},
          ];
          snapshots.set(token,{headerCount:entry.headerCount??1,
            headerText:entry.headerText??'欢迎回来 PRIVATE_ACCOUNT 分享率2.3 上传10GB 下载4GB 魔力100 二级验证设置',
            bodyText:entry.bodyText??'PRIVATE_PAGE 2FA设置 管理两步验证',controls,bases:entry.bases??[],
            hasPassword:entry.hasPassword??false,forms:entry.forms??[],headings:entry.headings??[],
            inputs:entry.otp?[{type:entry.otp==='hidden'?'hidden':'text',name:'two_step_code',
              ...(entry.otp==='active'?{autocomplete:'one-time-code'}:{}),value:SECRET}]:[]});
          calls.push({method:'GET',url,options});
          assert.equal(options.maxRedirects,0);assert.equal(options.maxRetries,0);assert.equal(options.ignoreHTTPSErrors,false);
          return {url:()=>entry.responseUrl??url,status:()=>entry.httpStatus??200,
            headers:()=>({date:entry.date??new Date(at).toUTCString()}),text:async()=>token};
        }
        events.push('protocol');calls.push({method:'GET',url,options});
        assert.equal(url,PROTOCOL);assert.equal(options.maxRedirects,0);assert.equal(options.maxRetries,0);
        assert.equal(options.ignoreHTTPSErrors,false);
        if(protocol.error)throw Error(SECRET);
        return {url:()=>protocol.url??url,status:()=>protocol.status??200,text:async()=>protocol.body??PUBLIC_SCRIPT};
      },post:async(url,options)=>{
        events.push('POST');calls.push({method:'POST',url,options});
        const state=JSON.parse(fs.readFileSync(path.join(root,'data/bitwarden/recovery-state.json')));
        assert.equal(state.attempts.at(-1).state,'pending');assert.ok(fs.existsSync(path.join(root,'tmp/run.lock')));
        if(authentication.error)throw Error(SECRET+' '+CODE);
        return {url:()=>authentication.url??url,status:()=>authentication.status??200,
          json:async()=>{if(authentication.jsonError)throw Error(SECRET);return authentication.body??{ret:0,msg:'ok'};}};
      }}};
  };
  const readHeader=async options=>{
    events.push('header');const entry=readings[readCount++]??{};
    const ctx=await options.launch({...config,automationUserDataDir:profile,ptPassiveReadOnly:true,
      ptReadProxyServer:policy.proxyServer,nativePtReadOrigin:ORIGIN,failureScreenshots:false});
    const page=await ctx.newPage();await page.evaluate(()=>null,{url:HOME});await page.close();await ctx.close();
    const status=entry.status??'not_signed',negative=status==='not_signed',observedAt=new Date(entry.observedAt??at).toISOString();
    const receipt={origin:ORIGIN,url:HOME,accountKey:'site-default',profileBinding,
      status,businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(observedAt)),
      observedAt,submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
      evidence:{source:'page_text',authoritative:entry.authoritative??true,confirmedAt:observedAt,
        businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(observedAt)),
        pagePath:'/index.php',statusSignal:negative?'nexus_daily_header_unsigned':'nexus_daily_header_signed',
        evidenceScope:'site_account_day'},inspection:{currentUrl:HOME,sameOrigin:true,pageContentAvailable:true,
        siteBodyLoaded:true,authenticated:true,waf:false,loginRoute:false,securityVerification:false,
        success:!negative,successText:false,signedControlCount:negative?0:1,unsignedControlCount:negative?1:0,
        successControl:negative?'':'签到已得840, 补签卡: 3',unsignedControl:negative?'签到得魔力':'',...entry.inspection},
      ...entry.receiptChange};
    return {...receipt,readbackReceipt:receipt};
  };
  const prepare=async()=>{events.push('prepare');prepareCount++;return {ready:prepareReady,reason:prepareReady?'prepared':'vault_locked'};};
  const withTotp=async options=>{events.push('totp');totpCount++;await options.consume(CODE,{validUntilMs:at+20_000});return SECRET;};
  const nativeDiagnostic={origin:ORIGIN,accountKey:'site-default',profileBinding,failureCode:'two_factor_required',observedAt:now.toISOString(),
    nativeSecurityDiagnostic:{verificationRoute:false,otpInputPresent:true,scopedOtpInputPresent:true,
      passwordInputPresent:false,sameOrigin:true,pageContentAvailable:true,waf:false}};
  const args={root,origin:ORIGIN,nativeDiagnostic,expectedProfileBinding:profileBinding,clock:()=>at,
    gate,launch,prepare,withTotp,readHeader:realReader?readNativePtApiHeader:readHeader};
  return {args,root,profileBinding,nativeDiagnostic,config,configFile,calls,events,gate,
    saveConfig:()=>fs.writeFileSync(configFile,JSON.stringify(config)),setTime:value=>{at=new Date(value).getTime();},
    state:()=>JSON.parse(fs.readFileSync(path.join(root,'data/bitwarden/recovery-state.json'))),
    get launched(){return launched;},get closed(){return closed;},get reads(){return readCount;},
    get prepares(){return prepareCount;},get codes(){return totpCount;}};
}

function safe(value){
  assert.doesNotMatch(JSON.stringify(value),new RegExp(`${CODE}|${SECRET}|${OWN}|accountId|bodyText|headerText|two_step_code|BW_SESSION`));
  assert.deepEqual(Object.keys(value.nativeTwoFactorRecovery).sort(),['accepted','attempted','reason']);
}
const posts=f=>f.calls.filter(call=>call.method==='POST');

test('formal recovery uses one original bound context and one authentication POST, leaving check-in to its parent',async t=>{
  const f=fixture(t),result=await recoverNativePtTwoFactor(f.args);
  assert.deepEqual(result.nativeTwoFactorRecovery,{attempted:true,accepted:true,reason:'authentication_accepted'});
  assert.equal(result.readbackReceipt.status,'not_signed');assert.equal(result.readbackReceipt.submissionAttempted,false);
  assert.equal(f.launched,1);assert.equal(f.closed,1);assert.equal(f.reads,3);assert.equal(f.prepares,1);assert.equal(f.codes,1);
  assert.deepEqual(posts(f).map(value=>value.url),[AUTH]);
  assert.deepEqual(posts(f)[0].options,{multipart:{two_step_code:CODE},headers:{'X-Requested-With':'XMLHttpRequest',
    Origin:ORIGIN,Referer:HOME},maxRedirects:0,maxRetries:0,ignoreHTTPSErrors:false,timeout:15_000});
  assert.deepEqual(f.events,['header','launch','prepare','protocol','header','totp','POST','header','close']);
  assert.equal(f.state().attempts[0].state,'accepted');assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);
  const registered=await f.gate({root:f.root,origin:ORIGIN,url:HOME,profile:path.join(f.root,'data/piggo'),
    mainProfile:false,phase:'readback',clock:()=>now,receipt:result.readbackReceipt});
  assert.equal(registered.receiptAccepted,true);safe(result);safe({nativeTwoFactorRecovery:result.nativeTwoFactorRecovery,state:f.state()});
});

test('default native API parser recovers a real native challenge with hidden HTTP OTP markup and preserves authoritative proof',async t=>{
  const f=fixture(t,{realReader:true,readings:[{otp:'hidden'},{otp:'hidden'},{otp:'hidden'}]});
  const result=await recoverNativePtTwoFactor(f.args);
  assert.deepEqual(result.nativeTwoFactorRecovery,{attempted:true,accepted:true,reason:'authentication_accepted'});
  assert.equal(result.readbackReceipt.status,'not_signed');assert.equal(result.readbackReceipt.evidence.authoritative,true);
  assert.equal(result.readbackReceipt.inspection.authenticated,true);assert.equal(result.readbackReceipt.inspection.securityVerification,false);
  assert.deepEqual(f.calls.map(call=>[call.method,call.url]),[
    ['GET',HOME],['GET',PROTOCOL],['GET',HOME],['POST',AUTH],['GET',HOME],
  ]);
  assert.equal(f.launched,1);assert.equal(f.closed,1);assert.equal(f.codes,1);
  const registration=await f.gate({root:f.root,origin:ORIGIN,url:HOME,profile:path.join(f.root,'data/piggo'),
    mainProfile:false,phase:'readback',clock:()=>now,receipt:result.readbackReceipt});
  assert.equal(registration.receiptAccepted,true);safe(result);
});

test('default parser recognizes a signed reward anchor before vault operations or any authentication',async t=>{
  const f=fixture(t,{realReader:true,readings:[{status:'already_signed',otp:'hidden'}]});
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'already_signed');assert.equal(result.nativeTwoFactorRecovery.attempted,false);
  assert.equal(result.readbackReceipt.status,'already_signed');assert.equal(result.readbackReceipt.evidence.authoritative,true);
  assert.equal(f.codes,0);assert.equal(f.prepares,0);assert.deepEqual(f.calls.map(call=>call.url),[HOME]);safe(result);
});

test('default parser refuses active static OTP, login, WAF, ambiguous account and invalid transport without reading a code',async t=>{
  const controls=[{text:'PRIVATE_ACCOUNT',href:'/userdetails.php?id='+OWN},
    {text:'控制面板',href:'/usercp.php'},{text:'签到得魔力',href:'/attendance.php'}];
  for(const entry of [{otp:'active'},{hasPassword:true},{bodyText:'Just a moment Verify you are human'},
    {bodyText:'请输入二级验证代码进行验证'},{headerCount:0},{headerCount:2},{headerText:'普通账户文字'},
    {controls:[...controls,{text:'PRIVATE_OTHER',href:'/userdetails.php?id=9999'}]},
    {controls:[...controls,{text:'已签到',href:'/attendance.php'}]},
    {controls:controls.filter(control=>control.href!=='/usercp.php')},
    {bases:['https://foreign.example/']},{httpStatus:302},{responseUrl:ORIGIN+'/login.php'},
    {date:'invalid'},{date:new Date(now.getTime()-300_001).toUTCString()},
    {date:new Date(now.getTime()+61_000).toUTCString()}]){
    const f=fixture(t,{realReader:true,readings:[entry]}),result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'passive_proof_unavailable',JSON.stringify(entry));
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(result.readbackReceipt,undefined);
    assert.equal(f.codes,0);assert.equal(f.prepares,0);assert.equal(posts(f).length,0);assert.equal(f.closed,1);safe(result);
  }
});

test('default parser cannot return an after-auth receipt when the actual owned account changes',async t=>{
  const f=fixture(t,{realReader:true,readings:[{otp:'hidden'},{otp:'hidden'},{otp:'hidden',ownId:'4444'}]});
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.attempted,true);assert.equal(result.nativeTwoFactorRecovery.accepted,true);
  assert.equal(result.nativeTwoFactorRecovery.reason,'authentication_accepted_readback_unavailable');
  assert.equal(result.readbackReceipt,undefined);assert.equal(posts(f).length,1);assert.equal(f.state().attempts[0].state,'accepted');safe(result);
});

test('already-signed home proof performs no vault prepare, code read, protocol request or POST',async t=>{
  const f=fixture(t,{readings:[{status:'already_signed'}]}),result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'already_signed');assert.equal(result.nativeTwoFactorRecovery.attempted,false);
  assert.equal(result.readbackReceipt.status,'already_signed');assert.equal(f.codes,0);assert.equal(f.prepares,0);assert.equal(f.calls.length,0);
  assert.equal(f.closed,1);assert.equal(fs.existsSync(path.join(f.root,'data/bitwarden/recovery-state.json')),false);safe(result);
});

test('private opt-in, exact profile and reviewed isolated policy are required',async t=>{
  for(const change of [{enabled:false},{reviewed:false},{provider:'other'}]){
    const f=fixture(t);Object.assign(f.config.nativePtTwoFactorRecovery[ORIGIN],change);f.saveConfig();
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'disabled');assert.equal(f.launched,0);assert.equal(f.codes,0);safe(result);
  }
  for(const mutate of [f=>{f.args.expectedProfileBinding='b'.repeat(64);},f=>{f.args.origin='https://other.example';},
    f=>{f.config.ptReadOnlyPolicies[ORIGIN].nativeIsolatedChrome=false;f.saveConfig();},
    f=>{f.config.ptReadOnlyPolicies[ORIGIN].reviewed=false;f.saveConfig();},
    f=>{f.config.supplementalOAuthAccounts=[{origin:ORIGIN,accountKey:'other'}];f.saveConfig();}]){
    const f=fixture(t);mutate(f);const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'configuration_invalid');assert.equal(f.launched,0);assert.equal(f.codes,0);safe(result);
  }
});

test('only typed current scoped native 2FA facts and exact identity authorize recovery',async t=>{
  const changes=[{origin:'https://other.example'},{accountKey:'another'},{profileBinding:'b'.repeat(64)},
    {observedAt:new Date(now.getTime()-300_001).toISOString()},{observedAt:new Date(now.getTime()+1).toISOString()},
    {observedAt:'invalid'},{observedAt:new Date(now.getTime()-86_400_000).toISOString()},
    {failureCode:'login_required'},...['otpInputPresent','scopedOtpInputPresent','sameOrigin','pageContentAvailable'].flatMap(key=>[
      {nativeSecurityDiagnostic:{[key]:false}},{nativeSecurityDiagnostic:{[key]:'true'}}]),
    {nativeSecurityDiagnostic:{passwordInputPresent:true}},{nativeSecurityDiagnostic:{waf:true}}];
  for(const change of changes){
    const f=fixture(t);f.args.nativeDiagnostic={...f.nativeDiagnostic,...change,
      nativeSecurityDiagnostic:{...f.nativeDiagnostic.nativeSecurityDiagnostic,...change.nativeSecurityDiagnostic}};
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'challenge_invalid');assert.equal(f.launched,0);assert.equal(f.codes,0);safe(result);
  }
});

test('missing or mismatched controller lease refuses every browser and vault operation',async t=>{
  const f=fixture(t,{lease:false}),result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'lease_unavailable');assert.equal(f.launched,0);assert.equal(f.codes,0);safe(result);
});

test('exact current bookmark scope and pause status are checked before any code retrieval',async t=>{
  for(const options of [{scope:false},{}]){
    const f=fixture(t,options);
    if(options.scope!==false){f.config.disabledCheckinOrigins=[ORIGIN];f.saveConfig();}
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'scope_unavailable');assert.equal(f.launched,0);assert.equal(f.codes,0);safe(result);
  }
});

test('active execution run lock fails closed instead of borrowing another task lock',async t=>{
  const f=fixture(t),file=path.join(f.root,'tmp/run.lock');
  const owner={version:1,pid:process.pid,nonce:'another-task',acquiredAt:now.toISOString()};
  fs.writeFileSync(file,JSON.stringify(owner));
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'execution_busy');assert.equal(f.codes,0);assert.equal(f.launched,0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),owner);safe(result);
});

test('vault credentials are absent in browser environment and restored only for caller after cleanup',async t=>{
  const f=fixture(t),keys=['BW_SESSION','BW_PASSWORD','BW_CLIENTID','BW_CLIENTSECRET'],previous=new Map();
  for(const key of keys){previous.set(key,process.env[key]);process.env[key]=SECRET;}
  try{
    const result=await recoverNativePtTwoFactor(f.args);assert.equal(result.nativeTwoFactorRecovery.accepted,true);
    for(const key of keys)assert.equal(process.env[key],SECRET);safe(result);
  }finally{for(const [key,value] of previous)if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('slow vault preparation is followed by a renewed fresh passive proof',async t=>{
  const f=fixture(t),prepare=f.args.prepare;
  f.args.prepare=async args=>{await prepare(args);f.setTime(now.getTime()+90_000);return {ready:true};};
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(posts(f).length,1);assert.equal(f.reads,3);
  assert.equal(f.state().attempts[0].attemptedAt,new Date(now.getTime()+90_000).toISOString());safe(result);
});

test('native challenge that expires during slow preparation cannot read a code',async t=>{
  const f=fixture(t),prepare=f.args.prepare;
  f.args.prepare=async args=>{await prepare(args);f.setTime(now.getTime()+300_001);return {ready:true};};
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'challenge_invalid');assert.equal(f.codes,0);assert.equal(posts(f).length,0);safe(result);
});

test('unavailable, ambiguous, stale or wrong-day passive proof stops before vault preparation',async t=>{
  for(const entry of [{status:'unconfirmed'},{ownId:'invalid'},{authoritative:false},
    {observedAt:now.getTime()-30_001},{observedAt:now.getTime()+1},{observedAt:now.getTime()-86_400_000},
    {receiptChange:{profileBinding:'b'.repeat(64)}},{receiptChange:{accountKey:'other'}},
    {inspection:{securityVerification:true}},{inspection:{authenticated:false}},{inspection:{waf:true}}]){
    const f=fixture(t,{readings:[entry]}),result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'passive_proof_unavailable');assert.equal(f.prepares,0);assert.equal(f.codes,0);
    assert.equal(posts(f).length,0);assert.equal(f.closed,1);safe(result);
  }
});

test('account change between preparation and renewed proof never reads or submits a code',async t=>{
  const f=fixture(t,{readings:[{}, {ownId:'4444'}]}),result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'account_changed');assert.equal(f.codes,0);assert.equal(posts(f).length,0);safe(result);
});

test('site becomes signed while preparing: return real signed proof with no code read',async t=>{
  const f=fixture(t,{readings:[{}, {status:'already_signed'}]}),result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'already_signed');assert.equal(result.readbackReceipt.status,'already_signed');
  assert.equal(f.codes,0);assert.equal(posts(f).length,0);safe(result);
});

test('unavailable vault or changed public protocol cannot issue a code request or create attempt state',async t=>{
  for(const options of [{prepareReady:false},{protocol:{status:302}},{protocol:{url:PROTOCOL+'?token=PRIVATE'}},
    {protocol:{body:PUBLIC_SCRIPT.replace('two_step_code','password')}},
    {protocol:{body:PUBLIC_SCRIPT.replace('/bank/authentication','/login')}},
    {protocol:{body:PUBLIC_SCRIPT.replace("'ret'","'code'")}},
    {protocol:{body:'/* '+PUBLIC_SCRIPT+' */'}},{protocol:{body:PUBLIC_SCRIPT+'\n/* unfinished'}},
    {protocol:{body:PUBLIC_SCRIPT+'\njQuery.ajax({url:"/another",type:"POST"});'}}]){
    const f=fixture(t,options),result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(f.codes,0);assert.equal(posts(f).length,0);
    assert.equal(fs.existsSync(path.join(f.root,'data/bitwarden/recovery-state.json')),false);safe(result);
  }
});

test('bounded provider failure reasons distinguish vault/session preparation from site authentication',async t=>{
  for(const reason of ['vault_locked','vault_unauthenticated','session_missing','session_invalid','session_unavailable',
    'server_mismatch','vault_sync_failed','provider_busy','totp_near_rotation','helper_output_invalid']){
    const f=fixture(t);f.args.prepare=async()=>({ready:false,reason,detail:SECRET});
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,reason==='provider_busy'?reason:'provider_'+reason);
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(f.codes,0);assert.equal(posts(f).length,0);
    assert.equal(fs.existsSync(path.join(f.root,'data/bitwarden/recovery-state.json')),false);safe(result);
  }
});

test('unconsumed code-provider failures preserve bounded causes without creating an authentication attempt',async t=>{
  for(const reason of ['session_invalid','vault_locked','totp_read_failed','totp_near_rotation','provider_busy']){
    const f=fixture(t);f.args.withTotp=async()=>({ready:false,reason,code:CODE,detail:SECRET});
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,reason==='provider_busy'?reason:'provider_'+reason);
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(posts(f).length,0);safe(result);
  }
});

test('arbitrary provider reasons, return values and error messages cannot escape either boundary',async t=>{
  for(const phase of ['prepare','withTotp'])for(const value of [{ready:false,reason:SECRET+' '+CODE},
    {ready:false,reason:'prepared',body:SECRET},{ready:'false',reason:'vault_locked'},SECRET]){
    const f=fixture(t);f.args[phase]=async()=>value;
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,'totp_unavailable');
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(posts(f).length,0);safe(result);
  }
});

test('provider failure after a real accepted or unknown POST cannot overwrite actual authentication facts',async t=>{
  for(const authentication of [{},{error:true}]){
    const f=fixture(t,{authentication});
    f.args.withTotp=async({consume})=>{
      await consume(CODE,{validUntilMs:now.getTime()+20_000});return {ready:false,reason:'vault_locked',detail:SECRET};
    };
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.attempted,true);
    assert.equal(result.nativeTwoFactorRecovery.reason,authentication.error?'authentication_unknown':'authentication_accepted');
    assert.equal(result.nativeTwoFactorRecovery.accepted,!authentication.error);assert.equal(posts(f).length,1);safe(result);
  }
});

test('configured pause during preparation prevents code retrieval and authentication',async t=>{
  const f=fixture(t),prepare=f.args.prepare;
  f.args.prepare=async args=>{await prepare(args);f.config.disabledCheckinOrigins=[ORIGIN];f.saveConfig();return {ready:true};};
  const result=await recoverNativePtTwoFactor(f.args);
  assert.equal(result.nativeTwoFactorRecovery.reason,'scope_unavailable');assert.equal(f.codes,0);assert.equal(posts(f).length,0);safe(result);
});

test('expired proof, near-rotation code and malformed code cannot dispatch a POST',async t=>{
  for(const mode of ['expired','near_rotation','invalid','midnight']){
    const f=fixture(t);
    f.args.withTotp=async({consume})=>{
      if(mode==='expired')f.setTime(now.getTime()+30_001);
      if(mode==='midnight')f.setTime('2026-10-13T16:00:01Z');
      return consume(mode==='invalid'?SECRET:CODE,{validUntilMs:new Date(f.args.clock()).getTime()+(mode==='near_rotation'?2999:20_000)});
    };
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.attempted,false);assert.equal(posts(f).length,0);safe(result);
  }
});

test('provider callbacks are single-use, awaited even if detached, and invalid after provider returns',async t=>{
  let late;
  const f=fixture(t);
  f.args.withTotp=({consume})=>{late=consume;void consume(CODE,{validUntilMs:now.getTime()+20_000});
    void consume(CODE,{validUntilMs:now.getTime()+20_000});return SECRET;};
  const result=await recoverNativePtTwoFactor(f.args);
  await late(CODE,{validUntilMs:now.getTime()+20_000});
  assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(posts(f).length,1);safe(result);
});

test('late-only provider callback never submits after recovery completed',async t=>{
  let late;const f=fixture(t);f.args.withTotp=async({consume})=>{late=consume;return CODE;};
  const result=await recoverNativePtTwoFactor(f.args);await late(CODE,{validUntilMs:now.getTime()+20_000});
  assert.equal(result.nativeTwoFactorRecovery.reason,'totp_unavailable');assert.equal(posts(f).length,0);safe(result);
});

test('rejected, redirected, malformed and unknown authentication stops without retry or signed status',async t=>{
  for(const authentication of [{body:{ret:1,msg:SECRET}},{body:{ret:'0',msg:'ok'}},{body:{code:0,data:'ok'}},
    {status:302},{status:500},{url:ORIGIN+'/login.php'},{jsonError:true},{error:true}]){
    const f=fixture(t,{authentication}),result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.attempted,true);assert.equal(result.nativeTwoFactorRecovery.accepted,false);
    assert.equal(result.readbackReceipt,undefined);assert.equal(posts(f).length,1);assert.equal(f.reads,2);
    const second=await recoverNativePtTwoFactor(f.args);
    assert.equal(second.nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(posts(f).length,1);
    assert.equal(f.state().attempts.length,1);safe(result);safe(second);safe({nativeTwoFactorRecovery:result.nativeTwoFactorRecovery,state:f.state()});
  }
});

test('accepted authentication alone never becomes check-in success; post-auth account proof is mandatory',async t=>{
  for(const after of [{ownId:'9999'},{inspection:{securityVerification:true}},{authoritative:false},{status:'unconfirmed'}]){
    const f=fixture(t,{readings:[{}, {}, after]}),result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.accepted,true);assert.equal(result.nativeTwoFactorRecovery.attempted,true);
    assert.equal(result.nativeTwoFactorRecovery.reason,'authentication_accepted_readback_unavailable');
    assert.equal(result.readbackReceipt,undefined);assert.equal(f.state().attempts[0].state,'accepted');safe(result);
  }
});

test('durable same-day guard survives module/process restarts, while next business day can recover normally',async t=>{
  const f=fixture(t);await recoverNativePtTwoFactor(f.args);
  const restarted=await import('../src/native-pt-two-factor.mjs?restart='+crypto.randomUUID());
  const second=await restarted.recoverNativePtTwoFactor(f.args);
  assert.equal(second.nativeTwoFactorRecovery.reason,'daily_recovery_limit');assert.equal(posts(f).length,1);
  f.setTime(now.getTime()+86_400_000);
  f.args.nativeDiagnostic={...f.nativeDiagnostic,observedAt:new Date(now.getTime()+86_400_000).toISOString()};
  const tomorrow=await restarted.recoverNativePtTwoFactor(f.args);
  assert.equal(tomorrow.nativeTwoFactorRecovery.accepted,true);assert.equal(posts(f).length,2);assert.equal(f.state().attempts.length,2);safe(tomorrow);
});

test('crashed pending state and malformed state fail closed before reading a code',async t=>{
  for(const state of [{schemaVersion:1,attempts:[{origin:ORIGIN,accountKey:'site-default',businessDate:'2026-10-13',
    profileBinding:'placeholder',state:'pending',attemptedAt:now.toISOString()}]}, {schemaVersion:9,attempts:[]}]){
    const f=fixture(t);if(state.schemaVersion===1)state.attempts[0].profileBinding=f.profileBinding;
    fs.mkdirSync(path.join(f.root,'data/bitwarden'),{recursive:true});
    fs.writeFileSync(path.join(f.root,'data/bitwarden/recovery-state.json'),JSON.stringify(state));
    const result=await recoverNativePtTwoFactor(f.args);
    assert.equal(result.nativeTwoFactorRecovery.reason,state.schemaVersion===1?'daily_recovery_limit':'recovery_state_invalid');
    assert.equal(f.codes,0);assert.equal(posts(f).length,0);safe(result);
  }
});

test('CLI rejects extra fields, oversized input and malformed JSON with bounded ASCII output',()=>{
  const script=fileURLToPath(new URL('../scripts/Recover-NativePtTwoFactor.mjs',import.meta.url));
  for(const input of ['not JSON',JSON.stringify({origin:ORIGIN,password:SECRET}), ' '.repeat(16_385)]){
    const child=spawnSync(process.execPath,[script],{input,encoding:'utf8',windowsHide:true,timeout:10_000});
    assert.equal(child.status,2);assert.equal(child.stderr,'');
    const value=JSON.parse(child.stdout.trim());assert.equal(value.nativeTwoFactorRecovery.reason,'configuration_invalid');
    assert.match(child.stdout,/^[\x00-\x7f]+$/);safe(value);
  }
});
