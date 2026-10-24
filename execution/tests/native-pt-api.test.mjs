import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readNativePtApiHeader,readNativePtApiHeaderInContext,piggoNativePassiveContext,runNativePtApiCheckin} from '../src/native-pt-api.mjs';
import {runNativePtGate} from '../src/native-pt-gate.mjs';

const origin='https://piggo.me',url=origin+'/attendance.php',now=new Date('2026-10-11T04:00:00Z');
const ownId='73182940';
function header({signed=false,controls,headerText,bodyText,headerCount=1,baseHrefs=[],hasPassword=false,inputs=[],forms=[],headings=[]}={}){
  return {headerCount,baseHrefs,hasPassword,inputs,forms,headings,headerText:headerText??'欢迎回来 PRIVATE_ACCOUNT 分享率 2.3 上传 10 GB 下载 4 GB 魔力 100',
    bodyText:bodyText??'已登录的私人页面 PRIVATE_BODY',controls:controls??[
      {text:'PRIVATE_ACCOUNT',href:'/userdetails.php?id='+ownId},
      {text:'控制面板',href:'/usercp.php?action=security'},
      {text:signed?'已签到':'签到得魔力',href:'/attendance.php'},
    ]};
}
function fixture(t,{configChange={},scope=true,network=[{}],lease=true,gateChange}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pt-api-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'data/private-pg'),defaultProfile=path.join(root,'data/default');
  for(const dir of ['config','logs','tmp','data/private-pg','data/default'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'private fixture profile');
  const policy={reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',dailyHeader:true,
    nativeIsolatedChrome:true,nativeApiHeaderFallback:true,nativeApiExecution:true,proxyServer:'http://127.0.0.1:7890',
    actionPath:'/attendance.php',unsignedText:'签到得魔力',unsignedTexts:['签到','签到得魔力'],signedRewardControl:true};
  const config={automationUserDataDir:defaultProfile,bookmarksPath:path.join(root,'bookmarks/Bookmarks'),
    nativeWafPreflightUrls:[{url,automationUserDataDir:profile,passiveOnly:true}],nativeAccessibilityCheckinOrigins:[],
    ptReadOnlyPolicies:{[origin]:policy},...configChange};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  if(lease){
    const controller=path.join(root,'controller'),nonce=crypto.randomUUID();
    for(const dir of ['config','data'])fs.mkdirSync(path.join(controller,dir),{recursive:true});
    fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
    fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
    fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
    const oldRoot=process.env.CHECKIN_V2_ENGINE_ROOT,oldLease=process.env.CHECKIN_V2_ENGINE_LEASE;
    process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
    t.after(()=>{
      if(oldRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=oldRoot;
      if(oldLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=oldLease;
    });
  }
  const calls=[],events=[],snapshots=new Map();let launchCount=0,contextClosed=0,parserClosed=0;
  const gate=async options=>{
    events.push('gate:'+options.phase);
    if(gateChange){const changed=await gateChange(options);if(changed!==undefined)return changed;}
    return runNativePtGate({...options,
      readPlan:async()=>({targets:scope?[{origin,allowedOrigins:[origin],folderNames:['PT'],candidates:[url]}]:[]}),
      harvest:()=>null,verify:()=>null});
  };
  const launch=async cfg=>{
    launchCount++;events.push('launch');
    assert.equal(cfg.automationUserDataDir,profile);assert.equal(cfg.ptPassiveReadOnly,true);
    assert.equal(cfg.ptReadProxyServer,policy.proxyServer);assert.equal(cfg.failureScreenshots,false);
    const context={route:async(pattern,handler)=>{
      assert.equal(pattern,'**/*');let aborted=false;
      await handler({abort:async code=>{assert.equal(code,'blockedbyclient');aborted=true;}});
      assert.equal(aborted,true);
    },request:{get:async(requested,options)=>{
      const index=calls.length,record=network[index]??{};
      calls.push({url:requested,options});events.push('GET:'+new URL(requested).pathname);
      if(record.error)throw Error('PRIVATE transport failure');
      assert.equal(options.maxRedirects,0);assert.equal(options.maxRetries,0);assert.equal(options.ignoreHTTPSErrors,false);
      const token='html-'+index;snapshots.set(token,record.snapshot??header());
      return {status:()=>record.status??200,url:()=>record.responseUrl??requested,
        headers:()=>({date:record.date===undefined?now.toUTCString():record.date,...(record.location?{location:record.location}:{})}),text:async()=>token};
    }},newPage:async()=>({route:context.route,setContent:async(content,options)=>{
      assert.match(content,/Content-Security-Policy/);assert.match(content,/script-src &#39;none&#39;/);
      assert.doesNotMatch(content,/PRIVATE/);assert.equal(options.waitUntil,'domcontentloaded');
    },evaluate:async(fn,args)=>{
      const snapshot=snapshots.get(args.html),oldParser=globalThis.DOMParser;
      globalThis.DOMParser=class{
        parseFromString(){
          const block={textContent:snapshot.headerText,querySelectorAll:()=>snapshot.controls.map(control=>({
            textContent:control.text,getAttribute:()=>control.href??null,matches:()=>control.button===true,
          }))};
          const inputControls=snapshot.inputs.map(attributes=>({getAttribute:attribute=>{
            if(attribute==='value')throw Error('Input values must not be read');
            return Object.hasOwn(attributes,attribute)?attributes[attribute]:null;
          }}));
          return {querySelectorAll:selector=>selector===args.selector?Array.from({length:snapshot.headerCount},()=>block):
            selector==='base[href]'?snapshot.baseHrefs.map(href=>({getAttribute:()=>href})):
            selector==='input'?inputControls:selector==='form[action]'?snapshot.forms.map(action=>({getAttribute:()=>action})):
            selector==='h1,h2,h3,legend'?snapshot.headings.map(textContent=>({textContent})):
            selector==='input[type="password"]'&&(snapshot.hasPassword||snapshot.inputs.some(input=>input.type==='password'))?[{}]:[],
            body:{textContent:snapshot.bodyText}};
        }
      };
      try{return fn(args);}finally{if(oldParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=oldParser;}
    },close:async()=>{parserClosed++;}}),close:async()=>{contextClosed++;}};
    return context;
  };
  const validateLease=async()=>{events.push('lease');if(!lease)throw Error('lease unavailable');};
  return {root,origin,url,profile,config,policy,gate,launch,validateLease,clock:()=>now,calls,events,
    get launchCount(){return launchCount;},get contextClosed(){return contextClosed;},get parserClosed(){return parserClosed;}};
}
const journal=f=>path.join(f.root,'data/native-pt-attempts.json');
function assertNoPrivate(result){assert.doesNotMatch(JSON.stringify(result),new RegExp('PRIVATE|'+ownId+'|bodyText|headerText|accountId'));}

test('private opt-in, isolated binding and current bookmark scope are required before any API request',async t=>{
  for(const configChange of [{ptReadOnlyPolicies:{}},{ptReadOnlyPolicies:{[origin]:{reviewed:true,nativeApiHeaderFallback:false}}},
    {supplementalOAuthAccounts:[{origin,accountKey:'other'}]}]){
    const f=fixture(t,{configChange}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(f.launchCount,0);
    assert.equal(result.inspection.authenticated,false);assertNoPrivate(result);
  }
  const f=fixture(t,{scope:false}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'unconfirmed');assert.equal(f.launchCount,0);assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(journal(f)),false);
  const main=fixture(t);main.config.ptReadOnlyPolicies[origin].nativeIsolatedChrome=false;main.config.ptReadOnlyPolicies[origin].nativeMainChrome=true;
  fs.writeFileSync(path.join(main.root,'config/config.json'),JSON.stringify(main.config));
  assert.equal((await readNativePtApiHeader(main)).status,'unconfirmed');assert.equal(main.launchCount,0);
});

test('native-login account verification reuses its proved context and rejects an unproved or changing Profile',async t=>{
  for(const variant of ['valid','unproved','changed']){
    const f=fixture(t),context=await f.launch({...f.config,automationUserDataDir:f.profile,ptPassiveReadOnly:true,
      ptReadProxyServer:f.policy.proxyServer,failureScreenshots:false});
    let checks=0;const profileProof=async()=>{checks++;return variant==='valid'||variant==='changed'&&checks===1;};
    const key=process.platform==='win32'?f.profile.toLowerCase():f.profile;
    const result=await readNativePtApiHeaderInContext({...f,context,profileProof,
      expectedProfileBinding:crypto.createHash('sha256').update(key).digest('hex')});
    assert.equal(result.status,variant==='valid'?'not_signed':'unconfirmed');assert.equal(f.launchCount,1);
    assert.equal(f.contextClosed,0);assert.equal(f.calls.length,variant==='unproved'?0:1);assertNoPrivate(result);
    await context.close();assert.equal(f.contextClosed,1);
  }
});

test('native PigGo passive proof uses Chrome fetch credentials and route, never the separate API client or an action URL',async()=>{
  let requests=0;
  const page={url:()=>origin+'/login.php',context:()=>({newPage:async()=>({})}),evaluate:async(fn,target)=>{
    const previous=globalThis.fetch;
    globalThis.fetch=async(url,options)=>{requests++;assert.equal(url,origin+'/index.php');
      assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');assert.equal(options.redirect,'manual');assert.equal(options.cache,'no-store');
      return {url,status:200,headers:{get:()=>now.toUTCString()},text:async()=>'<div>synthetic account header</div>'};};
    try{return await fn(target);}finally{globalThis.fetch=previous;}
  }};
  const context=piggoNativePassiveContext(page),response=await context.request.get(origin+'/index.php');
  assert.equal(response.status(),200);assert.equal(response.headers().date,now.toUTCString());assert.equal(requests,1);
  for(const url of [origin+'/attendance.php','https://foreign.example/index.php',origin+'/index.php?claim=1'])
    await assert.rejects(()=>context.request.get(url));
  assert.equal(requests,1);
});

test('API index returns only bound safe negative proof from the reviewed authenticated private header',async t=>{
  const f=fixture(t),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence.authoritative,true);
  assert.equal(result.evidence.source,'page_text');assert.equal(result.evidence.statusSignal,'nexus_daily_header_unsigned');
  assert.equal(result.operationMode,'safe_history_page');assert.equal(result.readSafety,'reviewed_passive');
  const key=process.platform==='win32'?f.profile.toLowerCase():f.profile;
  assert.equal(result.profileBinding,crypto.createHash('sha256').update(key).digest('hex'));assert.equal(result.accountKey,'site-default');
  assert.equal(result.readbackReceipt.inspection.unsignedControl,'签到得魔力');assert.equal(result.inspection.authenticated,true);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php']);assert.equal(fs.existsSync(journal(f)),false);
  assert.equal(f.contextClosed,1);assert.equal(f.parserClosed,1);assertNoPrivate(result);
});

test('2FA settings links and menu text retain the authenticated native API unsigned proof',async t=>{
  const base=header(),snapshot=header({headerText:base.headerText+' 2FA设置 二级验证设置',
    bodyText:'本站菜单：2FA 设置，管理两步验证',controls:[...base.controls,{text:'2FA设置',href:'/usercp.php'}]});
  const f=fixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);
  assert.equal(result.inspection.authenticated,true);assert.equal(result.inspection.securityVerification,false);
  assert.equal(result.inspection.unsignedControl,'签到得魔力');assert.equal(f.calls.length,1);assertNoPrivate(result);
});

test('actual OTP input, verification form or explicit code prompt blocks proof without reading input values',async t=>{
  const cases=[header({bodyText:'请输入二级验证代码进行验证'}),header({bodyText:'请输入验证码'}),
    header({headings:['异地登录安全验证']}),
    header({inputs:[{type:'text',name:'code',autocomplete:'one-time-code',value:'DO_NOT_READ_VALUE'}]}),
    header({forms:['/take2fa.php'],inputs:[{type:'text',name:'code',placeholder:'验证码',value:'DO_NOT_READ_VALUE'}]})];
  for(const [index,snapshot] of cases.entries()){
    const f=fixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.evidence,undefined);
    assert.equal(result.inspection.securityVerification,true,'case '+index);assert.equal(result.inspection.authenticated,false);
    assert.equal(result.submissionAttempted,false);assert.equal(f.calls.length,1);assertNoPrivate(result);
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_READ_VALUE/);
  }
  const f=fixture(t,{network:[{snapshot:header({bodyText:'2FA设置',inputs:[{type:'password',value:'DO_NOT_READ_VALUE'}]})}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'unconfirmed');assert.equal(result.inspection.loginRoute,true);assert.equal(result.evidence,undefined);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_READ_VALUE/);
});

test('missing account header, duplicate identities or daily controls, login and WAF cannot authorize recovery',async t=>{
  const base=header();
  const cases=[header({headerCount:0}),header({headerCount:2}),header({headerText:'普通账户文字'}),
    header({controls:base.controls.filter(control=>!control.href.startsWith('/usercp.php'))}),
    header({controls:[...base.controls,{text:'other',href:'/userdetails.php?id=999'}]}),
    header({controls:[...base.controls,base.controls[2]]}),
    header({controls:[...base.controls,{text:'已签到',href:'/attendance.php'}]}),
    header({controls:base.controls.map(control=>control.href==='/attendance.php'?{...control,text:'历史签到得魔力'}:control)}),
    header({controls:base.controls.map(control=>control.href.startsWith('/userdetails')?{...control,href:'https://foreign.example/userdetails.php?id='+ownId}:control)}),
    header({bodyText:'请输入用户名和密码 登录 Login'}),header({hasPassword:true}),header({bodyText:'Just a moment Verify you are human'}),
    header({bodyText:'异地登录安全验证 二级验证代码'})];
  for(const [index,snapshot] of cases.entries()){
    const f=fixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.ok(result.inspection);assert.equal(f.calls.length,1);assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
  }
});

test('one account may have avatar and username links, while original foreign base URLs cannot fake same-origin ownership',async t=>{
  const base=header();
  for(const snapshot of [header({controls:[...base.controls,base.controls[0]]}),
    header({baseHrefs:[origin+'/'],controls:base.controls.map(control=>({...control,href:control.href.slice(1)}))})]){
    const f=fixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);assertNoPrivate(result);
  }
  const credentialBase=new URL(origin+'/');credentialBase.username='user';
  for(const baseHrefs of [['https://foreign.example/'],['http://piggo.me/'],[origin+'/',origin+'/'],[credentialBase.href]]){
    const f=fixture(t,{network:[{snapshot:header({baseHrefs})}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.inspection.authenticated,false);
    assert.equal(f.calls.length,1);assertNoPrivate(result);
  }
});

test('HTTP status, exact response URL, fresh Shanghai Date and strict TLS are mandatory',async t=>{
  for(const record of [{status:302},{status:500},{responseUrl:origin+'/login.php'},
    {responseUrl:'https://www.piggo.me/index.php'},{date:'invalid'},{date:''},
    {date:new Date(now.getTime()-300001).toUTCString()},{date:new Date(now.getTime()+61000).toUTCString()},
    {date:'Sat, 10 Oct 2026 04:00:00 GMT'},{error:true}]){
    const f=fixture(t,{network:[record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.equal(f.calls.length,1);assert.equal(f.parserClosed,0);assert.equal(f.contextClosed,1);assertNoPrivate(result);
  }
});

test('a fresh same-origin login redirect reports expired authentication without following it or starting an attendance intent',async t=>{
  for(const location of ['/login.php',origin+'/login.php?returnto=%2Findex.php']){
    const f=fixture(t,{network:[{status:302,location}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'login_required');assert.equal(result.failureCode,'login_required');
    assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.equal(result.inspection.loginRoute,true);assert.equal(result.inspection.authenticated,false);
    assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php']);
    assert.equal(f.parserClosed,0);assert.equal(f.contextClosed,1);assert.equal(fs.existsSync(journal(f)),false);
    assertNoPrivate(result);
  }
  const credentialRedirect=new URL(origin+'/login.php');credentialRedirect.username='user';
  for(const location of ['https://foreign.example/login.php','http://piggo.me/login.php',
    credentialRedirect.href,'/attendance.php','/login.php#fragment']){
    const f=fixture(t,{network:[{status:302,location}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(f.calls.length,1);
    assert.equal(result.submissionAttempted,false);assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
  }
  const f=fixture(t,{network:[{status:302,location:'/login.php',date:new Date(now.getTime()-300001).toUTCString()}]});
  assert.equal((await readNativePtApiHeader(f)).status,'unconfirmed');
});

test('a login redirect after attendance keeps the original submission unknown and never retries',async t=>{
  const f=fixture(t,{network:[{}, {status:302,location:'/login.php'}]}),result=await runNativePtApiCheckin(f);
  assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.submissionAttempted,true);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',url]);
  assert.equal(JSON.parse(fs.readFileSync(journal(f))).attempts[0].state,'submitted');assertNoPrivate(result);
});

test('already-signed API index returns immediately with no attendance GET or journal change',async t=>{
  const f=fixture(t,{network:[{snapshot:header({signed:true})}]}),result=await runNativePtApiCheckin(f);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence.authoritative,true);
  assert.equal(result.operationMode,'safe_history_page');assert.equal(result.readSafety,'reviewed_passive');
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php']);assert.deepEqual(f.events.filter(event=>event.startsWith('gate:')),['gate:bind']);
  assert.equal(fs.existsSync(journal(f)),false);assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);assertNoPrivate(result);
});

test('reviewed PigGo reward anchor survives API read and native readback registration without another attendance request',async t=>{
  const base=header(),reward={text:'[签到已得840, 补签卡: 3]',href:'attendance.php'};
  const snapshot=header({controls:[...base.controls.slice(0,2),reward]});
  const f=fixture(t,{network:[{snapshot}]});
  const started=await f.gate({root:f.root,origin,url,profile:f.profile,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation',clock:f.clock});
  const result=await readNativePtApiHeader(f);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence.authoritative,true);
  assert.equal(result.evidence.statusSignal,'nexus_daily_header_signed');assert.equal(result.profileBinding,started.profileBinding);
  assert.equal(result.readbackReceipt.inspection.signedControlCount,1);assert.equal(result.readbackReceipt.inspection.unsignedControlCount,0);
  assert.equal(result.readbackReceipt.inspection.successControl,'签到已得840, 补签卡: 3');
  assert.equal((await f.gate({root:f.root,origin,url,profile:f.profile,phase:'readback',receipt:result.readbackReceipt,clock:f.clock})).receiptAccepted,true);
  const noReplay=await f.gate({root:f.root,origin,url,profile:f.profile,phase:'begin',attemptId:crypto.randomUUID(),action:'navigation',clock:f.clock});
  assert.equal(noReplay.allow,false);assert.equal(noReplay.decision.status,'already_signed');assert.equal(noReplay.decision.submissionAttempted,false);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php']);
  const saved=JSON.parse(fs.readFileSync(journal(f)));
  assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'confirmed');assert.equal(saved.readbacks.length,1);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|73182940|签到已得840|bodyText|headerText|accountId/);assertNoPrivate(result);
});

test('PigGo reward proof still requires the opt-in, unique daily control and authenticated current header',async t=>{
  const base=header(),reward={text:'[签到已得840, 补签卡: 3]',href:'attendance.php'},identity=base.controls.slice(0,2);
  const signed=header({controls:[...identity,reward]});
  for(const flag of [false,undefined,'true']){
    const f=fixture(t,{network:[{snapshot:signed}]});
    f.config.ptReadOnlyPolicies[origin].signedRewardControl=flag;fs.writeFileSync(path.join(f.root,'config/config.json'),JSON.stringify(f.config));
    const result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.submissionAttempted,false);
    assert.equal(f.calls.length,1);assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
  }
  const invalid=[header({controls:[...identity,reward,reward]}),header({controls:[...identity,reward,base.controls[2]]}),
    header({controls:[...identity,{...reward,text:'历史签到已得840, 补签卡: 3'}]}),
    header({controls:identity,headerText:base.headerText+' [签到已得840, 补签卡: 3]'}),
    header({controls:[...identity,reward,{text:'other',href:'/userdetails.php?id=999'}]}),
    header({controls:[identity[0],reward]}),header({controls:[...identity,reward],bodyText:'请输入二级验证代码进行验证'}),
    header({controls:[...identity,reward],bodyText:'Just a moment Verify you are human'})];
  for(const snapshot of invalid){
    const f=fixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.submissionAttempted,false);
    assert.equal(f.calls.length,1);assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
  }
  const f=fixture(t,{network:[{snapshot:signed,date:'Sat, 10 Oct 2026 04:00:00 GMT'}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.submissionAttempted,false);
  assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
});

test('formal API execution performs one registered GET only after durable bound intent and retains old unknown history',async t=>{
  const after=header({bodyText:'签到成功，本次签到获得了 10 魔力'}),f=fixture(t,{network:[{}, {snapshot:after}]});
  const key=process.platform==='win32'?f.profile.toLowerCase():f.profile;
  const binding=crypto.createHash('sha256').update(key).digest('hex');
  const old={attemptId:crypto.randomUUID(),origin,accountKey:'site-default',profileBinding:binding,
    businessDate:'2026-10-08',startedAt:'2026-10-08T00:06:00Z',state:'submitted',actions:['navigation']};
  fs.writeFileSync(journal(f),JSON.stringify({schemaVersion:1,attempts:[old]}));
  const originalLaunch=f.launch;
  f.launch=async config=>{
    const context=await originalLaunch(config),get=context.request.get;
    context.request.get=async(requested,options)=>{
      if(requested===url){const saved=JSON.parse(fs.readFileSync(journal(f)));assert.equal(saved.attempts.length,2);
        assert.equal(saved.attempts[1].state,'submitted');assert.deepEqual(saved.attempts[1].actions,['navigation']);}
      return get(requested,options);
    };
    return context;
  };
  const result=await runNativePtApiCheckin(f);
  assert.equal(result.status,'signed');assert.equal(result.nativeGate,true);assert.equal(result.submissionAttempted,true);
  assert.equal(result.evidence.statusSignal,'submitted_success_response');assert.equal(result.evidence.pagePath,'/attendance.php');
  assert.equal(result.operationMode,'legacy_checkin');assert.equal(result.readSafety,'attendance_page_risk');assert.equal(result.attendanceRisk,true);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',url]);
  const saved=JSON.parse(fs.readFileSync(journal(f)));assert.equal(saved.attempts.length,2);assert.deepEqual(saved.attempts[0],old);
  assert.equal(saved.attempts[1].state,'confirmed');assert.equal(saved.readbacks.length,1);assertNoPrivate(result);
  assert.doesNotMatch(JSON.stringify(saved),/PRIVATE|73182940|bodyText|headerText|accountId/);
  assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);
  const second=await runNativePtApiCheckin(f);
  assert.equal(second.status,'already_signed');assert.equal(second.submissionAttempted,false);
  assert.equal(f.calls.filter(call=>call.url===url).length,1);
});

test('formal opt-in, controller lease, current scope and inspected gate must allow the write',async t=>{
  const noOptin=fixture(t);noOptin.config.ptReadOnlyPolicies[origin].nativeApiExecution=false;
  fs.writeFileSync(path.join(noOptin.root,'config/config.json'),JSON.stringify(noOptin.config));
  assert.equal((await runNativePtApiCheckin(noOptin)).submissionAttempted,false);assert.equal(noOptin.launchCount,0);
  const noLease=fixture(t,{lease:false});
  assert.equal((await runNativePtApiCheckin(noLease)).submissionAttempted,false);assert.equal(noLease.launchCount,0);
  const defaultLease=fixture(t,{lease:false});delete defaultLease.validateLease;
  assert.equal((await runNativePtApiCheckin(defaultLease)).submissionAttempted,false);assert.equal(defaultLease.launchCount,0);
  const denied=fixture(t,{scope:false});assert.equal((await runNativePtApiCheckin(denied)).submissionAttempted,false);assert.equal(denied.launchCount,0);
  const gateClosed=fixture(t,{gateChange:async options=>options.phase==='inspect'?{allow:false,decision:{status:'deferred',retryCause:'harvest_waiting',submissionAttempted:false}}:undefined});
  const result=await runNativePtApiCheckin(gateClosed);
  assert.equal(result.status,'deferred');assert.equal(result.submissionAttempted,false);assert.equal(gateClosed.calls.length,1);
  assert.equal(JSON.parse(fs.readFileSync(journal(gateClosed))).attempts.length,0);
  const unregistered=fixture(t);unregistered.url=origin+'/attendance.php?submit=1';
  assert.equal((await runNativePtApiCheckin(unregistered)).submissionAttempted,false);assert.equal(unregistered.launchCount,0);
});

test('an unknown, unauthenticated or ambiguous pre-read never sends attendance',async t=>{
  for(const snapshot of [header({headerCount:0}),header({controls:[]}),header({controls:[...header().controls,header().controls[2]]})]){
    const f=fixture(t,{network:[{snapshot}]}),result=await runNativePtApiCheckin(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(f.calls.length,1);
    assert.equal(fs.existsSync(journal(f)),false);assertNoPrivate(result);
  }
});

test('post-GET redirect, stale date, changed account, authentication loss or historical text leave one unreplayed intent',async t=>{
  const changedControls=header().controls.map(control=>control.href.startsWith('/userdetails')?{...control,href:'/userdetails.php?id=999'}:control);
  for(const record of [{status:302},{date:'Sat, 10 Oct 2026 04:00:00 GMT'},
    {snapshot:header({controls:changedControls,bodyText:'签到成功'})},
    {snapshot:header({controls:[],bodyText:'签到成功'})},
    {snapshot:header({bodyText:'昨日签到成功 2026-10-10'})},{snapshot:header({bodyText:'普通页面，无签到终态'})},
    {snapshot:header({bodyText:'签到成功'})},{snapshot:header({bodyText:'签到说明：点击后显示签到成功'})},
    {snapshot:header({bodyText:'示例：今天签到成功，本次签到获得10魔力'})},
    {snapshot:header({bodyText:'签到规则：本次签到可以获得10魔力'})},
    {snapshot:header({bodyText:'尚未签到 签到失败'})},{error:true}]){
    const f=fixture(t,{network:[{},record]}),result=await runNativePtApiCheckin(f);
    assert.equal(result.status,'needs_attention');assert.equal(result.failureCode,'submission_outcome_unknown');
    assert.equal(result.submissionAttempted,true);assert.equal(result.retryable,false);assert.equal(result.evidence,undefined);
    assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',url]);
    const saved=JSON.parse(fs.readFileSync(journal(f)));assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].state,'submitted');
    assert.equal(f.contextClosed,1);assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);assertNoPrivate(result);
  }
});

test('rejected, missing or failed durable finish cannot flow out as signed',async t=>{
  for(const finish of ['false','null','throw']){
    const f=fixture(t,{network:[{}, {snapshot:header({bodyText:'今天已经签到，签到成功'})}],
      gateChange:async options=>{
        if(options.phase!=='finish')return undefined;
        if(finish==='throw')throw Error('PRIVATE save failure');
        return finish==='null'?null:{allow:false,confirmed:false,confirmationState:'rejected'};
      }});
    const result=await runNativePtApiCheckin(f);
    assert.equal(result.status,'needs_attention');assert.equal(result.failureCode,'submission_outcome_unknown');
    assert.equal(result.confirmationState,'not_persisted');assert.equal(result.evidence,undefined);assert.equal(result.retryable,false);
    assert.equal(f.calls.filter(call=>call.url===url).length,1);assert.equal(JSON.parse(fs.readFileSync(journal(f))).attempts[0].state,'submitted');
    assertNoPrivate(result);
  }
});
