import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {chromium} from 'playwright-core';
import {ptSupplementTarget,publicSupplementResult,runPtSupplement,ptRewardCounter} from '../src/pt-supplement.mjs';
import {ptPageEvidence} from '../src/browser.mjs';
import {ptReadPolicy,installPtReadFirewall,ptExecutionBinding,classifyPtPassivePage,readPtPublicAvailability} from '../src/pt-read-policy.mjs';

test('Depth Studio completed header is authoritative only on its authenticated daily control',()=>{
  const origin='https://dstudio.me',policy=ptReadPolicy(origin),now=new Date('2026-10-01T12:00:00Z');
  const args={origin,policy,url:policy.url,now,authenticated:true,bodyText:'今日已完成已签到',controls:[{path:'/attendance.php',text:'今日已完成 已签到'}]};
  const result=classifyPtPassivePage(args);
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);
  const pending=classifyPtPassivePage({...args,bodyText:'欢迎回来，wushuai0802',controls:[{path:'/attendance.php',text:'待签到'}]});
  assert.equal(pending.status,'not_signed');assert.equal(pending.evidence.authoritative,true);
  assert.equal(pending.evidence.statusSignal,'nexus_daily_header_unsigned');
  assert.equal(classifyPtPassivePage({...args,bodyText:'欢迎回来，wushuai0802',controls:[{path:'/attendance.php',text:'点击签到'}]}).status,'not_signed');
  assert.equal(classifyPtPassivePage({...args,bodyText:'欢迎回来，wushuai0802',controls:[{path:'/attendance.php',text:'点击签到待签到'}]}).status,'not_signed');
  assert.equal(classifyPtPassivePage({...args,authenticated:false}).status,'unknown');
  assert.equal(classifyPtPassivePage({...args,bodyText:'欢迎回来，wushuai0802',controls:[{path:'/forums.php',text:'待签到'}]}).status,'unknown');
  assert.equal(classifyPtPassivePage({...args,bodyText:'欢迎回来，wushuai0802',controls:[]}).status,'unknown');
});

test('a scope failure after a possible native submission remains unknown instead of becoming an unsubmitted preflight',async t=>{
  for(const submitted of [true,false]){
    const args=fixture(t),origin='https://www.uhddolby.com',file=path.join(args.root,'config/config.json');
    const config=JSON.parse(fs.readFileSync(file));config.siteTwoFactorRecovery={[origin]:{enabled:true,reviewed:true,provider:'bitwarden',
      adapterId:'hddolby-nexus-stepup-v1',allowPasswordLogin:true}};fs.writeFileSync(file,JSON.stringify(config));
    fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
    const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');let changed=false;
    const run=()=>runPtSupplement({...args,origin,catalogHash,verifyBeforeSubmit:true,
      acquire:async()=>({}),release:async()=>{},validateScope:async()=>{if(changed)throw Object.assign(Error('scope changed'),{code:'PT_PREFLIGHT'});},
      runHddolbyNative:async()=>{changed=true;return {status:'needs_attention',submissionAttempted:submitted};}});
    if(submitted){const value=await run();assert.equal(value.failureCode,'submission_outcome_unknown');assert.equal(value.submissionAttempted,true);}
    else await assert.rejects(run(),error=>error.code==='PT_PREFLIGHT');
  }
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-site-fallback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data','data/browser'])fs.mkdirSync(path.join(root,dir));
  fs.writeFileSync(path.join(root,'data/browser/Local State'),'fixture');
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:path.join(root,'data/browser'),retryCount:3,failureScreenshots:true}));
  fs.writeFileSync(path.join(root,'config/qa-rules.json'),JSON.stringify({rules:[]}));
  fs.writeFileSync(path.join(root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[]}));
  const catalogFile=path.join(root,'catalog.json');
  fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin:'https://pt.example',entryUrl:'https://pt.example/attendance'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  return {root,catalogFile,catalogHash,origin:'https://pt.example',now:new Date('2026-09-20T02:00:00Z')};
}

test('site target uses one exact HTTPS bookmark URL without account mapping',()=>{
  assert.deepEqual(ptSupplementTarget({sites:[{origin:'https://pt.example',entryUrl:'https://pt.example/attendance'}]},'https://pt.example').candidates,['https://pt.example/attendance']);
  for(const entryUrl of ['https://other.example/attendance','https://pt.example/attendance?passkey=x','http://pt.example/']){
    assert.throws(()=>ptSupplementTarget({sites:[{origin:'https://pt.example',entryUrl}]},'https://pt.example'),/unsafe/);
  }
});

test('PT page evidence needs explicit same-day completion, not cumulative rewards',()=>{
  const now=new Date('2026-09-20T02:00:00Z'),base={origin:'https://pt.example',url:'https://pt.example/attendance.php',status:'already_signed',now};
  assert.equal(ptPageEvidence({...base,bodyText:'鲸币 [使用] (签到已得350) 2026-09-20'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-19 签到成功'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-20\n昨日签到成功 2026-09-19'}),null);
  assert.equal(ptPageEvidence({...base,url:'https://other.example/',bodyText:'今日已签到'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'今日已签到'}).businessDate,'2026-09-20');
  assert.equal(ptPageEvidence({...base,bodyText:'今天已经签到过了'}).source,'page_text');
  assert.equal(ptPageEvidence({...base,bodyText:'昨天已经签到过了'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'今天还未签到'}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'2026-09-20 签到成功'}).source,'page_text');
  assert.equal(ptPageEvidence({...base,status:'signed',bodyText:'这是您的第159次签到，本次签到获得800个憨豆。'}).source,'page_text');
  assert.equal(ptPageEvidence({...base,status:'signed',bodyText:'这是您的第159次签到，本次签到获得800个憨豆。',allowUndatedActionText:false}),null);
  assert.equal(ptPageEvidence({...base,bodyText:'今日已签到',allowUndatedActionText:false}).source,'page_text');
});

test('only a same-session increase in the PT reward counter verifies a supplement',async t=>{
  assert.equal(ptRewardCounter('鲸币 [使用]: 154,464.0 (签到已得350)'),350);
  assert.equal(ptRewardCounter('签到已得350 签到已得351'),null);
  const args=fixture(t),seen=[];
  const result=await runPtSupplement({...args,readReward:async()=>{const value=seen.length?360:350;seen.push(value);return value;},
    acquire:async()=>({owner:{nonce:'fixture'}}),release:async()=>{},
    launch:async()=>({close:async()=>{}}),runTarget:async()=>({status:'signed'})});
  assert.deepEqual(seen,[350,360]);assert.equal(result.status,'signed');assert.equal(result.evidence.authoritative,true);
  const noChange=await runPtSupplement({...args,readReward:async()=>350,
    acquire:async()=>({owner:{nonce:'fixture'}}),release:async()=>{},
    launch:async()=>({close:async()=>{}}),runTarget:async()=>({status:'already_signed'})});
  assert.equal(noChange.status,'unknown');
});

test('supplement holds the V1 lock and uses its browser flow once without altering daily plan',async t=>{
  const args=fixture(t),events=[];
  const result=await runPtSupplement({...args,
    acquire:async file=>{events.push('lock');assert.ok(file.endsWith(path.join('tmp','run.lock')));return {file};},
    release:async()=>{events.push('release');},
    launch:async config=>{events.push('launch');assert.equal(config.retryCount,0);assert.equal(config.failureScreenshots,false);assert.equal(config.capturePtEvidence,true);return {close:async()=>events.push('close')};},
    runTarget:async(_context,target)=>{events.push('execute');assert.deepEqual(target.candidates,['https://pt.example/attendance']);return {status:'already_signed',evidence:{source:'page_text',authoritative:true,confirmedAt:args.now.toISOString()}};}
  });
  assert.deepEqual(events,['lock','launch','execute','close','release']);
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'))).targets.length,0);
});

test('read-only PT verification uses the selected profile and never calls a submit path',async t=>{
  const args=fixture(t),origin='https://open.cd',now=new Date('2026-09-29T00:46:00Z');
  const catalog={sites:[{origin,entryUrl:'https://open.cd/index.php',operationMode:'formal_visit_checkin',readSafety:'attendance_page_risk'},
    {origin:'https://pt.example',entryUrl:'https://pt.example/attendance',operationMode:'safe_history_page',readSafety:'safe_history_page',readOnlyUrl:'https://pt.example/userdetails.php?id=7'}]};
  fs.writeFileSync(args.catalogFile,JSON.stringify(catalog));
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[{origin}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const body='fixture_user，歡迎回來 [控制面板]\n當前時間：08:43\n[查看簽到記錄] [21點]\n[退出]';
  const visited=[];
  const result=await runPtSupplement({...args,origin,catalogHash,now,readOnly:true,
    acquire:async()=>({owner:{nonce:'fixture'}}),release:async()=>{},
    launch:async config=>{assert.equal(config.ptPassiveReadOnly,true);return {route:async()=>{},newPage:async()=>({goto:async url=>{visited.push(url);return {status:()=>200};},url:()=>origin+'/index.php',locator:()=>({innerText:async()=>body}),close:async()=>{}}),close:async()=>{}};},
    readReward:async()=>{throw Error('read-only mode cannot visit rewards');},
    runTarget:async()=>{throw Error('read-only must never upgrade to a mutation');}});
  assert.deepEqual(visited,['https://open.cd/index.php']);
  assert.equal(result.status,'already_signed');
  assert.equal(result.evidence.authoritative,true);
  assert.equal(result.operationMode,'safe_history_page');
  const configFile=path.join(args.root,'config/config.json'),config=JSON.parse(fs.readFileSync(configFile));
  config.ptReadOnlyPolicies={'https://pt.example':{reviewed:true,mode:'safe_history_page',url:'https://pt.example/userdetails.php?id=7',selector:'#attendance-summary'}};
  fs.writeFileSync(configFile,JSON.stringify(config));
  const generic=await runPtSupplement({...args,catalogHash,origin:'https://pt.example',readOnly:true,
    launch:async()=>({route:async()=>{},newPage:async()=>({goto:async url=>{visited.push(url);return {status:()=>200};},url:()=>args.origin+'/userdetails.php?id=7',locator:()=>({innerText:async()=> '今日已签到'}),close:async()=>{}}),close:async()=>{}})});
  assert.equal(generic.status,'already_signed');
  assert.equal(generic.evidence.authoritative,true);
  assert.equal(generic.submissionAttempted,false);
});

test('passive firewall allows only one reviewed main-document GET, not action GET or POST',async()=>{
  const policy=ptReadPolicy('https://open.cd'),allowed=[],blocked=[];let handler;
  await installPtReadFirewall({route:async(_pattern,fn)=>{handler=fn;}},policy);
  const frame={page:()=>({mainFrame:()=>frame})};
  const request=async(url,method='GET',type='document')=>handler({
    request:()=>({url:()=>url,method:()=>method,resourceType:()=>type,isNavigationRequest:()=>type==='document',frame:()=>frame}),
    fetch:async options=>{assert.equal(options.maxRedirects,0);return {status:()=>200};},
    fulfill:async()=>allowed.push(url),abort:async()=>blocked.push(url)});
  await request('https://open.cd/attendance.php');
  await request(policy.url,'POST');
  await request(policy.url,'GET','script');
  await request('https://foreign.example/');
  await request(policy.url);
  await request(policy.url);
  assert.deepEqual(allowed,[policy.url]);assert.equal(blocked.length,5);
  for(const url of ['https://pt.example/attendance.php','https://pt.example/userdetails.php?action=sign','https://other.example/index.php']){
    assert.throws(()=>ptReadPolicy('https://pt.example',{ptReadOnlyPolicies:{'https://pt.example':{reviewed:true,mode:'safe_history_page',selector:'#status',url}}}),e=>e.code==='PT_READONLY_UNSAFE');
  }
});

test('slow receipt is sampled after completion; future and wrong-day evidence cannot confirm',async t=>{
  const args=fixture(t),finished=new Date(args.now.getTime()+8*60_000);let current=args.now;
  const result=await runPtSupplement({...args,clock:()=>current,readReward:async()=>null,
    acquire:async()=>({}),release:async()=>{},launch:async()=>({close:async()=>{}}),
    runTarget:async()=>{current=finished;return {status:'signed',submissionAttempted:true,evidence:{source:'page_text',authoritative:true,confirmedAt:finished.toISOString(),businessDate:'2026-09-20'}};}});
  assert.equal(result.status,'signed');assert.equal(result.observedAt,finished.toISOString());assert.equal(result.submissionAttempted,true);
  assert.match(result.profileBinding,/^[a-f0-9]{64}$/);
  for(const evidence of [{confirmedAt:new Date(finished.getTime()+120_000).toISOString()},{confirmedAt:finished.toISOString(),businessDate:'2026-09-19'}]){
    assert.equal(publicSupplementResult(args.origin,{status:'signed',evidence:{source:'page_text',authoritative:true,...evidence}},finished).status,'unknown');
  }
});

test('single PT account reuses its configured isolated profile without copying browser state',async t=>{
  const args=fixture(t),config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  const isolated=path.join(args.root,'data/isolated');
  config.isolatedOAuthSiteProfiles={[args.origin]:isolated};
  const binding=ptExecutionBinding(config,args.root,{origin:args.origin,accountKey:'site-default'});
  assert.equal(binding.profile,isolated);
  assert.throws(()=>ptExecutionBinding({...config,oauthSiteSessionBindings:{[args.origin]:'missing'}},args.root,{origin:args.origin}),/conflicting/);
});

test('unreviewed PT attendance pages cannot be treated as read-only',async t=>{
  const args=fixture(t),never=async()=>{throw Error('browser must not launch');};
  await assert.rejects(()=>runPtSupplement({...args,readOnly:true,launch:never}),error=>error.code==='PT_READONLY_UNSAFE');
});

test('native passive binding accepts only the reviewed www alias, never an unrelated host',()=>{
  const config={mainChromeFallbackUrls:['https://www.audiences.me/attendance.php']};
  assert.equal(ptReadPolicy('https://audiences.me',config).nativeMainChrome,true);
  assert.throws(()=>ptReadPolicy('https://other.audiences.me',config),e=>e.code==='PT_READONLY_UNSAFE');
});

test('configured native PT evidence repair binds the main profile and never launches a submit runner',async t=>{
  const args=fixture(t),origin='https://ourbits.club',sourceRoot=path.join(args.root,'main-browser');
  fs.mkdirSync(path.join(sourceRoot,'Default'),{recursive:true});fs.writeFileSync(path.join(sourceRoot,'Local State'),'fixture');
  const file=path.join(args.root,'config/config.json'),config=JSON.parse(fs.readFileSync(file));
  Object.assign(config,{sourceUserDataDir:sourceRoot,bookmarksPath:path.join(sourceRoot,'Default/Bookmarks'),mainChromeFallbackUrls:[origin+'/attendance.php']});
  config.ptReadOnlyPolicies={[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',nativeMainChrome:true}};
  fs.writeFileSync(file,JSON.stringify(config));
  fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const result=await runPtSupplement({...args,origin,catalogHash,readOnly:true,
    launch:async()=>{throw Error('CDP browser must not launch');},runTarget:async()=>{throw Error('must not submit');},
    inspectNative:async request=>{assert.equal(request.url,origin+'/index.php');return {status:'already_signed',submissionAttempted:false,
      evidence:{source:'page_text',authoritative:true,confirmedAt:args.now.toISOString(),businessDate:'2026-09-20',statusSignal:'nexus_daily_header_signed',pagePath:'/index.php'}};}});
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  assert.equal(result.evidence.evidenceScope,'site_account_day');assert.match(result.profileBinding,/^[a-f0-9]{64}$/);
});

test('unverified completion and uncertain submission are never reported as success',()=>{
  const now=new Date('2026-09-20T02:00:00Z');
  assert.equal(publicSupplementResult('https://pt.example',{status:'signed'},now).status,'unknown');
  assert.equal(publicSupplementResult('https://pt.example',{status:'signed',evidence:{source:'page_text',authoritative:true,confirmedAt:'2026-09-19T02:00:00Z'}},now).status,'unknown');
  const uncertain=publicSupplementResult('https://pt.example',{status:'needs_attention',failureCode:'submission_outcome_unknown'},now);
  assert.equal(uncertain.status,'needs_attention');assert.equal(uncertain.submissionOutcomeUnknown,true);
});

test('diagnostics preserve actionable safe codes but never raw page errors',()=>{
  const result=publicSupplementResult('https://pt.example',{status:'deferred',retryCause:'upstream_unavailable',
    reason:'private cookie=do-not-export',submissionAttempted:false});
  assert.equal(result.failureCode,'upstream_unavailable');assert.equal(result.retryCause,'upstream_unavailable');
  assert.equal(result.submissionAttempted,false);assert.doesNotMatch(JSON.stringify(result),/private|cookie|do-not-export/);
  const maintenance=publicSupplementResult('https://pt.example',{status:'needs_attention',failureCode:'submission_outcome_unknown',
    siteCondition:'site_maintenance',submissionAttempted:true});
  assert.equal(maintenance.submissionOutcomeUnknown,true);assert.equal(maintenance.siteCondition,'site_maintenance');
  assert.match(maintenance.evidence.summary,/维护/);
});

test('reviewed daily header needs a logged-in exact control; forum text cannot authorize recovery',()=>{
  const origin='https://u2.dmhy.org',policy=ptReadPolicy(origin),now=new Date('2026-09-30T05:00:00Z');
  const args={origin,policy,url:policy.url,now,bodyText:'立即簽到',authenticated:true,
    controls:[{path:'/showup.php',text:'立即簽到'}]};
  const result=classifyPtPassivePage(args);
  assert.equal(result.status,'not_signed');assert.equal(result.evidence.statusSignal,'nexus_daily_header_unsigned');
  for(const invalid of [{authenticated:false},{controls:[]},{url:origin+'/forums.php'},
    {controls:[{path:'/showup.php',text:'立即簽到'},{path:'/showup.php',text:'已簽到'}]}])
    assert.equal(classifyPtPassivePage({...args,...invalid}).status,'unknown');
  assert.equal(classifyPtPassivePage({...args,controls:[{path:'/showup.php',text:'已簽到'}]}).status,'already_signed');
  const cspt='https://cspt.top',csptPolicy=ptReadPolicy(cspt);
  const reward={...args,origin:cspt,url:csptPolicy.url,policy:csptPolicy,bodyText:'签到已得1155',controls:[{path:'/attendance.php',text:'[签到已得1155]'}]};
  assert.equal(classifyPtPassivePage(reward).status,'already_signed');
  assert.equal(classifyPtPassivePage({...reward,controls:[]}).status,'unknown');
  const star='https://pt.xingyungept.org',starPolicy=ptReadPolicy(star);
  assert.equal(classifyPtPassivePage({...reward,origin:star,url:starPolicy.url,policy:starPolicy,
    controls:[{path:'/attendance.php',text:'[签到已得70, 补签卡: 9]'}]}).status,'already_signed');
});

test('maintenance observation uses an unauthenticated GET and cannot establish account completion',async()=>{
  const origin='https://ptsbao.club';
  const result=await readPtPublicAvailability(origin,ptReadPolicy(origin),{fetchPage:async(url,options)=>{
    assert.equal(url,origin+'/claim/');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'manual');
    assert.equal(options.method,'GET');assert.equal(options.headers,undefined);
    return {status:200,text:async()=>'<h1>维护通知</h1>站点处于全量数据恢复与测试阶段,暂时无法访问。'};
  }});
  assert.equal(result.failureCode,'site_maintenance');assert.equal(result.evidence.authoritative,false);
});

test('maintenance read uses the reviewed proxy in a fresh cookie-free request context',async()=>{
  const origin='https://ptsbao.club',policy={...ptReadPolicy(origin),proxyServer:'http://127.0.0.1:7890'};
  let requests=0,disposed=0;
  const result=await readPtPublicAvailability(origin,policy,{createRequest:async options=>{
    assert.deepEqual(options,{proxy:{server:'http://127.0.0.1:7890'},ignoreHTTPSErrors:false});
    return {get:async(url,options)=>{
      requests++;assert.equal(url,origin+'/claim/');
      assert.deepEqual(options,{maxRedirects:0,maxRetries:0,timeout:8000,ignoreHTTPSErrors:false});
      return {status:()=>200,text:async()=>'<h1>维护通知</h1>站点目前处于全量数据恢复与测试阶段，暂时无法访问。'};
    },dispose:async()=>{disposed++;}};
  }});
  assert.equal(result.failureCode,'site_maintenance');
  assert.equal(result.siteCondition,'site_maintenance');
  assert.equal(result.evidence.authoritative,false);
  assert.equal(requests,1);assert.equal(disposed,1);
});

test('public maintenance redirects and transport errors cannot certify an outage or leak a request context',async()=>{
  const origin='https://ptsbao.club',policy={...ptReadPolicy(origin),proxyServer:'http://127.0.0.1:7890'};
  for(const status of [302,403,500,'network']){
    let disposed=0;
    const result=await readPtPublicAvailability(origin,policy,{createRequest:async()=>({
      get:async()=>{if(status==='network')throw Error('network unavailable');return {status:()=>status};},
      dispose:async()=>{disposed++;},
    })});
    assert.equal(result,null);assert.equal(disposed,1);
  }
});

test('maintenance proxy validation refuses credentials and external routes before creating a client',async()=>{
  const origin='https://ptsbao.club';let created=0;
  for(const proxyServer of ['http://external.example:7890','http://user:pass@127.0.0.1:7890']){
    const result=await readPtPublicAvailability(origin,{...ptReadPolicy(origin),proxyServer},{createRequest:async()=>{created++;}});
    assert.equal(result,null);
  }
  assert.equal(created,0);
});

test('same-origin login redirects report auth loss without trusting foreign pages or HTTP errors',()=>{
  const origin='https://ptsbao.club',policy=ptReadPolicy(origin);
  const args={origin,policy,url:origin+'/login.php',bodyText:''};
  assert.equal(classifyPtPassivePage(args).status,'login_required');
  assert.equal(classifyPtPassivePage({...args,url:'https://other.example/login.php'}).status,'unknown');
  assert.equal(classifyPtPassivePage({...args,httpStatus:503}).status,'unknown');
});

test('current SaoBao account state precedes stale public notices and failed navigation cannot certify success',async t=>{
  const args=fixture(t),origin='https://ptsbao.club';
  fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  for(const state of [
    {url:origin+'/index.php',text:'[签到已得3000, 补签卡: 0]',authenticated:true,expected:'already_signed'},
    {url:origin+'/index.php',text:'签到',authenticated:true,expected:'not_signed'},
    {url:origin+'/login.php',text:'',authenticated:false,expected:'login_required'},
    {url:origin+'/index.php',text:'',authenticated:false,expected:'needs_attention',fallback:true},
    {url:origin+'/index.php',text:'[签到已得3000, 补签卡: 0]',authenticated:true,expected:'needs_attention',fallback:true,failed:true}
  ]){
    let fallbackCalls=0;
    const result=await runPtSupplement({...args,origin,catalogHash,readOnly:true,
      launch:async config=>{assert.equal(config.ptPassiveReadOnly,true);return {route:async()=>{},newPage:async()=>({
        goto:async()=>{if(state.failed)throw Error('navigation failed');return {status:()=>200};},url:()=>state.url,
        locator:selector=>({innerText:async()=>state.text,evaluateAll:async()=>selector==='a'?state.authenticated:
          [{path:'/attendance.php',text:state.text}]}),close:async()=>{}}),close:async()=>{}};},
      readAvailability:async()=>{fallbackCalls++;return {status:'needs_attention',failureCode:'site_maintenance',
        siteCondition:'site_maintenance',retryCause:'upstream_unavailable',evidence:{source:'page_text',authoritative:false}};},
      readReward:async()=>{throw Error('must not browse reward or attendance pages');},
      runTarget:async()=>{throw Error('must not submit');}});
    assert.equal(result.status,state.expected);
    assert.equal(result.submissionAttempted,false);
    assert.equal(fallbackCalls,state.fallback?1:0);
    assert.equal(result.evidence.authoritative,['already_signed','not_signed'].includes(state.expected));
  }
});

test('guarded recovery repeats the passive read and never submits when state changed to signed',async t=>{
  const args=fixture(t),origin='https://open.cd';
  fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/index.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const result=await runPtSupplement({...args,origin,catalogHash,verifyBeforeSubmit:true,
    launch:async c=>{assert.equal(c.ptPassiveReadOnly,true);return {route:async()=>{},newPage:async()=>({
      goto:async()=>({status:()=>200}),url:()=>origin+'/index.php',locator:()=>({innerText:async()=> '今日已签到'}),close:async()=>{}}),close:async()=>{}};},
    runTarget:async()=>{throw Error('must never repeat a completed check-in');}});
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
});

test('guarded recovery permits one registered daily supplement only after passive not-signed',async t=>{
  const args=fixture(t),origin='https://dstudio.me',now=new Date('2026-10-06T04:00:00Z');
  fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[{origin}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  let launches=0,submissions=0;
  const result=await runPtSupplement({...args,origin,catalogHash,now,verifyBeforeSubmit:true,
    launch:async config=>{launches++;assert.equal(config.ptPassiveReadOnly,launches===1);return {
      route:async()=>{},
      newPage:async()=>({goto:async()=>({status:()=>200}),url:()=>origin+'/index.php',locator:selector=>({
        innerText:async()=> '欢迎回来，wushuai0802',
        evaluateAll:async()=>selector==='a'?true:[{path:'/attendance.php',text:'待签到'}],
      }),close:async()=>{}}),close:async()=>{}};},
    readReward:async()=>null,
    runTarget:async(_context,_target,config)=>{assert.equal(config.ptFallbackRecheck,true);submissions++;return {status:'signed',submissionAttempted:true,evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-06'}};},
  });
  assert.equal(result.status,'signed');assert.equal(result.evidence.authoritative,true);assert.equal(launches,2);assert.equal(submissions,1);
});

test('AGSV reviewed daily reward permits the observed space before a supplemental card count',()=>{
  const origin='https://www.agsvpt.com',policy={reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',
    dailyHeader:true,actionPath:'/attendance.php',unsignedText:'签到得冰晶',signedRewardControl:true};
  const base={origin,url:policy.url,policy,authenticated:true,bodyText:'本人账户栏',now:new Date(),accountId:'7'};
  for(const text of ['签到已得300 补签卡: 0','签到已得300, 补签卡: 0','签到已得300']){
    const value=classifyPtPassivePage({...base,controls:[{path:'/attendance.php',text}]});
    assert.equal(value.status,'already_signed');assert.equal(value.evidence.authoritative,true);
  }
  for(const text of ['历史签到已得300 补签卡: 0','昨日签到已得300 补签卡: 0','签到已得300 补签卡: 0 说明'])
    assert.equal(classifyPtPassivePage({...base,controls:[{path:'/attendance.php',text}]}).status,'unknown');
});

test('a guarded unsigned receipt reaches the real mature browser flow instead of stopping at its second header read',async t=>{
  const args=fixture(t),origin='https://dstudio.me',now=new Date();
  const cfgFile=path.join(args.root,'config/config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile));
  Object.assign(cfg,{cloudflareWaitMs:1000,navigationTimeoutMs:2000,retryCount:0});fs.writeFileSync(cfgFile,JSON.stringify(cfg));
  fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
  const previous=process.env.CHECKIN_PT_FALLBACK_RECHECK;process.env.CHECKIN_PT_FALLBACK_RECHECK='1';
  t.after(()=>{if(previous===undefined)delete process.env.CHECKIN_PT_FALLBACK_RECHECK;else process.env.CHECKIN_PT_FALLBACK_RECHECK=previous;});
  let visits=0,signed=false;
  const value=await runPtSupplement({...args,origin,catalogHash,now,verifyBeforeSubmit:true,readReward:async()=>null,
    readPassive:async()=>({status:'not_signed',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
      confirmedAt:now.toISOString(),businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),statusSignal:'nexus_daily_header_unsigned'}}),
    launch:async config=>{
      if(config.ptPassiveReadOnly)return {route:async()=>{},newPage:async()=>({goto:async()=>({status:()=>200}),close:async()=>{}}),close:async()=>{}};
      const context=await browser.newContext();
      await context.route('**/*',async route=>{
        const url=new URL(route.request().url());if(url.origin!==origin||!['/index.php','/attendance.php'].includes(url.pathname))return route.abort();
        if(url.pathname==='/attendance.php'){visits++;signed=true;}
        const body='<a href="/usercp.php">控制面板</a><div id="info_block"><a href="/logout.php">退出</a><a href="/userdetails.php?id=7">本人</a>'+
          '<a href="/attendance.php">'+(signed?'今日已完成 已签到':'待签到')+'</a></div>'+(signed?'<p>签到成功，本次签到获得10积分</p>':'');
        return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body});
      });return context;
    }});
  assert.equal(visits,1);assert.ok(['signed','already_signed'].includes(value.status));assert.equal(value.evidence.authoritative,true);
});

test('HDDolby supplement requires a fresh account read and preserves the original runner exactly once',async t=>{
  for(const status of ['already_signed','unknown','not_signed']){
    const args=fixture(t),origin='https://www.hddolby.com';
    fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
    const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
    const launches=[];let submits=0;
    const value=await runPtSupplement({...args,origin,catalogHash,verifyBeforeSubmit:true,
      launch:async config=>{launches.push(config.ptPassiveReadOnly);return {close:async()=>{}};},
      readHddolby:async()=>({status,submissionAttempted:false,...(status==='unknown'?{}:{evidence:{
        source:'pt_page',authoritative:true,confirmedAt:args.now.toISOString(),businessDate:'2026-09-20',pagePath:'/log.php',
        statusSignal:status==='not_signed'?'hddolby_account_header_unsigned':'hddolby_account_header_signed'}})}),
      readReward:async()=>{assert.equal(status,'not_signed');return null;},
      runTarget:async()=>{submits++;return {status:'signed',submissionAttempted:true,evidence:{source:'pt_page',authoritative:true,
        confirmedAt:args.now.toISOString(),businessDate:'2026-09-20',statusSignal:'submitted_success_response'}};},
    });
    assert.deepEqual(launches,status==='not_signed'?[true,false]:[true]);
    assert.equal(submits,status==='not_signed'?1:0);
    assert.equal(value.status,status==='not_signed'?'signed':status==='already_signed'?'already_signed':'needs_attention');
  }
});

test('HHCLUB monitor login uses one helper, then proves the account/day before any mature supplement',async t=>{
  for(const variant of ['already_signed','not_signed','unknown','wrong_account','rejected','slow_already_signed']){
    const state=variant==='slow_already_signed'?'already_signed':variant;
    const args=fixture(t),origin='https://hhanclub.net';
    const cfgFile=path.join(args.root,'config/config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile));
    cfg.siteTwoFactorRecovery={[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hhclub-nexus-login-v1',expectedAccountId:'7'}};
    cfg.ptReadOnlyPolicies={[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#user-info-panel',
      dailyHeader:true,actionPath:'/attendance.php',unsignedText:'签到得憨豆',signedRewardControl:true}};
    fs.writeFileSync(cfgFile,JSON.stringify(cfg));
    fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
    const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
    const launches=[],events=[];let reads=0,helpers=0,submits=0,current=args.now;
    const value=await runPtSupplement({...args,origin,catalogHash,verifyBeforeSubmit:true,clock:()=>current,
      launch:async config=>{launches.push(config.ptPassiveReadOnly);return {route:async()=>{},close:async()=>events.push('close'),
        newPage:async()=>({goto:async()=>({status:()=>200}),close:async()=>{}})};},
      readPassive:async()=>{
        reads++;if(reads===1)return {status:'login_required',submissionAttempted:false};
        if(state==='unknown')return {status:'unknown'};
        return {status:state==='wrong_account'?'not_signed':state,submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,
          confirmedAt:current.toISOString(),businessDate:'2026-09-20',accountId:state==='wrong_account'?'8':'7',
          statusSignal:state==='not_signed'?'nexus_daily_header_unsigned':'nexus_daily_header_signed'}};
      },
      recoverLogin:async()=>{helpers++;assert.ok(events.includes('close'));if(variant==='slow_already_signed')current=new Date(current.getTime()+90_000);
        return {handled:true,status:state==='rejected'?'needs_attention':'logged_in',failureCode:state==='rejected'?'two_factor_required':undefined};},
      readReward:async()=>null,
      runTarget:async()=>{submits++;return {status:'signed',submissionAttempted:true,evidence:{source:'pt_page',authoritative:true,
        confirmedAt:args.now.toISOString(),businessDate:'2026-09-20',statusSignal:'submitted_success_response'}};},
    });
    assert.equal(helpers,1);assert.equal(submits,state==='not_signed'?1:0);
    assert.deepEqual(launches,state==='rejected'?[true]:state==='not_signed'?[true,true,false]:[true,true]);
    assert.equal(value.status,state==='not_signed'?'signed':state==='already_signed'?'already_signed':'needs_attention');
  }
});

test('HHCLUB read-only observation never opens a login helper or requests a code',async t=>{
  const args=fixture(t),origin='https://hhanclub.net',cfgFile=path.join(args.root,'config/config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile));
  cfg.siteTwoFactorRecovery={[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hhclub-nexus-login-v1',expectedAccountId:'7'}};
  cfg.ptReadOnlyPolicies={[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#user-info-panel'}};
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const value=await runPtSupplement({...args,origin,catalogHash,readOnly:true,
    launch:async()=>({route:async()=>{},close:async()=>{},newPage:async()=>({goto:async()=>({status:()=>200}),close:async()=>{}})}),
    readPassive:async()=>({status:'login_required',submissionAttempted:false}),
    recoverLogin:async()=>{throw Error('read-only must never authenticate');},
    runTarget:async()=>{throw Error('read-only must never check in');}});
  assert.equal(value.status,'login_required');assert.equal(value.submissionAttempted,false);
});

test('HHCLUB can authenticate before its audited first dispatch without inventing an unsigned receipt',async t=>{
  for(const issue of ['recover','authenticated','denied','wrong_account','lost_after_login','failed_login','changed_guard']){
    const args=fixture(t),origin='https://hhanclub.net',cfgFile=path.join(args.root,'config/config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile));
    cfg.siteTwoFactorRecovery={[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hhclub-nexus-login-v1',expectedAccountId:'7'}};
    cfg.ptReadOnlyPolicies={[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#user-info-panel'}};
    fs.writeFileSync(cfgFile,JSON.stringify(cfg));fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
    const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
    let reads=0,helpers=0,submits=0,guards=0;const events=[];
    const value=await runPtSupplement({...args,origin,catalogHash,fallbackAttemptId:'10000000-0000-4000-8000-000000000001',
      validateLoginResume:async input=>{assert.equal(input.origin,origin);guards++;return {allowed:issue!=='denied'&&!(issue==='changed_guard'&&guards>1)};},
      launch:async config=>{events.push(config.ptPassiveReadOnly?'passive':'formal');return {close:async()=>events.push('close')};},
      readLoginProfile:async()=>{
        reads++;if(issue==='authenticated')return {status:'unknown',authenticated:true,accountMatched:true,submissionAttempted:false};
        if(reads===1)return {status:'login_required',submissionAttempted:false};
        return {status:'unknown',authenticated:issue!=='lost_after_login',accountMatched:issue!=='wrong_account'&&issue!=='lost_after_login',submissionAttempted:false};
      },
      recoverLogin:async()=>{helpers++;assert.equal(events.at(-1),'close');return {handled:true,status:issue==='failed_login'?'needs_attention':'logged_in'};},
      readPassive:async()=>{throw Error('No daily state is available and none may be fabricated');},readReward:async()=>null,
      runTarget:async()=>{submits++;assert.equal(events.at(-1),'formal');return {status:'signed',submissionAttempted:true,
        evidence:{source:'page_text',authoritative:true,businessDate:'2026-09-20',confirmedAt:args.now.toISOString(),statusSignal:'submitted_success_response'}};},
    });
    const completed=['recover','authenticated'].includes(issue);
    assert.equal(submits,completed?1:0);assert.equal(value.status,completed?'signed':'needs_attention');
    assert.ok(helpers<=1);if(issue==='denied')assert.deepEqual(events,[]);
  }
});

test('a guarded retry cannot borrow the first-dispatch login path when its daily state is unknown',async t=>{
  const args=fixture(t),origin='https://hhanclub.net',cfgFile=path.join(args.root,'config/config.json'),cfg=JSON.parse(fs.readFileSync(cfgFile));
  cfg.siteTwoFactorRecovery={[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hhclub-nexus-login-v1',expectedAccountId:'7'}};
  cfg.ptReadOnlyPolicies={[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#user-info-panel'}};
  fs.writeFileSync(cfgFile,JSON.stringify(cfg));fs.writeFileSync(args.catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(args.catalogFile)).digest('hex');
  const never=async()=>{throw Error('A retry needs a real daily negative receipt');};
  const value=await runPtSupplement({...args,origin,catalogHash,verifyBeforeSubmit:true,
    fallbackAttemptId:'10000000-0000-4000-8000-000000000001',validateLoginResume:never,readLoginProfile:never,recoverLogin:never,runTarget:never,
    launch:async()=>({route:async()=>{},close:async()=>{},newPage:async()=>({goto:async()=>({status:()=>200}),close:async()=>{}})}),
    readPassive:async()=>({status:'unknown',submissionAttempted:false})});
  assert.equal(value.status,'needs_attention');assert.equal(value.submissionAttempted,false);
});

test('catalog changes, daily owner and explicit disable stop before a browser launch',async t=>{
  const args=fixture(t),never=async()=>{throw Error('browser must not launch');};
  await assert.rejects(()=>runPtSupplement({...args,catalogHash:'0'.repeat(64),launch:never}),/changed/);
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[{origin:args.origin}]}));
  await assert.rejects(()=>runPtSupplement({...args,launch:never}),/daily plan/);
  fs.writeFileSync(path.join(args.root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[]}));
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  config.excludedOrigins=[args.origin];fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify(config));
  await assert.rejects(()=>runPtSupplement({...args,launch:never}),/disabled/);
});
