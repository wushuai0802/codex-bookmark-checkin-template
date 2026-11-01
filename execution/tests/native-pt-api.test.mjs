import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {readNativePtApiHeader,readNativePtApiHeaderInContext,piggoNativePassiveContext,runNativePtApiCheckin} from '../src/native-pt-api.mjs';
import {inspectNativePtHeader} from '../src/native-pt-read.mjs';
import {installPiggoCalendarFirewall,piggoCalendarUrl,piggoAttendanceUrl,piggoDay} from '../src/piggo-calendar.mjs';
import {fixture,calendarData,now} from './helpers/piggo-spa-fixture.mjs';
import {nexusFixture,header as nexusHeader,origin as nexusOrigin,now as nexusNow,ownId as nexusOwnId,
  nexusJournal,assertNoPrivate} from './helpers/nexus-api-fixture.mjs';

const journal=f=>path.join(f.root,'data/native-pt-attempts.json');
const privateFree=value=>assert.doesNotMatch(JSON.stringify(value),/PRIVATE|918273645|username|password|bodyText|accountId/);

// Restored generic API reads on the still-supported Nexus header origin.
// Audiences additionally requires a corroborating passive self-profile read.
function defineNexusReadTests(){
  const origin=nexusOrigin,now=nexusNow,ownId=nexusOwnId;

test('private opt-in, isolated binding and current bookmark scope are required before any API request',async t=>{
  for(const configChange of [{ptReadOnlyPolicies:{}},{ptReadOnlyPolicies:{[origin]:{reviewed:true,nativeApiHeaderFallback:false}}},
    {supplementalOAuthAccounts:[{origin,accountKey:'other'}]}]){
    const f=nexusFixture(t,{configChange}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(f.launchCount,0);
    assert.equal(result.inspection.authenticated,false);assertNoPrivate(result);
  }
  const f=nexusFixture(t,{scope:false}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'unconfirmed');assert.equal(f.launchCount,0);assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(nexusJournal(f)),false);
  const main=nexusFixture(t);main.config.ptReadOnlyPolicies[origin].nativeIsolatedChrome=false;main.config.ptReadOnlyPolicies[origin].nativeMainChrome=true;
  fs.writeFileSync(path.join(main.root,'config/config.json'),JSON.stringify(main.config));
  assert.equal((await readNativePtApiHeader(main)).status,'unconfirmed');assert.equal(main.launchCount,0);
});

test('API index returns only bound safe negative proof from the reviewed authenticated private header',async t=>{
  const f=nexusFixture(t),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence.authoritative,true);
  assert.equal(result.evidence.source,'page_text');assert.equal(result.evidence.statusSignal,'nexus_daily_header_unsigned');
  assert.equal(result.operationMode,'safe_history_page');assert.equal(result.readSafety,'reviewed_passive');
  const key=process.platform==='win32'?f.profile.toLowerCase():f.profile;
  assert.equal(result.profileBinding,crypto.createHash('sha256').update(key).digest('hex'));assert.equal(result.accountKey,'site-default');
  assert.equal(result.readbackReceipt.inspection.unsignedControl,'签到得魔力');assert.equal(result.inspection.authenticated,true);
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',origin+'/userdetails.php?id='+ownId]);assert.equal(fs.existsSync(nexusJournal(f)),false);
  assert.equal(f.contextClosed,1);assert.equal(f.parserClosed,2);assertNoPrivate(result);
});

test('2FA settings links and menu text retain the authenticated native API unsigned proof',async t=>{
  const base=nexusHeader(),snapshot=nexusHeader({headerText:base.headerText+' 2FA设置 二级验证设置',
    bodyText:'本站菜单：2FA 设置，管理两步验证',controls:[...base.controls,{text:'2FA设置',href:'/usercp.php'}]});
  const f=nexusFixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);
  assert.equal(result.inspection.authenticated,true);assert.equal(result.inspection.securityVerification,false);
  assert.equal(result.inspection.unsignedControl,'签到得魔力');assert.equal(f.calls.length,2);assertNoPrivate(result);
});

test('actual OTP input, verification form or explicit code prompt blocks proof without reading input values',async t=>{
  const cases=[nexusHeader({bodyText:'请输入二级验证代码进行验证'}),nexusHeader({bodyText:'请输入验证码'}),
    nexusHeader({headings:['异地登录安全验证']}),
    nexusHeader({inputs:[{type:'text',name:'code',autocomplete:'one-time-code',value:'DO_NOT_READ_VALUE'}]}),
    nexusHeader({forms:['/take2fa.php'],inputs:[{type:'text',name:'code',placeholder:'验证码',value:'DO_NOT_READ_VALUE'}]})];
  for(const [index,snapshot] of cases.entries()){
    const f=nexusFixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.evidence,undefined);
    assert.equal(result.inspection.securityVerification,true,'case '+index);assert.equal(result.inspection.authenticated,false);
    assert.equal(result.submissionAttempted,false);assert.equal(f.calls.length,1);assertNoPrivate(result);
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_READ_VALUE/);
  }
  const f=nexusFixture(t,{network:[{snapshot:nexusHeader({bodyText:'2FA设置',inputs:[{type:'password',value:'DO_NOT_READ_VALUE'}]})}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'unconfirmed');assert.equal(result.inspection.loginRoute,true);assert.equal(result.evidence,undefined);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_READ_VALUE/);
});

test('missing account header, duplicate identities or daily controls, login and WAF cannot authorize recovery',async t=>{
  const base=nexusHeader();
  const cases=[nexusHeader({headerCount:0}),nexusHeader({headerCount:2}),nexusHeader({headerText:'普通账户文字'}),
    nexusHeader({controls:base.controls.filter(control=>!control.href.startsWith('/userdetails.php'))}),
    nexusHeader({controls:[...base.controls,{text:'other',href:'/userdetails.php?id=999'}]}),
    nexusHeader({controls:[...base.controls,base.controls[2]]}),
    nexusHeader({controls:[...base.controls,{text:'已签到',href:'/attendance.php'}]}),
    nexusHeader({controls:base.controls.map(control=>control.href==='/attendance.php'?{...control,text:'历史签到得魔力'}:control)}),
    nexusHeader({controls:base.controls.map(control=>control.href.startsWith('/userdetails')?{...control,href:'https://foreign.example/userdetails.php?id='+ownId}:control)}),
    nexusHeader({bodyText:'请输入用户名和密码 登录 Login'}),nexusHeader({hasPassword:true}),nexusHeader({bodyText:'Just a moment Verify you are human'}),
    nexusHeader({bodyText:'异地登录安全验证 二级验证代码'})];
  for(const [index,snapshot] of cases.entries()){
    const f=nexusFixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed','case '+index);assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.ok(result.inspection);assert.equal(f.calls.length,[5,6,7].includes(index)?2:1);assert.equal(fs.existsSync(nexusJournal(f)),false);assertNoPrivate(result);
  }
});

test('one account may have avatar and username links, while original foreign base URLs cannot fake same-origin ownership',async t=>{
  const base=nexusHeader();
  for(const snapshot of [nexusHeader({controls:[...base.controls,base.controls[0]]}),
    nexusHeader({baseHrefs:[origin+'/'],controls:base.controls.map(control=>({...control,href:control.href.slice(1)}))})]){
    const f=nexusFixture(t,{network:[{snapshot}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'not_signed');assert.equal(result.evidence.authoritative,true);assert.equal(f.calls.length,2);assertNoPrivate(result);
  }
  const credentialBase=new URL(origin+'/');credentialBase.username='user';
  for(const baseHrefs of [['https://foreign.example/'],['http://audiences.me/'],[origin+'/',origin+'/'],[credentialBase.href]]){
    const f=nexusFixture(t,{network:[{snapshot:nexusHeader({baseHrefs})}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(result.inspection.authenticated,false);
    assert.equal(f.calls.length,1);assertNoPrivate(result);
  }
});

test('HTTP status, exact response URL, fresh Shanghai Date and strict TLS are mandatory',async t=>{
  for(const record of [{status:302},{status:500},{responseUrl:origin+'/login.php'},
    {responseUrl:'https://www.audiences.me/index.php'},{date:'invalid'},{date:''},
    {date:new Date(now.getTime()-300001).toUTCString()},{date:new Date(now.getTime()+61000).toUTCString()},
    {date:'Sat, 10 Oct 2026 04:00:00 GMT'},{error:true}]){
    const f=nexusFixture(t,{network:[record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.equal(f.calls.length,1);assert.equal(f.parserClosed,0);assert.equal(f.contextClosed,1);assertNoPrivate(result);
  }
});

test('a fresh same-origin login redirect reports expired authentication without following it or starting an attendance intent',async t=>{
  for(const location of ['/login.php',origin+'/login.php?returnto=%2Findex.php']){
    const f=nexusFixture(t,{network:[{status:302,location}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'login_required');assert.equal(result.failureCode,'login_required');
    assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
    assert.equal(result.inspection.loginRoute,true);assert.equal(result.inspection.authenticated,false);
    assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php']);
    assert.equal(f.parserClosed,0);assert.equal(f.contextClosed,1);assert.equal(fs.existsSync(nexusJournal(f)),false);
    assertNoPrivate(result);
  }
  const credentialRedirect=new URL(origin+'/login.php');credentialRedirect.username='user';
  for(const location of ['https://foreign.example/login.php','http://audiences.me/login.php',
    credentialRedirect.href,'/attendance.php','/login.php#fragment']){
    const f=nexusFixture(t,{network:[{status:302,location}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(f.calls.length,1);
    assert.equal(result.submissionAttempted,false);assert.equal(fs.existsSync(nexusJournal(f)),false);assertNoPrivate(result);
  }
  const f=nexusFixture(t,{network:[{status:302,location:'/login.php',date:new Date(now.getTime()-300001).toUTCString()}]});
  assert.equal((await readNativePtApiHeader(f)).status,'unconfirmed');
});

test('already-signed API index returns immediately with no attendance GET or journal change',async t=>{
  const f=nexusFixture(t,{network:[{snapshot:nexusHeader({signed:true})}]}),result=await readNativePtApiHeader(f);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);assert.equal(result.evidence.authoritative,true);
  assert.equal(result.operationMode,'safe_history_page');assert.equal(result.readSafety,'reviewed_passive');
  assert.deepEqual(f.calls.map(call=>call.url),[origin+'/index.php',origin+'/userdetails.php?id='+ownId]);assert.deepEqual(f.events.filter(event=>event.startsWith('gate:')),['gate:bind']);
  assert.equal(fs.existsSync(nexusJournal(f)),false);assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);assertNoPrivate(result);
});

test('native-login account verification reuses its proved context and rejects an unproved or changing Profile',async t=>{
  for(const variant of ['valid','unproved','changed']){
    const f=nexusFixture(t),context=await f.launch({...f.config,automationUserDataDir:f.profile,ptPassiveReadOnly:true,
      ptReadProxyServer:f.policy.proxyServer,failureScreenshots:false});
    let checks=0;const profileProof=async()=>{checks++;return variant==='valid'||variant==='changed'&&checks===1;};
    const key=process.platform==='win32'?f.profile.toLowerCase():f.profile;
    const result=await readNativePtApiHeaderInContext({...f,context,profileProof,
      expectedProfileBinding:crypto.createHash('sha256').update(key).digest('hex')});
    assert.equal(result.status,variant==='valid'?'not_signed':'unconfirmed');assert.equal(f.launchCount,1);
    assert.equal(f.contextClosed,0);assert.equal(f.calls.length,variant==='unproved'?0:2);assertNoPrivate(result);
    await context.close();assert.equal(f.contextClosed,1);
  }
});
}
defineNexusReadTests();

for(const [state,status] of [['checked','already_signed'],['today','not_signed'],['makeup','unconfirmed'],['none','unconfirmed'],['new','unconfirmed']]){
  test('SPA calendar '+state+' maps conservatively to '+status,async t=>{
    const f=fixture(t,{network:[{data:calendarData(state)}]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,status);assert.equal(result.submissionAttempted,false);assert.equal(f.posts.length,0);
    assert.equal(result.evidence?.authoritative,status==='unconfirmed'?undefined:true);
    if(result.evidence){assert.equal(result.evidence.source,'api');assert.equal(result.evidence.pagePath,'/calendar');}
    assert.equal(f.contexts[0].closed,true);assert.equal(fs.existsSync(journal(f)),false);privateFree(result);
  });
}

test('malformed, non-today, stale, foreign, unauthenticated or mismatched responses supply no negative evidence',async t=>{
  const data=calendarData();
  const cases=[{data:{}},{data:{...data,detail:undefined}},{data:{...data,detail:{...data.detail,is_today:false}}},
    {data:{...data,selected:'2026-10-31'}},{data:{...data,detail:{...data.detail,ymd:'2026-10-31'}}},
    {data:{...data,detail:{...data.detail,attendance:{}}}},{data:{...data,cells:{}}},
    {data:{code:400,msg:'PRIVATE',data}},{data:[]},
    {options:{date:'invalid'}},{options:{date:new Date(now.getTime()-300001).toUTCString()}},
    {options:{date:'Sat, 31 Oct 2026 04:00:00 GMT'}},{options:{date:new Date(now.getTime()+61000).toUTCString()}},
    {options:{status:503}},{options:{responseUrl:'https://foreign.example/v1/web/calendar'}},
    {meOptions:{date:'invalid'}},{me:{user:{id:99,username:'PRIVATE'}}},{me:{user:{id:'42'}}},
    {me:{}},{meOptions:{status:403}},{requestUrl:'https://piggo.me/v1/web/calendar?year=2026&month=10'},
    {error:true}];
  for(const record of cases){
    const f=fixture(t,{network:[record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'unconfirmed');assert.equal(result.evidence,undefined);assert.equal(f.posts.length,0);privateFree(result);
  }
  for(const record of [{options:{status:401}},{meOptions:{status:401}},{redirect:'https://piggo.me/login'}]){
    const f=fixture(t,{network:[record]}),result=await readNativePtApiHeader(f);
    assert.equal(result.status,'login_required');assert.equal(result.evidence,undefined);assert.equal(f.posts.length,0);
  }
});

test('the exact API envelope is accepted, while crossing Shanghai midnight rejects the read',async t=>{
  const f=fixture(t,{network:[{data:{code:0,msg:'ok',data:calendarData('checked')}}]});
  assert.equal((await readNativePtApiHeader(f)).status,'already_signed');
  let current=new Date('2026-11-01T15:59:59Z');
  const crossed=fixture(t,{clock:()=>current,network:[{beforeResponses:()=>{current=new Date('2026-11-01T16:00:00Z');}}]});
  assert.equal((await readNativePtApiHeader(crossed)).status,'unconfirmed');assert.equal(crossed.posts.length,0);
});

test('private opt-in, expected account, scope, original isolated Profile and current proxy are mandatory',async t=>{
  for(const mutate of [f=>delete f.config.oauthExpectedAccountIds,f=>delete f.config.ptReadOnlyPolicies,
    f=>{f.policy.piggoCalendar=false;},f=>{f.policy.url=f.origin+'/index.php';},f=>{f.policy.nativeIsolatedChrome=false;},
    f=>{f.policy.proxyServer='http://foreign.example:7890';},f=>{f.config.supplementalOAuthAccounts=[{origin:f.origin,accountKey:'other'}];}]){
    const f=fixture(t);mutate(f);f.save();
    assert.equal((await readNativePtApiHeader(f)).status,'unconfirmed');assert.equal(f.launches,0);
  }
  const outside=fixture(t,{scope:false});assert.equal((await readNativePtApiHeader(outside)).status,'unconfirmed');assert.equal(outside.launches,0);
  const f=fixture(t),context=f.createContext();
  assert.equal(piggoNativePassiveContext({url:()=>piggoCalendarUrl,context:()=>context}),context);
  const result=await readNativePtApiHeaderInContext({...f,context,expectedProfileBinding:f.profileBinding,profileProof:async()=>true});
  assert.equal(result.status,'not_signed');assert.equal(context.routes.length,0);privateFree(result);
  assert.equal((await readNativePtApiHeaderInContext({...f,context,expectedProfileBinding:'b'.repeat(64),profileProof:async()=>true})).status,'unconfirmed');
});

test('native receipt decoding accepts only PigGo calendar evidence and never invokes the old accessibility helper',async t=>{
  const f=fixture(t),result=await inspectNativePtHeader({...f,url:piggoCalendarUrl,isolated:true,
    inspectApi:options=>readNativePtApiHeader({...f,...options}),execute:async()=>{throw Error('legacy helper forbidden');}});
  assert.equal(result.status,'not_signed');assert.equal(result.readbackReceipt.inspection.piggoCalendarVerified,true);privateFree(result);
  for(const url of [f.origin+'/index.php',f.origin+'/attendance.php',f.origin+'/login.php'])
    await assert.rejects(()=>inspectNativePtHeader({...f,url,isolated:true}));
});

test('legacy pending intent requires fresh new negative proof; one real button POST follows durable begin and checked readback',async t=>{
  const f=fixture(t,{post:{replay:true}}),old={attemptId:crypto.randomUUID(),origin:f.origin,accountKey:'site-default',
    profileBinding:f.profileBinding,businessDate:'2026-10-08',startedAt:'2026-10-08T00:06:00Z',state:'submitted',actions:['navigation']};
  fs.writeFileSync(journal(f),JSON.stringify({schemaVersion:1,attempts:[old]}));
  assert.equal((await f.gate({...f,phase:'inspect'})).decision.failureCode,'submission_outcome_unknown');
  const result=await runNativePtApiCheckin(f);
  assert.equal(result.status,'signed');assert.equal(result.evidence.statusSignal,'piggo_calendar_signed');assert.equal(f.posts.length,1);
  assert.deepEqual(f.posts,[{ymd:'2026-11-01'}]);assert.ok(f.events.indexOf('begin')<f.events.indexOf('POST'));assert.ok(f.events.indexOf('POST')<f.events.indexOf('finish'));
  const saved=JSON.parse(fs.readFileSync(journal(f)));assert.deepEqual(saved.attempts[0],old);assert.equal(saved.attempts[1].state,'confirmed');privateFree(saved);privateFree(result);
  assert.equal((await runNativePtApiCheckin(f)).status,'already_signed');assert.equal(f.posts.length,1);
});

test('makeup, none, unknown, checked and wrong-date pre-reads never submit',async t=>{
  for(const status of ['makeup','none','unknown','checked']){
    const f=fixture(t,{network:[{data:calendarData(status)}]});
    assert.equal((await runNativePtApiCheckin(f)).submissionAttempted,false);assert.equal(f.posts.length,0);assert.equal(fs.existsSync(journal(f)),false);
  }
  const data=calendarData();data.selected=data.detail.ymd='2026-10-31';
  const f=fixture(t,{network:[{data}]});assert.equal((await runNativePtApiCheckin(f)).submissionAttempted,false);assert.equal(f.posts.length,0);
});

test('ambiguous POST, failed readback, changed account and failed durable finish remain unknown without retry',async t=>{
  for(const options of [{post:{error:true}},{post:{options:{status:500}}},{post:{options:{status:302}}},{post:{data:{}}},
    {post:{options:{date:'Sat, 31 Oct 2026 04:00:00 GMT'}}},
    {network:[{}, {error:true}]},{network:[{}, {redirect:'https://piggo.me/login'}]},
    {network:[{}, {options:{date:'Sat, 31 Oct 2026 04:00:00 GMT'}}]},{network:[{}, {me:{user:{id:99}}}]},
    {network:[{}, {data:calendarData('today')}]},
    {gateChange:async args=>args.phase==='finish'?{allow:false,confirmed:false}:undefined},
    {gateChange:async args=>args.phase==='finish'?null:undefined},
    {gateChange:async args=>{if(args.phase==='finish')throw Error('PRIVATE save failure');}}]){
    const f=fixture(t,options),result=await runNativePtApiCheckin(f);
    assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.retryable,false);assert.equal(result.submissionAttempted,true);
    assert.equal(f.posts.length,1);assert.equal(result.evidence,undefined);assert.equal(JSON.parse(fs.readFileSync(journal(f))).attempts[0].state,'submitted');privateFree(result);
  }
});

test('current scope and a denied inspected gate stop the SPA submission before durable begin',async t=>{
  const outside=fixture(t,{scope:false}),outcome=await runNativePtApiCheckin(outside);
  assert.equal(outcome.submissionAttempted,false);assert.equal(outside.launches,0);assert.equal(outside.posts.length,0);
  const denied=fixture(t,{gateChange:async args=>args.phase==='inspect'?{allow:false,
    decision:{status:'deferred',retryCause:'harvest_waiting',submissionAttempted:false}}:undefined});
  const result=await runNativePtApiCheckin(denied);
  assert.equal(result.status,'deferred');assert.equal(result.submissionAttempted,false);
  assert.equal(denied.posts.length,0);assert.equal(denied.events.includes('begin'),false);
  assert.equal(JSON.parse(fs.readFileSync(journal(denied))).attempts.length,0);privateFree(result);
});

test('unregistered destination, missing opt-in/lease and an intervening midnight stop before a POST',async t=>{
  const noLease=fixture(t,{lease:false});assert.equal((await runNativePtApiCheckin(noLease)).submissionAttempted,false);assert.equal(noLease.launches,0);
  const noOpt=fixture(t);noOpt.policy.nativeApiExecution=false;noOpt.save();assert.equal((await runNativePtApiCheckin(noOpt)).submissionAttempted,false);
  const legacy=fixture(t);assert.equal((await runNativePtApiCheckin({...legacy,url:legacy.origin+'/attendance.php'})).submissionAttempted,false);assert.equal(legacy.launches,0);
  let current=new Date('2026-11-01T15:59:59Z');
  const f=fixture(t,{clock:()=>current,network:[{options:{date:current.toUTCString()},meOptions:{date:current.toUTCString()}}],
    gateChange:async args=>{if(args.phase==='begin')current=new Date('2026-11-01T16:00:00Z');}});
  assert.notEqual((await runNativePtApiCheckin(f)).status,'signed');assert.equal(f.posts.length,0);
});

test('firewall denies all PHP endpoints, credentials in URLs, foreign origins, makeup bodies and a second POST',async t=>{
  const f=fixture(t),context=f.createContext(),firewall=await installPiggoCalendarFirewall(context,{clock:f.clock});
  for(const route of ['/index.php','/login.php','/takelogin.php','/attendance.php','/v1/web/logout'])
    assert.equal(await context.request('GET',f.origin+route),false);
  for(const url of ['https://foreign.example/calendar',f.origin+'/calendar?password=fixture'])assert.equal(await context.request('GET',url),false);
  assert.equal(await context.request('POST',piggoAttendanceUrl,{ymd:piggoDay(now)}),false);
  firewall.arm(piggoDay(now));
  for(const body of [{ymd:'2026-10-31'},{ymd:piggoDay(now),makeup:true},{}])assert.equal(await context.request('POST',piggoAttendanceUrl,body),false);
  assert.equal(await context.request('POST',piggoAttendanceUrl,{ymd:piggoDay(now)}),true);
  assert.equal(await context.request('POST',piggoAttendanceUrl,{ymd:piggoDay(now)}),false);
});

test('midnight after the single POST preserves its original date and leaves the intent unknown',async t=>{
  let current=new Date('2026-11-01T15:59:59Z');
  const date=current.toUTCString();
  const f=fixture(t,{clock:()=>current,network:[{options:{date},meOptions:{date}}],
    post:{options:{date},afterResponse:()=>{current=new Date('2026-11-01T16:00:00Z');}}});
  const result=await runNativePtApiCheckin(f);
  assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.retryable,false);
  assert.deepEqual(f.posts,[{ymd:'2026-11-01'}]);assert.equal(JSON.parse(fs.readFileSync(journal(f))).attempts[0].state,'submitted');
});
