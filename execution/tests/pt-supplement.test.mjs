import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ptSupplementTarget,publicSupplementResult,runPtSupplement,ptRewardCounter} from '../src/pt-supplement.mjs';
import {ptPageEvidence} from '../src/browser.mjs';
import {ptReadPolicy,installPtReadFirewall,ptExecutionBinding,classifyPtPassivePage,readPtPublicAvailability} from '../src/pt-read-policy.mjs';

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
    launch:async config=>{assert.equal(config.ptPassiveReadOnly,true);return {route:async()=>{},newPage:async()=>({goto:async url=>{visited.push(url);},url:()=>origin+'/index.php',locator:()=>({innerText:async()=>body}),close:async()=>{}}),close:async()=>{}};},
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
    launch:async()=>({route:async()=>{},newPage:async()=>({goto:async url=>{visited.push(url);},url:()=>args.origin+'/userdetails.php?id=7',locator:()=>({innerText:async()=> '今日已签到'}),close:async()=>{}}),close:async()=>{}})});
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
    continue:async()=>allowed.push(url),abort:async()=>blocked.push(url)});
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

test('configured native PT evidence repair binds the main profile and never launches a submit runner',async t=>{
  const args=fixture(t),origin='https://ourbits.club',sourceRoot=path.join(args.root,'main-browser');
  fs.mkdirSync(path.join(sourceRoot,'Default'),{recursive:true});fs.writeFileSync(path.join(sourceRoot,'Local State'),'fixture');
  const file=path.join(args.root,'config/config.json'),config=JSON.parse(fs.readFileSync(file));
  Object.assign(config,{sourceUserDataDir:sourceRoot,bookmarksPath:path.join(sourceRoot,'Default/Bookmarks'),mainChromeFallbackUrls:[origin+'/attendance.php']});
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
