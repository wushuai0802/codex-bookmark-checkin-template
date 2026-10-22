import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readNativePtApiHeader,runNativePtApiCheckin} from '../src/native-pt-api.mjs';
import {ptReadPolicy,ptReadProxy,nativeApiHeaderAuthenticated} from '../src/pt-read-policy.mjs';
import {runNativePtGate} from '../src/native-pt-gate.mjs';

const origin='https://audiences.me',ownId='438771926',now=new Date('2026-10-11T04:00:00Z');
const proxy='http://100.100.10.20:7893';
const accountText='PRIVATE_ACCOUNT 上传 10 GB 下载 2 GB 分享率 5 爆米花 20 H&R 0/0/0';
function header({controls,headerText=accountText,bodyText='PRIVATE_BODY',headerCount=1,baseHrefs=[],inputs=[],forms=[],headings=[],hasPassword=false,attributes=[],headerAttributes={},outsideAttributes=[]}={}){
  return {headerText,bodyText,headerCount,baseHrefs,inputs,forms,headings,hasPassword,attributes,headerAttributes,outsideAttributes,controls:controls??[
    {text:'PRIVATE_ACCOUNT',href:'/userdetails.php?id='+ownId,tag:'A'},
    {text:'签到',href:'/attendance.php',tag:'A'},
  ]};
}
function fixture(t,{network=[{},{}],scope=true,configChange={}}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'audiences-api-header-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'data/shared');
  for(const dir of ['config','tmp','data/shared','controller/config','controller/data'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'fixture-only profile');
  const policy={reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',dailyHeader:true,
    nativeIsolatedChrome:true,nativeApiHeaderFallback:true,actionPath:'/attendance.php',unsignedText:'签到',proxyServer:proxy};
  const config={automationUserDataDir:profile,bookmarksPath:path.join(root,'bookmarks/Bookmarks'),
    nativeChallengePreflight:[{url:origin+'/attendance.php',action:'checkin'}],
    ptReadOnlyPolicies:{[origin]:policy},nativePtProxyByOrigin:{[origin]:proxy},...configChange};
  const save=()=>fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));save();
  const controller=path.join(root,'controller'),nonce=crypto.randomUUID();
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({nonce,pid:process.pid}));
  const previousRoot=process.env.CHECKIN_V2_ENGINE_ROOT,previousLease=process.env.CHECKIN_V2_ENGINE_LEASE;
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{
    if(previousRoot===undefined)delete process.env.CHECKIN_V2_ENGINE_ROOT;else process.env.CHECKIN_V2_ENGINE_ROOT=previousRoot;
    if(previousLease===undefined)delete process.env.CHECKIN_V2_ENGINE_LEASE;else process.env.CHECKIN_V2_ENGINE_LEASE=previousLease;
  });
  const calls=[],phases=[],snapshots=new Map();let launchCount=0,parserCount=0,contextClosed=0;
  const gate=async options=>{
    phases.push(options.phase);
    return runNativePtGate({...options,readPlan:async()=>({targets:scope?[{origin,candidates:[origin+'/attendance.php'],
      allowedOrigins:[origin],folderNames:['PT']}]:[]}),harvest:()=>null,verify:()=>null});
  };
  const launch=async cfg=>{
    launchCount++;
    assert.equal(cfg.automationUserDataDir,profile);assert.equal(cfg.ptPassiveReadOnly,true);
    assert.equal(cfg.nativePtReadOrigin,origin);assert.deepEqual(ptReadProxy(cfg),{server:proxy});
    const context={route:async(pattern,handler)=>{
      assert.equal(pattern,'**/*');let denied=false;
      await handler({abort:async code=>{assert.equal(code,'blockedbyclient');denied=true;}});assert.equal(denied,true);
    },request:{post:async()=>{throw Error('No POST is permitted');},get:async(url,options)=>{
      const index=calls.length,record=network[index]??{};calls.push({url,options});
      assert.equal(options.maxRedirects,0);assert.equal(options.maxRetries,0);assert.equal(options.ignoreHTTPSErrors,false);
      assert.ok(url===origin+'/index.php'||url===origin+'/userdetails.php?id='+ownId,'only exact passive self reads are allowed');
      if(record.error)throw Error('PRIVATE transport failure');
      const token='html-'+index;snapshots.set(token,record.snapshot??header());
      return {status:()=>record.status??200,url:()=>record.responseUrl??url,
        headers:()=>({Date:record.date===undefined?now.toUTCString():record.date}),text:async()=>token};
    }},newPage:async()=>{
      parserCount++;
      return {route:context.route,setContent:async html=>{
        assert.match(html,/Content-Security-Policy/);assert.doesNotMatch(html,/PRIVATE/);
      },evaluate:async(fn,args)=>{
        const snapshot=snapshots.get(args.html),oldParser=globalThis.DOMParser;
        globalThis.DOMParser=class{parseFromString(){
          const block={textContent:snapshot.headerText,getAttribute:name=>snapshot.headerAttributes[name]??null,
            querySelectorAll:selector=>selector==='[alt],[title],[aria-label]'?snapshot.attributes.map(attributes=>({getAttribute:name=>attributes[name]??null})):snapshot.controls.map(control=>({
            tagName:control.tag??'A',textContent:control.text,getAttribute:()=>control.href??null,matches:()=>control.button===true,
          }))};
          return {body:{textContent:snapshot.bodyText},querySelectorAll:selector=>
            selector===args.selector?Array.from({length:snapshot.headerCount},()=>block):
            selector==='[alt],[title],[aria-label]'?snapshot.outsideAttributes.map(attributes=>({getAttribute:name=>attributes[name]??null})):
            selector==='base[href]'?snapshot.baseHrefs.map(href=>({getAttribute:()=>href})):
            selector==='input'?snapshot.inputs.map(attributes=>({getAttribute:attribute=>{
              if(attribute==='value')throw Error('Input values cannot be inspected');
              return Object.hasOwn(attributes,attribute)?attributes[attribute]:null;
            }})):
            selector==='form[action]'?snapshot.forms.map(action=>({getAttribute:()=>action})):
            selector==='h1,h2,h3,legend'?snapshot.headings.map(textContent=>({textContent})):
            selector==='input[type="password"]'&&snapshot.hasPassword?[{}]:[]};
        }};
        try{return fn(args);}finally{if(oldParser===undefined)delete globalThis.DOMParser;else globalThis.DOMParser=oldParser;}
      },close:async()=>{}};
    },close:async()=>{contextClosed++;}};
    return context;
  };
  return {root,origin,profile,policy,config,save,gate,launch,clock:()=>now,calls,phases,
    get launchCount(){return launchCount;},get parserCount(){return parserCount;},get contextClosed(){return contextClosed;}};
}
const journal=f=>path.join(f.root,'data/native-pt-attempts.json');
function noPrivate(result){assert.doesNotMatch(JSON.stringify(result),new RegExp('PRIVATE|'+ownId+'|bodyText|headerText|authHeaderSemanticText|accountId'));}
function completed({anchor=false}={}){
  return header({headerText:accountText+' 已签到 +400',controls:[header().controls[0],
    ...(anchor?[{text:'已签到',href:'/attendance.php',tag:'A'}]:[])]});
}

test('Audiences header without logout or panel is authenticated by two fresh same-account passive pages',async t=>{
  const f=fixture(t),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);assert.equal(result.submissionAttempted,false);
  assert.equal(result.evidence.statusSignal,'nexus_daily_header_unsigned');assert.equal(result.inspection.authenticated,true);
  assert.equal(result.inspection.unsignedControl,'签到');assert.equal(result.readbackReceipt.profileBinding,result.profileBinding);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',origin+'/userdetails.php?id='+ownId]);
  assert.deepEqual(f.phases,['bind']);assert.equal(fs.existsSync(journal(f)),false);assert.equal(f.contextClosed,1);noPrivate(result);
  const accepted=await f.gate({root:f.root,origin,url:origin+'/attendance.php',profile:f.profile,
    phase:'readback',receipt:result.readbackReceipt,clock:f.clock});
  assert.equal(accepted.receiptAccepted,true);assert.equal(JSON.parse(fs.readFileSync(journal(f))).attempts.length,0);
});

test('exact signed anchor and reviewed non-clickable reward header both produce accepted bound positive receipts',async t=>{
  for(const anchor of [true,false]){
    const snapshot=completed({anchor}),f=fixture(t,{network:[{snapshot},{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
    assert.equal(result.inspection.audiencesDailyHeaderVerified,!anchor);assert.equal(result.inspection.signedControlCount,anchor?1:0);
    assert.equal(result.evidence.statusSignal,'nexus_daily_header_signed');assert.equal(f.calls.length,2);noPrivate(result);
    assert.equal((await f.gate({root:f.root,origin,url:origin+'/attendance.php',profile:f.profile,phase:'readback',
      receipt:result.readbackReceipt,clock:f.clock})).receiptAccepted,true);
  }
});

test('actual Audiences icon statistics authenticate only within the unique header and cannot supply completion from tooltips',async t=>{
  const attributes=[{alt:'爆米花'},{title:'H&R'},{'aria-label':'Downloaded PRIVATE_TOOLTIP'}];
  const snapshot=header({headerText:'PRIVATE_ACCOUNT',attributes}),f=fixture(t,{network:[{snapshot},{snapshot}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);assert.equal(f.calls.length,2);noPrivate(result);
  const completedIconHeader=header({headerText:'PRIVATE_ACCOUNT 已签到 +400',attributes,controls:[header().controls[0]]});
  const signedFixture=fixture(t,{network:[{snapshot:completedIconHeader},{snapshot:completedIconHeader}]}),signed=await readNativePtApiHeader(signedFixture);
  assert.equal(signed.status,'already_signed');assert.equal(signed.inspection.audiencesDailyHeaderVerified,true);
  assert.equal(signedFixture.calls.length,2);noPrivate(signed);
  assert.equal((await signedFixture.gate({root:signedFixture.root,origin,url:origin+'/attendance.php',profile:signedFixture.profile,
    phase:'readback',receipt:signed.readbackReceipt,clock:signedFixture.clock})).receiptAccepted,true);
  const tooltip=header({headerText:'PRIVATE_ACCOUNT',attributes:[...attributes,{title:'今日已签到 已签到 +400'}]});
  const hinted=fixture(t,{network:[{snapshot:tooltip},{snapshot:tooltip}]}),hint=await readNativePtApiHeader(hinted);
  assert.equal(hint.status,'not_signed');assert.equal(hint.inspection.audiencesDailyHeaderVerified,false);noPrivate(hint);
  for(const snapshot of [header({headerText:'PRIVATE_ACCOUNT',bodyText:accountText}),
    header({headerText:'PRIVATE_ACCOUNT',outsideAttributes:attributes}),
    header({headerText:'PRIVATE_ACCOUNT',attributes:attributes.slice(0,2)}),
    header({headerText:'PRIVATE_ACCOUNT',attributes,controls:[header().controls[0]]}),
    header({headerText:'PRIVATE_ACCOUNT',attributes,headerCount:2})]){
    const invalid=fixture(t,{network:[{snapshot},{snapshot}]}),observed=await readNativePtApiHeader(invalid);
    assert.equal(observed.status,'unconfirmed');assert.equal(observed.evidence,undefined);assert.equal(observed.submissionAttempted,false);noPrivate(observed);
  }
});

test('same-account avatar links and safe same-origin base retain one identity without following duplicate destinations',async t=>{
  const base=header();
  for(const snapshot of [header({controls:[...base.controls,base.controls[0]]}),
    header({baseHrefs:[origin+'/'],controls:base.controls.map(value=>({...value,href:value.href.slice(1)}))})]){
    const f=fixture(t,{network:[{snapshot},{}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);assert.equal(f.calls.length,2);noPrivate(result);
  }
});

test('self identity, original base and exact daily anchor reject malformed, ambiguous, foreign and historical claims',async t=>{
  const base=header(),self=base.controls[0],action=base.controls[1];
  const cases=[header({headerCount:0}),header({headerCount:2}),header({headerText:'PRIVATE_ACCOUNT only'}),
    header({headerText:'PRIVATE_ACCOUNT 上传 下载 爆米花 without H and R'}),header({controls:[action]}),
    header({controls:[self,action,{...self,href:'/userdetails.php?id=998877661'}]}),
    header({controls:[{...self,href:'/userdetails.php?id=0'},action]}),header({controls:[{...self,href:'/userdetails.php?id=01'},action]}),
    header({controls:[{...self,href:'/userdetails.php?id='+ownId+'&action=update'},action]}),
    header({controls:[{...self,href:'/userdetails.php?id='+ownId+'&id='+ownId},action]}),
    header({controls:[{...self,href:'https://www.audiences.me/userdetails.php?id='+ownId},action]}),
    header({controls:[{...self,href:'https://foreign.example/userdetails.php?id='+ownId},action]}),
    header({controls:[self,action,action]}),header({controls:[self,action,{...action,text:'已签到'}]}),
    header({controls:[self,{...action,text:'历史签到'}]}),header({controls:[self,{text:'签到',button:true,tag:'BUTTON'}]}),
    header({controls:[self,{...action,href:'/attendance.php?submit=1'}]}),
    header({baseHrefs:['https://www.audiences.me/']}),header({baseHrefs:['https://foreign.example/']}),
    header({baseHrefs:[origin+'/',origin+'/']}),completed({anchor:false}),
    header({headerText:accountText+' 昨日已签到 +400',controls:[self]}),
    header({headerText:accountText+' 已签到 +400 已签到 +400',controls:[self]})];
  for(const [index,snapshot] of cases.entries()){
    const f=fixture(t,{network:[{snapshot},{}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.submissionAttempted,false,'case '+index);
    assert.equal(result.evidence,undefined,'case '+index);assert.ok(f.calls.length<=2);noPrivate(result);
  }
  const f=fixture(t,{network:[{snapshot:header({bodyText:'榜单 PRIVATE_BODY 今日已签到 已签到 +400 爆米花 H&R'})},{}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.inspection.audiencesDailyHeaderVerified,false);noPrivate(result);
});

test('missing or changed self-profile, stale responses, redirects, WAF, password and OTP never authorize a retry',async t=>{
  const self=header().controls[0];
  const records=[{status:302},{status:403},{status:500},{responseUrl:origin+'/login.php'},
    {responseUrl:'https://www.audiences.me/userdetails.php?id='+ownId},{date:''},{date:'invalid'},
    {date:new Date(now.getTime()-300001).toUTCString()},{date:new Date(now.getTime()+61000).toUTCString()},
    {date:'Sat, 10 Oct 2026 04:00:00 GMT'},{error:true},
    {snapshot:header({headerCount:0})},{snapshot:header({controls:[{...self,href:'/userdetails.php?id=998877661'}]})},
    {snapshot:completed()},{snapshot:header({bodyText:'Just a moment Verify you are human'})},
    {snapshot:header({hasPassword:true})},{snapshot:header({bodyText:'请输入用户名和密码'})},
    {snapshot:header({inputs:[{type:'text',name:'totp',value:'MUST_NOT_READ'}]})},
    {snapshot:header({forms:['/take2fa.php']})},{snapshot:header({headings:['异地登录安全验证']})}];
  for(const [index,record] of records.entries()){
    const f=fixture(t,{network:[{},record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.evidence,undefined,'case '+index);
    assert.equal(result.submissionAttempted,false);assert.equal(f.calls.length,2);assert.equal(fs.existsSync(journal(f)),false);
    assert.doesNotMatch(JSON.stringify(result),/MUST_NOT_READ/);noPrivate(result);
  }
  for(const record of records.filter(record=>!record.snapshot)){
    const f=fixture(t,{network:[record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(f.calls.length,1);assert.equal(f.parserCount,0);noPrivate(result);
  }
});

test('native API writes remain PigGo-only even if an Audiences execution flag is manually enabled',async t=>{
  const f=fixture(t);f.policy.nativeApiExecution=true;f.save();
  const result=await runNativePtApiCheckin({...f,url:origin+'/attendance.php',validateLease:async()=>{throw Error('No lease should be requested');}});
  assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(f.launchCount,0);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.phases,[]);assert.equal(fs.existsSync(journal(f)),false);noPrivate(result);
});

test('Shanghai business day changing between the two passive pages cannot produce a receipt',async t=>{
  const before=new Date('2026-10-11T15:59:59Z'),after=new Date('2026-10-11T16:00:01Z');
  const f=fixture(t,{network:[{date:before.toUTCString()},{date:after.toUTCString()}]});
  const result=await readNativePtApiHeader({...f,clock:()=>f.calls.length>=2?after:before});
  assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.submissionAttempted,false);
  assert.equal(f.calls.length,2);assert.equal(fs.existsSync(journal(f)),false);noPrivate(result);
});

test('remote proxy exception requires the exact Audiences private API opt-in, origin and proxy map',async t=>{
  const f=fixture(t),configured={...f.config,ptPassiveReadOnly:true,ptReadProxyServer:proxy,nativePtReadOrigin:origin};
  assert.deepEqual(ptReadProxy(configured),{server:proxy});assert.equal(ptReadPolicy(origin,f.config).proxyServer,proxy);
  for(const changes of [{nativePtReadOrigin:undefined},{nativePtReadOrigin:'https://www.audiences.me'},
    {nativePtReadOrigin:'https://piggo.me'},{nativePtProxyByOrigin:{}},{ptReadProxyServer:'http://100.100.10.21:7893'},
    {ptReadOnlyPolicies:{[origin]:{...f.policy,nativeApiHeaderFallback:false}}},
    {ptReadOnlyPolicies:{[origin]:{...f.policy,nativeApiExecution:true}}},
    {ptReadOnlyPolicies:{[origin]:{...f.policy,nativeMainChrome:true}}},
    {nativeChallengePreflight:[]},{nativeChallengePreflight:[{url:origin+'/index.php',passiveOnly:false}],mainChromeFallbackUrls:[origin+'/attendance.php']}])
    assert.throws(()=>ptReadProxy({...configured,...changes}));
  const accepted=['http://10.20.30.40:7893','http://172.16.0.1:7893','http://172.31.255.254:7893',
    'http://192.168.1.1:7893','http://100.64.0.1:7893','http://100.127.255.254:7893'];
  const rejected=['http://proxy.example:7893','http://8.8.8.8:7893','http://172.15.0.1:7893','http://172.32.0.1:7893',
    'http://192.169.1.1:7893','http://100.63.0.1:7893','http://100.128.0.1:7893','http://010.0.0.1:7893',
    'http://u:p@100.100.10.20:7893','http://100.100.10.20:7893/path','http://100.100.10.20:7893/?x=1',
    'http://100.100.10.20:7893/#x','https://100.100.10.20:7893','http://100.100.10.20:0','http://100.100.10.20:65536',
    'http://100.100.10.20:7893\n'];
  for(const value of [...accepted,...rejected]){
    const candidate={...configured,ptReadProxyServer:value,nativePtProxyByOrigin:{[origin]:value},
      ptReadOnlyPolicies:{[origin]:{...f.policy,proxyServer:value}}};
    if(accepted.includes(value)){assert.deepEqual(ptReadProxy(candidate),{server:new URL(value).origin});assert.equal(ptReadPolicy(origin,candidate).proxyServer,value);}
    else{assert.throws(()=>ptReadProxy(candidate));assert.throws(()=>ptReadPolicy(origin,candidate));}
  }
  assert.throws(()=>ptReadProxy({ptPassiveReadOnly:true,ptReadProxyServer:proxy}));
  assert.deepEqual(ptReadProxy({ptPassiveReadOnly:true,ptReadProxyServer:'http://127.0.0.1:7890'}),{server:'http://127.0.0.1:7890'});
  assert.throws(()=>ptReadPolicy('https://www.audiences.me',{...f.config,ptReadOnlyPolicies:{'https://www.audiences.me':{
    ...f.policy,url:'https://www.audiences.me/index.php',proxyServer:'http://127.0.0.1:7890'}}}));
});

test('private opt-in and current unique execution Profile are mandatory and PigGo authentication is unchanged',async t=>{
  for(const configChange of [{ptReadOnlyPolicies:{}},{nativeChallengePreflight:[]},
    {supplementalOAuthAccounts:[{origin,accountKey:'extra'}]}]){
    const f=fixture(t,{configChange}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(f.launchCount,0);noPrivate(result);
  }
  const f=fixture(t,{scope:false});assert.equal((await readNativePtApiHeader(f)).status,'unconfirmed');assert.equal(f.launchCount,0);
  const piggo={origin:'https://piggo.me',policy:{nativeApiHeaderFallback:true,nativeIsolatedChrome:true,dailyHeader:true},
    controls:[{path:'/userdetails.php',accountId:ownId}],headerText:accountText};
  assert.equal(nativeApiHeaderAuthenticated(piggo),false);
  assert.equal(nativeApiHeaderAuthenticated({...piggo,headerText:'欢迎回来 上传 下载',controls:[...piggo.controls,{path:'/usercp.php'}]}),true);
});
