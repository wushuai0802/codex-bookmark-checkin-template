import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planHarvestFallback,runHarvestFallback,pendingHarvestFallbackAttempts,reviewedFallbackReadOrigins,resolvedFallbackReadConfig} from '../src/harvest-fallback.mjs';

const now=new Date('2026-09-20T02:00:00Z');
const failed=(origin,account='7')=>({origin,userId:account,status:'failed',observedAt:'2026-09-20T09:55:00+08:00',evidence:{source:'harvest',authoritative:false}});
const fixture=()=>({
  now,clock:()=>now,fallbackOnlyEnabled:true,harvest:{source:'harvest',businessDate:'2026-09-20',generatedAt:'2026-09-20T09:58:00+08:00',sites:[
    failed('https://ourbits.club'),failed('https://external.example'),{origin:'https://signed.example',status:'signed',observedAt:'2026-09-20T09:55:00+08:00',evidence:{authoritative:true}},
    {origin:'https://uncertain.example',userId:'7',status:'unknown',observedAt:null}
  ],taskCompletion:{resultId:5,status:'completed',startedAt:'2026-09-20T09:14:00+08:00',completedAt:'2026-09-20T09:16:00+08:00'}},catalog:{sites:[{origin:'https://ourbits.club'},{origin:'https://external.example',entryUrl:'https://external.example/attendance'},{origin:'https://signed.example',entryUrl:'https://signed.example/'}]},
  plan:{targets:[{origin:'https://ourbits.club',folderNames:['PT白名单']}]},latest:{runId:'20260920-fixture',runState:'final',isComplete:true,results:[{origin:'https://ourbits.club',status:'deferred'}]}
});

test('reviewed HDDolby account header readers enter the passive scheduler independently of the Nexus dailyHeader flag',()=>{
  const origins=['https://www.hddolby.com','https://nexus.example','https://unreviewed.example','https://unsupported.example'];
  const catalog={sites:origins.map(origin=>({origin}))};
  const policies=[{reviewed:true,mode:'safe_history_page',hddolbyHeader:true},
    {reviewed:true,mode:'safe_history_page',dailyHeader:true},{mode:'safe_history_page',dailyHeader:true},
    {reviewed:true,mode:'safe_history_page'}];
  assert.deepEqual(reviewedFallbackReadOrigins(catalog,origin=>policies[origins.indexOf(origin)]),origins.slice(0,2));
});

test('new-domain HDDolby login recovery is opt-in and authentication-only; an already-signed receipt never submits again',async t=>{
  for(const variant of ['new','unsubmitted-login','unknown-submit','disabled']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-auth-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));configureUnifiedFixture(root);
    const f=fixture(),origin='https://www.uhddolby.com';
    f.harvest.sites=[failed(origin)];f.catalog.sites=[{origin,entryUrl:origin+'/attendance.php'}];f.plan.targets=[];f.latest.results=[];
    const config={siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hddolby-nexus-stepup-v1',allowPasswordLogin:variant!=='disabled'}}};
    if(variant==='unsubmitted-login'||variant==='unknown-submit'){
      fs.mkdirSync(root+'/outputs',{recursive:true});
      fs.writeFileSync(root+'/outputs/harvest-fallback-attempts-2026-09-20.json',JSON.stringify({schemaVersion:1,businessDate:'2026-09-20',attempts:[{
        origin,accountKey:'site-default',businessDate:'2026-09-20',state:'completed',submissionState:variant==='unknown-submit'?'unknown':'not_submitted',
        startedAt:'2026-09-20T01:00:00Z',finishedAt:'2026-09-20T01:01:00Z',v1Status:'login_required',
        outcome:{origin,status:'login_required',submissionAttempted:variant==='unknown-submit'}
      }]}));
    }
    const calls=[];const result=await runHarvestFallback({...f,root,config,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),readOnlyOrigins:[origin],
      runSite:async options=>{
        calls.push(options.readOnly?'read':'recover');
        if(!options.readOnly)assert.equal(options.loginRecoveryOnly,true);
        return {origin,status:options.readOnly?'login_required':'already_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',
          profileBinding:'b'.repeat(64),accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
          evidence:{source:options.readOnly?'none':'pt_page',authoritative:!options.readOnly,businessDate:'2026-09-20',confirmedAt:now.toISOString(),
            evidenceScope:'site_account_day',pagePath:'/log.php',statusSignal:'hddolby_account_header_signed'}};
      }});
    assert.deepEqual(calls,variant==='disabled'?['read']:['read','recover'],variant);
    if(calls.length===2)assert.equal(result.outcomes.at(-1).v1Status,'already_signed');
  }
});

test('an older ambiguous new-domain attempt needs fresh exact-Profile negative proof, with or without login recovery',async t=>{
  for(const variant of ['authentication-needed','native-ready','wrong-binding','stale-proof']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-post-login-proof-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));configureUnifiedFixture(root);
  const f=fixture(),origin='https://www.uhddolby.com',binding='b'.repeat(64);
  f.harvest.sites=[failed(origin)];f.catalog.sites=[{origin,entryUrl:origin+'/attendance.php'}];f.plan.targets=[];f.latest.results=[];
  fs.mkdirSync(root+'/outputs',{recursive:true});
  const earlier={origin,accountKey:'site-default',businessDate:'2026-09-20',state:'completed',startedAt:'2026-09-20T01:00:00Z',finishedAt:'2026-09-20T01:01:00Z',
    outcome:{origin,profileBinding:binding,submissionAttempted:true,failureCode:'submission_outcome_unknown'}};
  fs.writeFileSync(root+'/outputs/harvest-fallback-attempts-2026-09-20.json',JSON.stringify({schemaVersion:1,businessDate:'2026-09-20',attempts:[earlier]}));
  const config={siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:'hddolby-nexus-stepup-v1',allowPasswordLogin:true}}};
  const calls=[];
  await runHarvestFallback({...f,root,config,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),readOnlyOrigins:[origin],runSite:async options=>{
    calls.push(options.readOnly?'read':options.loginRecoveryOnly?'authenticate':'supplement');
    if(!options.readOnly&&!options.loginRecoveryOnly)assert.equal(options.verifyBeforeSubmit,true);
    const login=options.readOnly&&variant==='authentication-needed',submit=!options.readOnly&&!options.loginRecoveryOnly;
    return {origin,status:login?'login_required':submit?'signed':'not_signed',
      observedAt:now.toISOString(),businessDate:'2026-09-20',accountKey:'site-default',profileBinding:variant==='wrong-binding'?'c'.repeat(64):binding,
      operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:!options.readOnly&&!options.loginRecoveryOnly,
      evidence:{source:login?'none':'pt_page',authoritative:!login,businessDate:'2026-09-20',
        confirmedAt:variant==='stale-proof'?new Date(now.getTime()-31_000).toISOString():now.toISOString(),
        evidenceScope:'site_account_day',pagePath:'/log.php',statusSignal:submit?'hddolby_account_header_signed':'hddolby_account_header_unsigned'}};
  }});
  assert.deepEqual(calls,variant==='authentication-needed'?['read','authenticate','supplement']:variant==='native-ready'?['read','supplement']:['read']);
  const state=JSON.parse(fs.readFileSync(root+'/outputs/harvest-fallback-attempts-2026-09-20.json'));
  assert.equal(state.attempts[0].outcome.failureCode,'submission_outcome_unknown');
  if(state.attempts.length>1)assert.equal(state.attempts[1].recoveryEvidence.evidence.statusSignal,'hddolby_account_header_unsigned');
  }
});

test('a built-in native read policy dispatches guarded recovery through the original engine without duplicating private policy',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-default-policy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture(),origin='https://ourbits.club';f.harvest.sites=f.harvest.sites.slice(0,1);f.catalog.sites=f.catalog.sites.slice(0,1);
  f.latest.results=[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
  const privateConfig={disabledCheckinOrigins:['https://paused.example']},before=JSON.stringify(privateConfig);
  const config=resolvedFallbackReadConfig(f.catalog,privateConfig,()=>({reviewed:true,mode:'safe_history_page',url:origin+'/index.php',nativeMainChrome:true}));
  assert.equal(JSON.stringify(privateConfig),before);assert.equal(config.ptReadOnlyPolicies[origin].nativeMainChrome,true);
  const passive={origin,status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),
    accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:now.toISOString(),evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};
  const calls=[];
  await runHarvestFallback({...f,root,config,execute:true,
    runSite:async options=>{assert.equal(options.readOnly,true);calls.push('read');return passive;},
    runEngine:async options=>{calls.push('original-engine');assert.deepEqual(options.origins,[origin]);assert.equal(options.fallbackRecheck,true);
      return {businessDate:'2026-09-20',observedAt:now.toISOString(),results:[{...passive,status:'signed',submissionAttempted:true}]};}});
  assert.deepEqual(calls,['read','original-engine']);
  assert.equal(JSON.parse(fs.readFileSync(root+'/outputs/harvest-fallback-attempts-2026-09-20.json')).attempts[0].nativeRegisteredEngine,true);
});

test('historical HDDolby uncertainty permits a passive read and only its fresh bound log-header negative proof permits one guarded supplement',async t=>{
  for(const variant of ['valid','old-proof','wrong-path','foreign-signal','already-signed']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-hddolby-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    configureUnifiedFixture(root);
    const f=fixture(),origin='https://www.hddolby.com';f.harvest.sites=[failed(origin)];
    f.catalog.sites=[{origin,entryUrl:origin+'/attendance.php'}];f.plan.targets=[];f.latest.results=[];
    fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
    const oldFile=path.join(root,'outputs/harvest-fallback-attempts-2026-09-19.json');
    fs.writeFileSync(oldFile,JSON.stringify({businessDate:'2026-09-19',attempts:[{origin,state:'outcome_unknown',startedAt:'2026-09-19T01:00:00Z'}]}));
    const original=fs.readFileSync(oldFile,'utf8'),at=new Date(now.getTime()-(variant==='old-proof'?31_000:0));
    const passive={origin,status:variant==='already-signed'?'already_signed':'not_signed',observedAt:at.toISOString(),businessDate:'2026-09-20',
      profileBinding:'b'.repeat(64),accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
      evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:at.toISOString(),evidenceScope:'site_account_day',
        pagePath:variant==='wrong-path'?'/index.php':'/log.php',statusSignal:variant==='already-signed'?'hddolby_account_header_signed':
          variant==='foreign-signal'?'other_header_unsigned':'hddolby_account_header_unsigned'}};
    const calls=[],readOnlyOrigins=reviewedFallbackReadOrigins(f.catalog,()=>({reviewed:true,mode:'safe_history_page',hddolbyHeader:true}));
    const preview=planHarvestFallback({...f,readOnlyOrigins});
    assert.equal(pendingHarvestFallbackAttempts(root,preview,{now,readOnlyOrigins}).length,1);
    await runHarvestFallback({...f,root,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),readOnlyOrigins,
      runSite:async options=>{calls.push(options.readOnly?'read':options.verifyBeforeSubmit?'guarded':'unguarded');
        return options.readOnly?passive:{...passive,status:'signed',submissionAttempted:true,operationMode:'legacy_checkin',readSafety:'attendance_page_risk'};}});
    assert.deepEqual(calls,variant==='valid'?['read','guarded']:['read'],variant);
    assert.equal(fs.readFileSync(oldFile,'utf8'),original);
  }
});

test('a current execution or supplement migration stops fallback without clearing its unknown submit',()=>{
  const origin='https://ourbits.club';
  for(const code of ['site_migration','bookmark_origin_changed'])for(const source of ['execution','supplement']){
    const f=fixture(),diagnostic={origin,accountKey:'site-default',status:'needs_attention',failureCode:'submission_outcome_unknown',
      underlyingFailureCode:code,submissionAttempted:true,observedAt:now.toISOString(),evidence:{authoritative:false}};
    if(source==='execution')f.latest.results=[diagnostic];
    else f.fallbackReport={source:'execution-supplement',businessDate:'2026-09-20',sites:[diagnostic]};
    const result=planHarvestFallback(f);
    assert.equal(result.eligible.some(item=>item.origin===origin),false);
    assert.equal(result.blocked.find(item=>item.origin===origin).external,true);
    assert.equal(diagnostic.failureCode,'submission_outcome_unknown');assert.equal(diagnostic.submissionAttempted,true);
  }
});

test('registered PT sites are eligible while Harvest is pending; managed fallback-only sites remain gated',()=>{
  const f=fixture();f.harvest.checkinInventoryComplete=true;f.harvest.taskCompletion=null;
  f.harvest.sites=f.harvest.sites.filter(site=>site.origin!=='https://external.example')
    .map(site=>({...site,checkinEnabled:site.origin!=='https://ourbits.club'}));
  const result=planHarvestFallback(f);
  assert.deepEqual(result.eligible.map(site=>site.origin),['https://ourbits.club','https://external.example']);
  assert.deepEqual(result.eligible.map(site=>site.trigger),['harvest_status_unconfirmed','monitored_pt_status_unobserved']);
  f.harvest.sites[0].checkinEnabled=true;
  const managed=planHarvestFallback(f);
  assert.deepEqual(managed.eligible.map(site=>site.origin),['https://ourbits.club','https://external.example']);
  assert.equal(managed.eligible[0].trigger,'harvest_status_unconfirmed');
});

test('catalog-only observations never become a generic Harvest waiting task',()=>{
  const f=fixture();
  f.plan.targets=[];
  f.catalog.sites=[{origin:'https://external.example',entryUrl:'https://external.example/attendance'}];
  f.harvest.sites=[{origin:'https://external.example',checkinEnabled:true,status:'pending',observedAt:null,evidence:{authoritative:false}}];
  f.harvest.taskCompletion=null;
  const monitor=planHarvestFallback({...f,fallbackOnlyEnabled:false});
  assert.equal(monitor.eligible.length,0);
  assert.equal(monitor.blocked[0].reason,'monitor_only_unconfirmed');
  const optedIn=planHarvestFallback({...f,fallbackOnlyEnabled:true});
  assert.equal(optedIn.eligible.length,0);
  assert.equal(optedIn.blocked[0].reason,'fallback_only_reader_unreviewed');
});

test('authorized fallback-only PT releases Harvest pending only for a fresh passive proof',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-fallback-guarded-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture(),origin='https://external.example';
  f.harvest.sites=[{origin,status:'pending',checkinEnabled:true,observedAt:null,evidence:{authoritative:false}}];
  f.harvest.taskCompletion=null;f.catalog.sites=[{origin,entryUrl:origin+'/attendance'}];f.plan.targets=[];f.latest.results=[];
  const preview=planHarvestFallback({...f,readOnlyOrigins:[origin]});
  assert.equal(preview.blocked.length,0);
  assert.deepEqual(preview.eligible.map(item=>({origin:item.origin,kind:item.kind,guardedSubmit:item.guardedSubmit,readOnlyReview:item.readOnlyReview})),[
    {origin,kind:'fallback_only',guardedSubmit:true,readOnlyReview:true},
  ]);
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  const calls=[];
  const passive={origin,status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),
    accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:now.toISOString(),evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,readOnlyOrigins:[origin],
    runSite:async options=>{calls.push(options.readOnly?'read':'guarded');return options.readOnly?passive:{origin,status:'signed',observedAt:now.toISOString(),businessDate:'2026-09-20',submissionAttempted:true,evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-20'}};}});
  assert.deepEqual(calls,['read','guarded']);
  assert.equal(result.outcomes[0].state,'completed');
  const repeated=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,readOnlyOrigins:[origin],runSite:async()=>{throw Error('same proof must not replay');}});
  assert.equal(repeated.outcomes[0].state,'already_confirmed');
});

test('canonical aliases are accepted for reviewed fallback-only scope and single-origin selection',()=>{
  const f=fixture();
  f.harvest.taskCompletion=null;
  f.harvest.sites=[{origin:'https://www.open.cd',status:'pending',checkinEnabled:true,observedAt:null,evidence:{authoritative:false}}];
  f.catalog.sites=[{origin:'https://www.open.cd',entryUrl:'https://open.cd/attendance'}];f.plan.targets=[];f.latest.results=[];
  const result=planHarvestFallback({...f,readOnlyOrigins:['https://open.cd']});
  assert.equal(result.eligible[0].origin,'https://open.cd');
  assert.equal(result.eligible[0].readOnlyReview,true);
});

test('independent PT recheck ignores unrelated Harvest completion changes but respects assignment changes',async t=>{
  for(const switched of [false,true]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-owner-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    configureUnifiedFixture(root);
    const f=fixture();f.harvest.checkinInventoryComplete=true;f.harvest.taskCompletion=null;
    f.harvest.sites=[{...failed('https://ourbits.club'),checkinEnabled:false}];f.catalog.sites=f.catalog.sites.slice(0,1);
    let calls=0;
    const result=await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:['https://ourbits.club'],refreshHarvest:async()=>({...f.harvest,
      sites:[{...f.harvest.sites[0],checkinEnabled:switched}],taskCompletion:switched?null:fixture().harvest.taskCompletion}),
      runSite:async input=>{
        calls++;
        if(input.readOnly)return {origin:'https://ourbits.club',accountKey:'site-default',status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-20',evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};
        return {origin:'https://ourbits.club',status:'already_signed',observedAt:now.toISOString(),evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString()}};
      }
    });
    assert.equal(calls,switched?0:2);
    assert.equal(result.outcomes[0].state,switched?'harvest_assignment_changed':'completed');
  }
});

test('OpenCD alias success joins the canonical site and never creates a duplicate fallback',()=>{
  const f=fixture();f.catalog.sites=[{origin:'https://open.cd'}];f.plan.targets=[{origin:'https://open.cd'}];
  f.latest.results=[{origin:'https://open.cd',status:'deferred'}];
  f.harvest.checkinInventoryComplete=true;f.harvest.taskCompletion=null;
  f.harvest.sites=[{origin:'https://www.open.cd',checkinEnabled:true,status:'signed',
    observedAt:now.toISOString(),evidence:{authoritative:true}}];
  const result=planHarvestFallback(f);assert.equal(result.observedSuccess,1);assert.equal(result.eligible.length,0);
  f.harvest.sites.push({...f.harvest.sites[0],origin:'https://open.cd'});
  const ambiguous=planHarvestFallback(f);assert.equal(ambiguous.observedSuccess,0);assert.equal(ambiguous.eligible.length,0);
});

test('site-bound PT fallback includes monitored sites outside the daily plan',()=>{
  const report=planHarvestFallback(fixture());
  assert.deepEqual(report.eligible.map(item=>item.origin),['https://ourbits.club','https://external.example']);
  assert.equal(report.eligible[1].kind,'fallback_only');
  assert.equal(report.eligible[1].entryUrl,'https://external.example/attendance');
  assert.equal(report.fallbackOnlyCount,2);
  assert.equal(report.observedSuccess,1);
  assert.deepEqual(report.blocked.map(item=>item.reason),['outside_confirmed_bookmark_scope']);
});

test('a monitored PT target keeps its execution result even when its execution folder is not named PT',()=>{
  const f=fixture();
  f.plan.targets=[{origin:'https://external.example',folderNames:['公益站']}];
  f.harvest.sites=[failed('https://external.example')];
  f.catalog.sites=f.catalog.sites.filter(site=>site.origin==='https://external.example');
  const report=planHarvestFallback(f);
  assert.equal(report.registeredCount,1);
  assert.equal(report.eligible[0].kind,'registered_review');
  assert.equal(report.eligible[0].guardedSubmit,true);
  assert.equal(report.eligible[0].origin,'https://external.example');
});

test('a dated authoritative read-only supplement prevents the same monitored origin entering fallback',()=>{
  const f=fixture();f.harvest.sites=[failed('https://external.example')];
  f.catalog.sites=f.catalog.sites.filter(site=>site.origin==='https://external.example');
  f.plan.targets=[{origin:'https://external.example',folderNames:['公益站']}];
  f.fallbackReport={source:'execution-supplement',businessDate:'2026-09-20',sites:[{
    origin:'https://external.example',status:'already_signed',observedAt:'2026-09-20T01:59:00Z',
    evidence:{source:'pt_page',authoritative:true}}]};
  const result=planHarvestFallback(f);
  assert.equal(result.eligible.length,0);
  assert.equal(result.assessments[0].state,'confirmed_by_executor_supplement');
  f.fallbackReport.sites[0].observedAt='2026-09-19T01:59:00Z';
  assert.equal(planHarvestFallback(f).eligible.length,1);
  f.fallbackReport.businessDate='2026-09-19';
  assert.throws(()=>planHarvestFallback(f),/wrong source or date/);
});
test('a bookmarked PT site absent from Harvest is reviewed after the daily task completes',()=>{
  const f=fixture();
  f.harvest.sites=[failed('https://ourbits.club')];
  f.catalog.sites=f.catalog.sites.slice(0,2);
  const preview=planHarvestFallback(f);
  assert.deepEqual(preview.eligible.map(item=>item.origin),['https://ourbits.club','https://external.example']);
  assert.equal(preview.eligible[1].kind,'fallback_only');
  assert.equal(preview.eligible[1].trigger,'monitored_pt_status_unobserved');
  f.harvest.taskCompletion.status='failed';
  assert.equal(planHarvestFallback(f).eligible.length,2);
  f.harvest.taskCompletion.status='completed';
  f.fallbackOnlyEnabled=false;
  assert.equal(planHarvestFallback(f).blocked.some(item=>item.origin==='https://external.example'&&item.reason==='fallback_only_not_enabled'),true);
});
test('unknown Harvest status releases the registered PT without waiting for task completion',()=>{
  const f=fixture();f.catalog.sites=f.catalog.sites.slice(0,1);f.harvest.sites=[{origin:'https://ourbits.club',userId:'7',status:'unknown',observedAt:null,evidence:{authoritative:false}}];
  const reviewed=planHarvestFallback(f);
  assert.equal(reviewed.eligible[0].trigger,'harvest_status_unconfirmed');
  f.harvest.taskCompletion.status='failed';assert.equal(planHarvestFallback(f).eligible[0].trigger,'harvest_task_failed');
  f.harvest.taskCompletion.status='completed';f.latest.results[0].status='already_signed';assert.equal(planHarvestFallback(f).eligible.length,0);
  f.latest.results[0].status='needs_attention';assert.equal(planHarvestFallback(f).eligible[0].origin,'https://ourbits.club');
});

test('pending, failed, and missing Harvest states all release a precise registered PT target',()=>{
  for(const status of ['pending','failed','unknown']){
    const f=fixture();f.catalog.sites=f.catalog.sites.slice(0,1);f.harvest.taskCompletion=null;
    f.harvest.sites=[{origin:'https://ourbits.club',status,observedAt:status==='failed'?'2026-09-20T09:55:00+08:00':null,evidence:{authoritative:false}}];
    const result=planHarvestFallback(f);
    assert.equal(result.eligible.length,1,status);
    assert.equal(result.eligible[0].origin,'https://ourbits.club');
    assert.equal(result.eligible[0].trigger,'harvest_status_unconfirmed');
  }
  const missing=fixture();missing.catalog.sites=missing.catalog.sites.slice(0,1);missing.harvest.sites=[];missing.harvest.taskCompletion=null;
  assert.equal(planHarvestFallback(missing).eligible[0].trigger,'harvest_status_unconfirmed');
});

test('Harvest external conditions are blocked separately and do not become local failures',()=>{
  const f=fixture();f.catalog.sites=f.catalog.sites.slice(0,1);f.harvest.taskCompletion=null;
  f.harvest.sites=[{origin:'https://ourbits.club',status:'maintenance',siteCondition:'site_maintenance',observedAt:null,evidence:{authoritative:false}}];
  const result=planHarvestFallback(f);
  assert.equal(result.eligible.length,0);
  assert.deepEqual(result.blocked[0],{origin:'https://ourbits.club',reason:'external_condition',external:true});
  assert.deepEqual(result.assessments[0],{origin:'https://ourbits.club',state:'external_condition',reason:'external_condition'});
});
test('Harvest ID is not a PT account ID; stale, completed and ambiguous plans still block',()=>{
  const f=fixture();
  f.catalog.sites=f.catalog.sites.slice(0,1);
  f.harvest.sites=f.harvest.sites.slice(0,1);
  f.plan.targets[0].accountId='8';assert.equal(planHarvestFallback(f).eligible[0].origin,'https://ourbits.club');
  f.harvest.sites[0].userId='7';f.harvest.sites[0].observedAt='2026-09-19T09:55:00+08:00';
  assert.equal(planHarvestFallback(f).blocked[0].reason,'stale_failure');
  f.harvest.sites[0].observedAt='2026-09-20T09:55:00+08:00';
  f.latest.results[0].status='already_signed';assert.equal(planHarvestFallback(f).eligible.length,0);
  f.latest.results[0].status='needs_attention';f.plan.targets.push({...f.plan.targets[0],accountKey:'another'});
  assert.equal(planHarvestFallback(f).blocked[0].reason,'ambiguous_legacy_account');
  f.harvest.generatedAt='2026-09-19T09:58:00+08:00';assert.throws(()=>planHarvestFallback(f),/stale/);
});
test('a monitored PT origin needs a safe exact bookmark entry before site fallback',()=>{
  const f=fixture();f.harvest.sites=[failed('https://external.example')];
  f.catalog.sites[1].entryUrl='https://external.example/attendance?passkey=value';
  assert.equal(planHarvestFallback(f).blocked[0].reason,'fallback_entry_missing_or_unsafe');
  f.catalog.sites[1].entryUrl='https://other.example/attendance';
  assert.equal(planHarvestFallback(f).blocked[0].reason,'fallback_entry_missing_or_unsafe');
  f.catalog.sites[1].entryUrl='https://external.example/attendance';
  f.harvest.sites[0].status='unknown';f.harvest.sites[0].observedAt=null;f.harvest.sites[0].userId=null;
  assert.equal(planHarvestFallback(f).eligible[0].kind,'fallback_only');
});
test('fallback-only execution defaults to disabled before the private runtime is enrolled',()=>{
  const f=fixture();delete f.fallbackOnlyEnabled;
  assert.equal(planHarvestFallback(f).blocked[0].reason,'fallback_only_not_enabled');
  assert.equal(planHarvestFallback(f).eligible.length,1);
});
test('Harvest completion audits every registered PT task, including one absent from Harvest',()=>{
  const f=fixture();
  f.catalog.sites=f.catalog.sites.slice(0,1);
  f.harvest.sites=f.harvest.sites.slice(0,1);
  f.plan.targets.push({origin:'https://unobserved.example',folderNames:['PT白名单']});
  f.harvest.sites[0].status='unknown';f.harvest.sites[0].observedAt=null;f.harvest.sites[0].userId=null;
  const audit=planHarvestFallback(f);
  assert.equal(audit.registeredCount,2);
  assert.deepEqual(audit.eligible.map(item=>item.origin),['https://ourbits.club','https://unobserved.example']);
  assert.equal(audit.eligible[1].trigger,'harvest_status_unconfirmed');
  assert.equal(audit.assessments.filter(item=>item.state==='executor_recheck_queued').length,2);
  f.latest.results.push({origin:'https://unobserved.example',accountKey:'site-default',status:'already_signed'});
  assert.equal(planHarvestFallback(f).eligible.length,1);
});
test('registered PT unknown submission enters a passive review queue after Harvest failure',()=>{
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  f.latest.results[0].failureCode='submission_outcome_unknown';
  f.latest.results[0].submissionAttempted=true;
  const preview=planHarvestFallback(f);
  assert.equal(preview.blocked.length,0);
  assert.deepEqual(preview.eligible[0],{
    origin:'https://ourbits.club',accountKey:'site-default',businessDate:'2026-09-20',
    kind:'registered_review',readOnlyReview:true,guardedSubmit:true,observedAt:'2026-09-20T01:55:00.000Z',
    trigger:'submission_unknown_readonly_review',
  });
  assert.deepEqual(preview.assessments.find(item=>item.origin==='https://ourbits.club'),{
    origin:'https://ourbits.club',state:'readonly_recheck_queued',reason:'submission_outcome_unknown',
  });
  f.latest.results[0].submissionAttempted=false;
  const malformed=planHarvestFallback(f);
  assert.equal(malformed.eligible.some(item=>item.origin==='https://ourbits.club'),false);
  assert.equal(malformed.blocked.find(item=>item.origin==='https://ourbits.club').reason,'submission_outcome_unknown');
});

test('Audiences unknown review records a passive diagnostic and never calls the executor',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-registered-readback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();
  const origin='https://audiences.me';
  f.harvest.sites=[failed(origin)];
  f.catalog.sites=[{origin}];
  f.plan.targets=[{origin,folderNames:['PT白名单']}];
  f.latest.results=[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
  let siteCalls=0,engineCalls=0;
  const passive={origin,status:'needs_attention',observedAt:f.now.toISOString(),businessDate:'2026-09-20',
    accountKey:'site-default',profileBinding:'b'.repeat(64),operationMode:'safe_history_page',
    readSafety:'reviewed_passive',submissionAttempted:false,submissionOutcomeUnknown:true,
    evidence:{source:'none',authoritative:false,summary:'原生只读结果不明'}};
  const result=await runHarvestFallback({...f,root,execute:true,
    runEngine:async()=>{engineCalls++;throw Error('registered unknown must never execute');},
    runSite:async options=>{siteCalls++;assert.equal(options.origin,origin);assert.equal(options.readOnly,true);return passive;},
  });
  assert.equal(siteCalls,1);assert.equal(engineCalls,0);
  assert.deepEqual(result.outcomes,[{origin,state:'passive_result_unverified',v1Status:'needs_attention',readOnly:true}]);
  const audit=JSON.parse(fs.readFileSync(path.join(root,'outputs','harvest-fallback-attempts-2026-09-20.json'),'utf8'));
  assert.equal(audit.attempts.length,0);
  assert.equal(audit.verifications[0].state,'completed');
  assert.equal(audit.verifications[0].outcome.status,'needs_attention');
  assert.equal(audit.verifications[0].outcome.submissionAttempted,false);
  assert.equal(audit.verifications[0].outcome.submissionOutcomeUnknown,true);
  const receipt=JSON.parse(fs.readFileSync(path.join(root,'outputs','pt-fallback-results-2026-09-20.json'),'utf8'));
  assert.equal(receipt.sites[0].status,'needs_attention');
  assert.equal(receipt.sites[0].submissionAttempted,false);
  const nextPreview=planHarvestFallback({...f,fallbackReport:receipt});
  assert.equal(pendingHarvestFallbackAttempts(root,nextPreview,{now:f.now}).length,0);
  assert.equal(pendingHarvestFallbackAttempts(root,nextPreview,{now:new Date(f.now.getTime()+31*60_000)}).length,1);
});

test('registered OpenCD fresh unsigned proof resumes V1 once and remains quarantined after an ambiguous outcome',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-registered-open-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));configureUnifiedFixture(root);
  const f=fixture(),origin='https://open.cd';
  f.harvest.sites=[failed(origin)];f.catalog.sites=[{origin,entryUrl:origin+'/index.php'}];
  f.plan.targets=[{origin,folderNames:['公益站']}];
  f.latest.results=[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
  let engineCalls=0;
  const proof={origin,status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',accountKey:'site-default',
    profileBinding:'b'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:now.toISOString(),
      evidenceScope:'site_account_day',pagePath:'/index.php',statusSignal:'open_cd_daily_unsigned'}};
  const args={...f,root,execute:true,runSite:async input=>{if(input.readOnly){assert.equal(input.readOnly,true);return proof;}engineCalls++;return {origin,status:'already_signed',observedAt:now.toISOString(),evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-20',statusSignal:'open_cd_daily_record_entry'}};}};
  await runHarvestFallback(args);await runHarvestFallback(args);
  assert.equal(engineCalls,1,'a guarded recovery cannot be retried from the same proof');
  const state=JSON.parse(fs.readFileSync(root+'/outputs/harvest-fallback-attempts-2026-09-20.json'));
  assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].recoveryEvidence.evidence.statusSignal,'open_cd_daily_unsigned');
});

test('registered review cannot resume from unverified, stale, wrong-day or non-opted-in negative evidence',async t=>{
  for(const variant of ['unverified','stale','wrong-day','opt-out','foreign-signal']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-registered-open-deny-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));configureUnifiedFixture(root);
    const f=fixture(),origin='https://open.cd';f.harvest.sites=[failed(origin)];f.catalog.sites=[{origin,entryUrl:origin+'/index.php'}];
    f.plan.targets=[{origin,folderNames:['公益站']}];f.latest.results=[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
    let engineCalls=0;const at=variant==='stale'?new Date(now.getTime()-6*60_000):now;
    const proof={origin,status:'not_signed',observedAt:at.toISOString(),businessDate:variant==='wrong-day'?'2026-09-19':'2026-09-20',
      accountKey:'site-default',profileBinding:'b'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
      evidence:{source:'pt_page',authoritative:variant!=='unverified',businessDate:'2026-09-20',confirmedAt:at.toISOString(),
        evidenceScope:'site_account_day',pagePath:'/index.php',statusSignal:variant==='foreign-signal'?'generic_label':'open_cd_daily_unsigned'}};
    await runHarvestFallback({...f,root,execute:true,fallbackOnlyEnabled:variant!=='opt-out',runSite:async()=>proof,
      runEngine:async()=>{engineCalls++;return {results:[]};}});
    assert.equal(engineCalls,0,variant+' must never authorize a supplement');
  }
});
test('an explicit V1 site/account disable and disabled feature cannot enter fallback',()=>{
 const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
 f.catalog.sites=f.catalog.sites.slice(0,1);
 for(const config of [{disabledCheckinOrigins:['https://ourbits.club']},{disabledAccountKeys:['site-default']}]){
   const result=planHarvestFallback({...f,config});assert.equal(result.eligible.length,0);
   assert.equal(result.blocked[0].reason,'disabled_by_v1_configuration');
 }
 f.latest.results[0]={...f.latest.results[0],status:'not_available',availabilityKind:'feature_disabled'};
 const result=planHarvestFallback(f);assert.equal(result.eligible.length,0);
 assert.equal(result.blocked[0].reason,'v1_feature_or_task_unavailable');
});
test('a Harvest failure waits for a same-day complete V1 execution plan',()=>{
 const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
 f.latest.runId='20260919-old';assert.equal(planHarvestFallback(f).blocked[0].reason,'v1_day_not_ready');
 f.latest.runId='20260920-fixture';f.latest.isComplete=false;
 assert.equal(planHarvestFallback(f).blocked[0].reason,'v1_day_not_ready');
});
test('attempt is durable before execution, never blindly repeated and busy can retry',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);f.catalog.sites=f.catalog.sites.slice(0,1);
  let calls=0;const success=async options=>{calls++;if(options.readOnly)return {origin:'https://ourbits.club',accountKey:'site-default',status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-20',evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};return {origin:'https://ourbits.club',status:'signed',observedAt:now.toISOString(),evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString()}};};
  assert.equal((await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:['https://ourbits.club'],runSite:success})).outcomes[0].v1Status,'signed');
  assert.equal((await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:['https://ourbits.club'],runSite:success})).outcomes[0].state,'passive_verification_cooldown');
  assert.equal(calls,2);
  const stored=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json'),'utf8'));
  assert.equal(stored.attempts[0].state,'completed');assert.equal(fs.existsSync(path.join(root,'data/harvest-fallback.lock')),false);
});
test('fallback-only PT site uses the execution-layer site helper and a separate redacted report',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-site-fallback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);
  f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  let calls=0;
  const args={...f,root,execute:true,catalogFile,catalogHash,
    runEngine:async()=>{throw Error('daily plan must not run for an external PT site');},
    runSite:async value=>{
      calls++;assert.equal(value.origin,'https://external.example');
      assert.match(value.fallbackAttemptId,/^[0-9a-f-]{36}$/);
      const journal=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json')));
      const own=journal.attempts.find(item=>item.attemptId===value.fallbackAttemptId),worker=JSON.parse(fs.readFileSync(path.join(root,'data/harvest-fallback.lock')));
      assert.equal(own.state,'in_progress');assert.equal(own.workerPid,worker.pid);assert.equal(own.workerNonce,worker.nonce);
      return {origin:value.origin,status:'already_signed',observedAt:f.now.toISOString(),evidence:{source:'page_text',authoritative:true,summary:'已签到'}};
    }};
  const result=await runHarvestFallback(args);
  assert.deepEqual(result.outcomes.map(item=>item.v1Status),['already_signed']);
  assert.equal((await runHarvestFallback(args)).outcomes[0].state,'already_attempted');assert.equal(calls,1);
  const report=JSON.parse(fs.readFileSync(path.join(root,'outputs/pt-fallback-results-2026-09-20.json')));
  assert.equal(report.source,'execution-supplement');assert.equal(report.sites[0].origin,'https://external.example');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'legacy/data/v2-integration.json'))).executionEngine,'v1');
});
test('fallback-only execution refuses an unbound catalog before persisting an attempt',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-site-unbound-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);
  f.latest.results[0].status='already_signed';
  await assert.rejects(()=>runHarvestFallback({...f,root,execute:true,runSite:async()=>{throw Error('must not launch');}}),/bound bookmark catalog/);
  assert.equal(fs.existsSync(path.join(root,'outputs')),false);
});
test('a proven pre-browser catalog failure may retry after a corrected input',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-preflight-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  const args={...f,root,execute:true,catalogFile,catalogHash};
  const failedAttempt=await runHarvestFallback({...args,runSite:async()=>{const error=Error('preflight');error.code='PT_PREFLIGHT';throw error;}});
  assert.equal(failedAttempt.outcomes[0].state,'deferred_preflight');
  const retried=await runHarvestFallback({...args,runSite:async()=>({origin:'https://external.example',status:'login_required',observedAt:f.now.toISOString(),evidence:{source:'none',authoritative:false}})});
  assert.equal(retried.outcomes[0].state,'completed');assert.equal(retried.outcomes[0].v1Status,'login_required');
});

test('Harvest gate deferrals preserve a cooldown without consuming submission attempts',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-wait-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  let current=f.now;
  const args={...f,root,execute:true,catalogFile,catalogHash:'a'.repeat(64),clock:()=>current,
    runSite:async()=>({origin:'https://external.example',status:'unknown',observedAt:current.toISOString(),submissionAttempted:false,
      retryCause:'harvest_waiting',nextEligibleAt:new Date(current.getTime()+30*60_000).toISOString(),evidence:{source:'none',authoritative:false}})};
  const preview=planHarvestFallback(f);
  for(let index=0;index<4;index++){
    assert.equal((await runHarvestFallback(args)).outcomes[0].state,'deferred_preflight');
    assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:current}).length,0);
    current=new Date(current.getTime()+31*60_000);
    assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:current}).length,1);
  }
});

test('a login-only attempt can resume only after a newer account recovery',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-login-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  const args={...f,root,execute:true,catalogFile,catalogHash};
  const clock=()=>new Date('2026-09-20T02:02:00Z');
  const failedAttempt=await runHarvestFallback({...args,clock,runSite:async()=>({origin:'https://external.example',status:'login_required',observedAt:'2026-09-20T02:02:01Z',submissionAttempted:false,evidence:{source:'none',authoritative:false}})});
  assert.equal(failedAttempt.outcomes[0].state,'completed');
  assert.equal(failedAttempt.outcomes[0].v1Status,'login_required');
  const blocked=pendingHarvestFallbackAttempts(root,planHarvestFallback(f));
  assert.equal(blocked.length,0);
  const recoveredAtByAccount={'https://external.example#account=site-default':'2026-09-20T02:03:00Z'};
  assert.equal(pendingHarvestFallbackAttempts(root,planHarvestFallback(f),{recoveredAtByAccount,now:new Date('2026-09-20T02:04:00Z')}).length,1);
  const retried=await runHarvestFallback({...args,clock:()=>new Date('2026-09-20T02:04:00Z'),recoveredAtByAccount,
    runSite:async()=>({origin:'https://external.example',status:'already_signed',observedAt:'2026-09-20T02:04:01Z',evidence:{source:'page_text',authoritative:true}})});
  assert.equal(retried.outcomes[0].v1Status,'already_signed');
  assert.equal(retried.outcomes[0].state,'completed');
});

test('a slow PT result uses the receive clock instead of the batch start clock',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-slow-result-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  let ticks=[new Date('2026-09-20T02:00:00Z'),new Date('2026-09-20T02:02:00Z')];
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,clock:()=>ticks.shift()??new Date('2026-09-20T02:02:00Z'),
    runSite:async()=>({origin:'https://external.example',status:'already_signed',observedAt:'2026-09-20T02:01:30Z',evidence:{source:'page_text',authoritative:true}})});
  assert.equal(result.outcomes[0].v1Status,'already_signed');
});
test('midnight preserves a redacted receipt and stops the rest of the batch',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-midnight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.now=new Date('2026-09-20T15:59:50Z');
  f.harvest.generatedAt='2026-09-20T15:59:49Z';
  f.harvest.sites=[failed('https://external.example'),failed('https://ourbits.club')];
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  const ticks=[f.now,new Date('2026-09-20T16:00:30Z')];let siteCalls=0;
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,clock:()=>ticks.shift()??new Date('2026-09-20T16:00:30Z'),
    runSite:async()=>{siteCalls++;return{origin:'https://external.example',status:'already_signed',
      observedAt:'2026-09-20T16:00:10Z',evidence:{source:'page_text',authoritative:true,summary:'今日已签到'}};},
    runEngine:async()=>{throw Error('the next site must wait');}});
  assert.equal(siteCalls,1);
  assert.deepEqual(result.outcomes.map(item=>item.state),['completed_cross_day']);
  const audit=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json')));
  assert.equal(audit.attempts[0].resultBusinessDate,'2026-09-21');
  assert.equal(audit.attempts[0].outcome.status,'already_signed');
  assert.equal(fs.existsSync(path.join(root,'outputs/pt-fallback-results-2026-09-20.json')),false);
  const tomorrow={businessDate:'2026-09-21',eligible:[{origin:'https://external.example',accountKey:'site-default',businessDate:'2026-09-21'}]};
  assert.equal(pendingHarvestFallbackAttempts(root,tomorrow,{now:new Date('2026-09-20T16:01:00Z')}).length,0);
});
test('fresh Harvest state is checked before every PT write and outages fail closed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-refresh-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);
  f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  let calls=0;
  const args={...f,root,execute:true,catalogFile,catalogHash,runSite:async()=>{
    calls++;return{origin:'https://external.example',status:'already_signed',observedAt:f.now.toISOString(),
      evidence:{source:'page_text',authoritative:true}};}};
  const success={...f.harvest,sites:[{origin:'https://external.example',status:'already_signed',
    observedAt:f.now.toISOString(),evidence:{source:'harvest',authoritative:true}}]};
  assert.equal((await runHarvestFallback({...args,refreshHarvest:async()=>success})).outcomes[0].state,'harvest_status_changed');
  assert.equal((await runHarvestFallback({...args,refreshHarvest:async()=>({...f.harvest,taskCompletion:null})})).outcomes[0].state,'harvest_task_changed');
  assert.equal((await runHarvestFallback({...args,refreshHarvest:async()=>{throw Error('SSH unavailable');}})).outcomes[0].state,'harvest_refresh_unavailable');
  assert.equal(calls,0);
  assert.equal(fs.existsSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json')),false);
  assert.equal((await runHarvestFallback({...args,refreshHarvest:async()=>f.harvest})).outcomes[0].state,'completed');
  assert.equal(calls,1);
});
test('equivalent Harvest completion offsets resume the same task instead of stalling the queue', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-equivalent-time-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];
  f.catalog.sites=f.catalog.sites.slice(0,2);f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  const live={...f.harvest,taskCompletion:{...f.harvest.taskCompletion,
    startedAt:new Date(f.harvest.taskCompletion.startedAt).toISOString(),completedAt:new Date(f.harvest.taskCompletion.completedAt).toISOString()}};
  let calls=0;
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,refreshHarvest:async()=>live,
    runSite:async()=>{calls++;return {origin:'https://external.example',status:'already_signed',observedAt:f.now.toISOString(),evidence:{source:'page_text',authoritative:true}};}});
  assert.equal(calls,1);assert.equal(result.outcomes[0].state,'completed');
  const changed=await runHarvestFallback({...f,root,execute:true,catalogFile,catalogHash,refreshHarvest:async()=>({...live,taskCompletion:{...live.taskCompletion,resultId:6}})});
  assert.equal(calls,1);assert.notEqual(changed.outcomes[0].state,'completed');
});

test('a recovered login is bounded by time, cooldown, business day and two resumptions',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-login-budget-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=[failed('https://external.example')];f.catalog.sites=f.catalog.sites.slice(0,2);
  f.latest.results[0].status='already_signed';
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const catalogHash=(await import('node:crypto')).createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  let current=new Date('2026-09-20T02:00:00Z'),calls=0;
  const args={...f,root,execute:true,catalogFile,catalogHash,clock:()=>current,
    runSite:async()=>{calls++;return{origin:'https://external.example',status:'login_required',
      observedAt:current.toISOString(),submissionAttempted:false,evidence:{source:'none',authoritative:false}};}};
  await runHarvestFallback(args);
  const preview=planHarvestFallback(f);
  const key='https://external.example#account=site-default';
  assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:new Date('2026-09-20T02:01:00Z'),
    recoveredAtByAccount:{[key]:'2026-09-20T01:59:00Z'}}).length,0);
  current=new Date('2026-09-20T02:03:00Z');
  await runHarvestFallback({...args,recoveredAtByAccount:{[key]:'2026-09-20T02:02:00Z'}});
  current=new Date('2026-09-20T02:06:00Z');
  await runHarvestFallback({...args,recoveredAtByAccount:{[key]:'2026-09-20T02:05:00Z'}});
  current=new Date('2026-09-20T02:09:00Z');
  const refused=await runHarvestFallback({...args,recoveredAtByAccount:{[key]:'2026-09-20T02:08:00Z'}});
  assert.equal(refused.outcomes[0].state,'already_attempted');
  assert.equal(calls,3);
  assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:new Date('2026-09-20T04:00:00Z'),
    recoveredAtByAccount:{[key]:'2026-09-20T02:08:00Z'}}).length,0);
});
test('a V2 lock collision is not counted as an actual attempt',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-busy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);f.catalog.sites=f.catalog.sites.slice(0,1);
  let current=now;
  const busy=await runHarvestFallback({...f,root,now:current,clock:()=>current,execute:true,readOnlyOrigins:['https://ourbits.club'],runSite:async()=>{throw Error('V2 runner is already active');}});
  assert.equal(busy.outcomes[0].state,'deferred_busy');
  current=new Date(current.getTime()+16*60_000);
  const second=await runHarvestFallback({...f,root,now:current,clock:()=>current,execute:true,readOnlyOrigins:['https://ourbits.club'],runSite:async input=>input.readOnly?{origin:'https://ourbits.club',accountKey:'site-default',status:'not_signed',observedAt:current.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,confirmedAt:current.toISOString(),businessDate:'2026-09-20',evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}}:{origin:'https://ourbits.club',status:'already_signed',observedAt:current.toISOString(),evidence:{source:'page_text',authoritative:true,confirmedAt:current.toISOString()}}});
  assert.equal(second.outcomes[0].state,'completed');
});

test('preview counts only unattempted candidates and rejects a malformed daily audit',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-preview-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);f.catalog.sites=f.catalog.sites.slice(0,1);
  const preview=planHarvestFallback(f);
  assert.equal(pendingHarvestFallbackAttempts(root,preview).length,1);
  fs.mkdirSync(path.join(root,'outputs'));
  const audit=path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json');
  fs.writeFileSync(audit,JSON.stringify({businessDate:preview.businessDate,attempts:[{origin:'https://ourbits.club',state:'completed'}]}));
  assert.equal(pendingHarvestFallbackAttempts(root,preview).length,0);
  fs.writeFileSync(audit,JSON.stringify({businessDate:preview.businessDate,attempts:[{origin:'https://ourbits.club',state:'deferred_preflight',submissionState:'not_submitted',v1Status:'unknown',finishedAt:'2026-09-20T01:00:00Z',nextEligibleAt:'2026-09-20T01:30:00Z',outcome:{retryCause:'harvest_waiting',submissionAttempted:false}}]}));
  assert.equal(pendingHarvestFallbackAttempts(root,preview).length,1);
  fs.writeFileSync(audit,JSON.stringify({businessDate:'2026-09-19',attempts:[]}));
  assert.throws(()=>pendingHarvestFallbackAttempts(root,preview),/audit is invalid/);
});

test('rollback to independent V2 mode refuses Harvest fallback before a claim',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-rollback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const f=fixture();f.harvest.sites=f.harvest.sites.slice(0,1);
  await assert.rejects(()=>runHarvestFallback({...f,root,execute:true,runEngine:async()=>{throw Error('must not execute');}}),/requires the V1 execution engine/);
  assert.equal(fs.existsSync(path.join(root,'outputs')),false);
});

test('historical uncertainty permits only a fresh passive check and guarded daily recovery',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-daily-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture(),origin='https://external.example';f.harvest.sites=[failed(origin)];
  f.catalog.sites=f.catalog.sites.filter(s=>s.origin===origin);f.plan.targets=[];f.latest.results=[];
  fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
  const oldFile=path.join(root,'outputs/harvest-fallback-attempts-2026-09-19.json');
  fs.writeFileSync(oldFile,JSON.stringify({businessDate:'2026-09-19',attempts:[{origin,state:'outcome_unknown',startedAt:'2026-09-19T01:00:00Z'}]}));
  const old=fs.readFileSync(oldFile,'utf8');
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify(f.catalog));
  const args={...f,root,execute:true,catalogFile,catalogHash:'a'.repeat(64),readOnlyOrigins:[origin]};
  const preview=planHarvestFallback(f);
  assert.equal(pendingHarvestFallbackAttempts(root,preview,{now}).length,0);
  assert.equal(pendingHarvestFallbackAttempts(root,preview,{now,readOnlyOrigins:[origin]}).length,1);
  const passive={origin,status:'not_signed',observedAt:now.toISOString(),businessDate:'2026-09-20',profileBinding:'b'.repeat(64),
    accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:now.toISOString(),evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}};
  const calls=[];
  const output=await runHarvestFallback({...args,runSite:async options=>{
    calls.push(options.readOnly?'read':options.verifyBeforeSubmit?'guarded':'unguarded');
    return options.readOnly?passive:{...passive,status:'signed',submissionAttempted:true,operationMode:'legacy_checkin',readSafety:'attendance_page_risk'};
  }});
  assert.deepEqual(calls,['read','guarded']);assert.equal(output.outcomes[0].v1Status,'signed');
  assert.equal(fs.readFileSync(oldFile,'utf8'),old);
  assert.equal(pendingHarvestFallbackAttempts(root,preview,{now,readOnlyOrigins:[origin]}).length,0);
  const state=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json')));
  assert.equal(state.attempts[0].recoveryEvidence.status,'not_signed');
});

test('uncertain passive result never permits a recovery submission',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-read-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture(),origin='https://external.example';f.harvest.sites=[failed(origin)];
  f.catalog.sites=f.catalog.sites.filter(s=>s.origin===origin);f.plan.targets=[];f.latest.results=[];
  let calls=0;
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),readOnlyOrigins:[origin],
    runSite:async options=>{calls++;assert.equal(options.readOnly,true);return {origin,status:'unknown',observedAt:now.toISOString(),
      businessDate:'2026-09-20',profileBinding:'b'.repeat(64),accountKey:'site-default',operationMode:'safe_history_page',
      readSafety:'reviewed_passive',submissionAttempted:false,evidence:{source:'none',authoritative:false}};}});
  assert.equal(calls,1);assert.equal(result.outcomes[0].state,'passive_result_unverified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json'))).attempts.length,0);
  assert.equal(pendingHarvestFallbackAttempts(root,planHarvestFallback(f),{now,readOnlyOrigins:[origin]}).length,0);
});

function nativeProfileRecoveryFixture(root,{attemptChanges={},resultChanges={},priorChanges={}}={}){
  const f=fixture(),origin='https://ourbits.club',businessDate='2026-09-20';
  f.harvest.sites=f.harvest.sites.slice(0,1);f.catalog.sites=f.catalog.sites.slice(0,1);
  f.latest.results=[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
  f.config={ptReadOnlyPolicies:{[origin]:{reviewed:true,mode:'safe_history_page',url:origin+'/index.php',nativeMainChrome:true}}};
  const proof=at=>({origin,accountKey:'site-default',profileBinding:'b'.repeat(64),businessDate,
    status:'not_signed',observedAt:at,submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
    evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:at,evidenceScope:'site_account_day',statusSignal:'nexus_daily_header_unsigned'}});
  const old=proof('2026-09-20T01:20:00.000Z'),attempt={attemptId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',origin,
    accountKey:'site-default',businessDate,state:'completed',startedAt:'2026-09-20T01:20:01.000Z',finishedAt:'2026-09-20T01:20:03.000Z',
    recoveryEvidence:{...old,...priorChanges},outcome:{...old,status:'needs_attention',failureCode:'authoritative_status_unavailable',
      profileBinding:'c'.repeat(64),observedAt:'2026-09-20T01:20:03.000Z',...resultChanges},...attemptChanges};
  fs.mkdirSync(path.join(root,'outputs'),{recursive:true});
  const audit=path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json');
  fs.writeFileSync(audit,JSON.stringify({businessDate,attempts:[attempt]}));
  return {f,origin,businessDate,proof,audit,attempt};
}

test('an explicit unsubmitted generic-profile guard can recover once through the bound native engine',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-profile-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const {f,origin,businessDate,proof,audit}=nativeProfileRecoveryFixture(root);
  const calls=[],current=proof(now.toISOString());
  const args={...f,root,execute:true,readOnlyOrigins:[origin],runSite:async options=>{
    calls.push('read');assert.equal(options.readOnly,true,'native submits must not use the generic supplement');return current;
  },runEngine:async options=>{
    calls.push('native');assert.equal(options.mode,'execute');assert.deepEqual(options.origins,[origin]);
    assert.deepEqual(options.accountKeys,[],'legacy raw default keys may be absent; exact origin selection keeps preflight bounded');
    assert.equal(options.notify,false);assert.equal(options.fallbackRecheck,true);
    return {runId:'20260920-native-test',businessDate,observedAt:now.toISOString(),results:[{
      ...current,status:'signed',submissionAttempted:true,operationMode:'legacy_checkin',readSafety:'attendance_page_risk'}]};
  }};
  const output=await runHarvestFallback(args);
  assert.deepEqual(calls,['read','native']);assert.equal(output.outcomes[0].v1Status,'signed');
  const state=JSON.parse(fs.readFileSync(audit));assert.equal(state.attempts.length,2);
  assert.equal(state.attempts[0].outcome.submissionAttempted,false);assert.equal(state.attempts[1].nativeRegisteredEngine,true);
  assert.equal(state.attempts[1].outcome.profileBinding,current.profileBinding);
  assert.equal((await runHarvestFallback(args)).outcomes[0].state,'already_confirmed');assert.deepEqual(calls,['read','native']);
});

test('unknown writes, mismatched accounts, stale proof and unreviewed routing retain the daily submit limit',async t=>{
  const variants=[
    {resultChanges:{submissionAttempted:true}},
    {resultChanges:{submissionAttempted:undefined}},
    {resultChanges:{submissionOutcomeUnknown:true}},
    {resultChanges:{failureCode:'submission_outcome_unknown'}},
    {resultChanges:{accountKey:'other-account'}},
    {attemptChanges:{businessDate:'2026-09-19'}},
    {attemptChanges:{attemptId:undefined}},
    {resultChanges:{observedAt:'2026-09-19T01:20:03.000Z'}},
    {attemptChanges:{nativeRegisteredEngine:true}},
    {priorChanges:{profileBinding:'d'.repeat(64)}},
    {attemptChanges:{finishedAt:'2026-09-20T02:00:00.000Z'}},
    {unreviewed:true}
  ];
  for(const variant of variants){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-recovery-refusal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    configureUnifiedFixture(root);const {f,origin,proof,audit}=nativeProfileRecoveryFixture(root,variant);
    if(variant.unreviewed)f.config.ptReadOnlyPolicies[origin].reviewed=false;
    let reads=0;
    const output=await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:[origin],runSite:async options=>{
      reads++;assert.equal(options.readOnly,true);return proof(now.toISOString());
    },runEngine:async()=>{throw Error('a rejected recovery must not launch the native engine');}});
    assert.equal(reads,1);assert.equal(output.outcomes[0].state,'daily_attempt_limit',JSON.stringify(variant));
    assert.equal(JSON.parse(fs.readFileSync(audit)).attempts.length,1);
  }
});

test('native-engine wrong-profile results stay quarantined instead of being published as completion',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-return-binding-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);const {f,origin,businessDate,proof,audit}=nativeProfileRecoveryFixture(root);
  const current=proof(now.toISOString());
  const output=await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:[origin],runSite:async options=>{
    assert.equal(options.readOnly,true);return current;
  },runEngine:async()=>({businessDate,observedAt:now.toISOString(),results:[{...current,status:'signed',submissionAttempted:true,profileBinding:'d'.repeat(64)}]})});
  assert.equal(output.outcomes[0].state,'outcome_unknown');
  const state=JSON.parse(fs.readFileSync(audit));assert.equal(state.attempts[1].outcome.profileBinding,'d'.repeat(64));
  assert.equal(state.attempts[1].outcome.submissionAttempted,true);
  const saved=JSON.parse(fs.readFileSync(path.join(root,'outputs','pt-fallback-results-'+businessDate+'.json')));
  assert.equal(saved.sites[0].status,'not_signed','an incompatible engine success must never overwrite the passive account proof');
});

test('registered native recovery rejects missing or duplicate account results before publishing',async t=>{
  for(const duplicate of [false,true]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-return-account-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    configureUnifiedFixture(root);const {f,origin,businessDate,proof,audit}=nativeProfileRecoveryFixture(root);
    const current=proof(now.toISOString()),entry={...current,status:'signed',submissionAttempted:true};
    const output=await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:[origin],runSite:async options=>{
      assert.equal(options.readOnly,true);return current;
    },runEngine:async()=>({businessDate,observedAt:now.toISOString(),results:duplicate?[entry,entry]:[{...entry,accountKey:'other-account'}]})});
    assert.equal(output.outcomes[0].state,'outcome_unknown');
    const state=JSON.parse(fs.readFileSync(audit));assert.equal(state.attempts[1].nativeRegisteredEngine,true);
    const saved=JSON.parse(fs.readFileSync(path.join(root,'outputs','pt-fallback-results-'+businessDate+'.json')));
    assert.equal(saved.sites[0].status,'not_signed');
  }
});

test('explicit non-submission repairs keep both the total recovery and passive cooldown bounds',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-native-recovery-bounds-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);const {f,origin,proof,audit,attempt}=nativeProfileRecoveryFixture(root);
  fs.writeFileSync(audit,JSON.stringify({businessDate:f.harvest.businessDate,attempts:[attempt,{...attempt},{...attempt}]}));
  const output=await runHarvestFallback({...f,root,execute:true,readOnlyOrigins:[origin],runSite:async options=>{
    assert.equal(options.readOnly,true);return proof(now.toISOString());
  },runEngine:async()=>{throw Error('bounded recovery must not execute');}});
  assert.equal(output.outcomes[0].state,'daily_guard_recovery_limit');
  assert.equal(pendingHarvestFallbackAttempts(root,planHarvestFallback(f),{now,readOnlyOrigins:[origin]}).length,0);
});

test('a current maintenance notice records availability without authorizing a fallback submission',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-maintenance-read-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  configureUnifiedFixture(root);
  const f=fixture(),origin='https://external.example';f.harvest.sites=[failed(origin)];
  f.catalog.sites=f.catalog.sites.filter(s=>s.origin===origin);f.plan.targets=[];f.latest.results=[];
  let calls=0;
  const result=await runHarvestFallback({...f,root,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),readOnlyOrigins:[origin],
    runSite:async options=>{calls++;assert.equal(options.readOnly,true);return {origin,status:'unknown',observedAt:now.toISOString(),
      businessDate:'2026-09-20',profileBinding:'b'.repeat(64),accountKey:'site-default',operationMode:'safe_history_page',
      readSafety:'reviewed_passive',submissionAttempted:false,failureCode:'site_maintenance',siteCondition:'site_maintenance',
      evidence:{source:'pt_page',authoritative:false,summary:'站点维护，等待恢复'}};}});
  assert.equal(calls,1);assert.equal(result.outcomes[0].state,'passive_result_unverified');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json'))).attempts.length,0);
  const recorded=JSON.parse(fs.readFileSync(path.join(root,'outputs/pt-fallback-results-2026-09-20.json'))).sites[0];
  assert.equal(recorded.siteCondition,'site_maintenance');assert.equal(recorded.submissionAttempted,false);
});

test('busy and preflight deferrals keep the passive business budget and enforce cooldown',async t=>{
  for(const kind of ['busy','preflight']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-probe-backoff-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    configureUnifiedFixture(root);
    const f=fixture(),origin='https://external.example';f.harvest.sites=[failed(origin)];
    f.catalog.sites=f.catalog.sites.filter(s=>s.origin===origin);f.plan.targets=[];f.latest.results=[];
    let current=new Date(now),calls=0;
    const inputs=()=>({...f,root,now:current,clock:()=>current,execute:true,catalogFile:'fixture',catalogHash:'a'.repeat(64),
      harvest:{...f.harvest,generatedAt:current.toISOString()},readOnlyOrigins:[origin]});
    for(let i=0;i<3;i++){
      await runHarvestFallback({...inputs(),runSite:async()=>{calls++;throw kind==='busy'?Error('V2 runner is already active'):Object.assign(Error('catalog changed'),{code:'PT_PREFLIGHT'});}});
      const preview=planHarvestFallback(inputs());
      assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:current,readOnlyOrigins:[origin]}).length,0);
      current=new Date(current.getTime()+31*60_000);
    }
    const preview=planHarvestFallback(inputs());
    assert.equal(pendingHarvestFallbackAttempts(root,preview,{now:current,readOnlyOrigins:[origin]}).length,1);
    const result=await runHarvestFallback({...inputs(),runSite:async options=>{calls++;assert.equal(options.readOnly,true);
      return {origin,status:'already_signed',observedAt:current.toISOString(),businessDate:'2026-09-20',profileBinding:'a'.repeat(64),accountKey:'site-default',
        operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
        evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-20',confirmedAt:current.toISOString(),evidenceScope:'site_account_day'}};}});
    assert.equal(result.outcomes[0].state,'confirmed_by_passive_read');assert.equal(calls,4);
    const audit=JSON.parse(fs.readFileSync(path.join(root,'outputs/harvest-fallback-attempts-2026-09-20.json')));
    assert.equal(audit.attempts.length,0);assert.equal(audit.verifications.filter(v=>v.state==='completed').length,1);
  }
});

test('passive work keeps separate finite limits for actual reads and deferred wakeups',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-probe-limits-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const origin='https://external.example',day='2026-09-20';fs.mkdirSync(path.join(root,'outputs'));
  const file=path.join(root,'outputs/harvest-fallback-attempts-'+day+'.json');
  const preview={businessDate:day,eligible:[{origin,accountKey:'site-default',kind:'fallback_only'}]};
  const pending=()=>pendingHarvestFallbackAttempts(root,preview,{now:new Date('2026-09-20T12:00:00Z'),readOnlyOrigins:[origin]}).length;
  const write=verifications=>fs.writeFileSync(file,JSON.stringify({businessDate:day,attempts:[],verifications}));
  write(Array.from({length:3},()=>({origin,state:'unverified',startedAt:'2026-09-20T01:00:00Z'})));assert.equal(pending(),0);
  write(Array.from({length:24},()=>({origin,state:'deferred_busy',startedAt:'2026-09-20T01:00:00Z',nextEligibleAt:'2026-09-20T01:05:00Z'})));assert.equal(pending(),0);
  write([{origin,state:'deferred_busy',startedAt:'2026-09-20T01:00:00Z'}]);assert.equal(pending(),0);
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate:'2026-09-21',eligible:preview.eligible},
    {now:new Date('2026-09-21T01:00:00Z'),readOnlyOrigins:[origin]}).length,1);
});

function configureUnifiedFixture(root){
  const legacyRoot=path.join(root,'legacy');fs.mkdirSync(path.join(root,'config'),{recursive:true});
  fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot}));
  fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
}
