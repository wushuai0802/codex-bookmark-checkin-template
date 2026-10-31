import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {evaluateReleaseGate,evaluateReleaseVerification,shanghaiDay} from '../../tools/release-gate.mjs';
import {planRelease,applyRelease,auditRelease,rollbackRelease} from '../../tools/release-lib.mjs';
import {probeRelease,releaseSafetyCallbacks,verifyRelease,checkReleaseHealth} from '../../tools/release-runtime.mjs';
import {parseReleaseOptions,runReleaseCli} from '../../tools/release.mjs';

const project=fileURLToPath(new URL('../../',import.meta.url));
const now=new Date('2026-10-31T04:00:00Z'),revision='a'.repeat(40),hash='b'.repeat(64);
const good=value=>({ok:true,value});
const clone=value=>structuredClone(value);
const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function snapshot(at=now){
  const today=shanghaiDay(at),finishedAt=new Date(at.getTime()-60_000).toISOString(),runId=today.replaceAll('-','')+'-080500-001-abcdef';
  return {schemaVersion:1,capturedAt:at.toISOString(),
    tasks:good(['main','sync'].map(role=>({role,state:'Ready',nextRunMs:at.getTime()+300_000,lastRun:finishedAt,lastResult:0,definitionHash:hash}))),
    processes:good({count:0,roles:[]}),lifecycle:good({exists:false}),manualSessions:good(Array.from({length:3},()=>({exists:false}))),
    finalReport:good({runId,runState:'final',executionComplete:true,isComplete:true,finishedAt,nextRetryAt:null,results:[]}),
    scheduler:good({phase:'finished',lastAttemptDate:today,lastRunId:runId,reportValid:true,reportExecutionComplete:true,automaticRetryCount:0,nextEligibleAt:null}),
    harvest:good({enabled:true,businessDate:today,generatedAt:finishedAt,harvestWindow:null,
      taskCompletion:{resultId:1,status:'completed',activeTaskCount:0,activityCoverage:'recorded_results',
        startedAt:new Date(at.getTime()-90_000).toISOString(),completedAt:finishedAt}}),
    evidence:good({enabled:true,businessDate:today,candidates:[],dirtyMarkerPresent:false}),
    fallback:good({pending:[]}),notifications:good([{delivered:true}])};
}
function fixture(t){
  fs.mkdirSync(path.join(project,'tmp'),{recursive:true});
  const root=fs.mkdtempSync(path.join(project,'tmp/release-gate-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),executionRoot=path.join(root,'execution'),observationRoot=path.join(root,'observation'),opsRoot=path.join(root,'operations');
  const write=(file,body)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);};
  for(const directory of [source,executionRoot,observationRoot,opsRoot])fs.mkdirSync(directory,{recursive:true});
  write(path.join(source,'execution/src/runner.mjs'),'new runner');write(path.join(executionRoot,'src/runner.mjs'),'old runner');
  write(path.join(source,'observation/public/app.js'),'new app');
  write(path.join(executionRoot,'config/config.json'),'private fixture configuration');
  for(const file of ['Sync-NasShadow.ps1','Start-NasShadowScheduler.ps1','Sync-OperationsSupport.ps1','Sync-Transport.ps1'])
    write(path.join(source,'observation/scripts',file),'fixture '+file);
  write(path.join(source,'execution/scripts/Run-HiddenPowerShell.vbs'),'fixture launcher');
  return {root,source,executionRoot,observationRoot,opsRoot,revision,version:'1.0.0',files:['execution/src/runner.mjs','observation/public/app.js']};
}
const lock=async(_plan,run)=>run();
const callbacks=(probe=()=>snapshot(),rest={})=>releaseSafetyCallbacks({probe,health:()=>({healthy:false,failedChecks:['existingFailure']}),clock:()=>now,...rest});

test('settled day passes without requiring every business outcome to succeed',()=>{
  const value=snapshot();
  value.finalReport.value.results=[{status:'verification_pending'},{status:'external_blocked'},{status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}];
  assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  assert.equal(evaluateReleaseGate(value,{now}).phase,'settled');
});
const failures={
  tasks_ready:s=>{s.tasks.value[0].state='Running';},
  no_active_process:s=>{s.processes.value={count:1,roles:['evidence_worker']};},
  no_pt_lifecycle:s=>{s.lifecycle.value.exists=true;},
  no_manual_session:s=>{s.manualSessions.value[0]={exists:true,state:'pending_verification',pidActive:false};},
  final_report_today:s=>{s.finalReport.value.isComplete=false;},
  no_retry_pending:s=>{s.scheduler.value.nextEligibleAt='2026-10-31T05:00:00Z';s.scheduler.value.automaticRetryCount=1;},
  harvest_settled:s=>{s.harvest.value.taskCompletion.status='running';},
  evidence_settled:s=>{s.evidence.value.candidates=[{ptOnly:false,changedReview:false,previous:null}];},
  notifications_flushed:s=>{s.notifications.value=[{delivered:false}];}
};
for(const [code,change] of Object.entries(failures))test(`${code} rejects its own failing condition and explains it`,()=>{
  const value=snapshot();change(value);
  const result=evaluateReleaseGate(value,{now});
  assert.equal(result.ok,false);assert.deepEqual(Object.keys(result.checks).filter(key=>!result.checks[key].ok),[code]);
  assert.match(result.reasons.join(' '),new RegExp(code+': .+'));
});
test('every required source read fails closed on missing files, invalid JSON or missing fields',()=>{
  for(const key of ['tasks','processes','lifecycle','manualSessions','finalReport','scheduler','harvest','evidence','fallback','notifications']){
    for(const error of ['missing','invalid_json','read_failed']){
      const value=snapshot();value[key]={ok:false,error};
      const result=evaluateReleaseGate(value,{now});assert.equal(result.ok,false,`${key}/${error}`);assert.ok(result.reasons.some(reason=>reason.includes(error)));
    }
    const value=snapshot();delete value[key];assert.equal(evaluateReleaseGate(value,{now}).ok,false,key);
  }
  for(const [key,field] of [['processes','count'],['lifecycle','exists'],['finalReport','executionComplete'],['scheduler','automaticRetryCount'],['harvest','enabled'],['evidence','candidates']]){
    const value=snapshot();delete value[key].value[field];assert.equal(evaluateReleaseGate(value,{now}).ok,false,`${key}.${field}`);
  }
  const value=snapshot();value.notifications.value=[{}];assert.equal(evaluateReleaseGate(value,{now}).ok,false);
});
test('next trigger must exceed 75 seconds and stale snapshots cannot authorize a release',()=>{
  const value=snapshot();value.tasks.value[0].nextRunMs=now.getTime()+75_000;
  assert.equal(evaluateReleaseGate(value,{now}).checks.tasks_ready.ok,false);
  value.tasks.value[0].nextRunMs++;assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.capturedAt=new Date(now.getTime()-30_000).toISOString();assert.equal(evaluateReleaseGate(value,{now}).ok,false);
});
test('manual process and every pending handoff state use the shared assertion',()=>{
  for(const state of ['pending','pending_verification','waiting_for_user','awaiting_user','awaiting_manual_handoff','waiting_login','awaiting_login']){
    const value=snapshot();value.manualSessions.value[0]={exists:true,state,pidActive:false};
    assert.equal(evaluateReleaseGate(value,{now}).checks.no_manual_session.ok,false,state);
  }
  const value=snapshot();value.manualSessions.value[0]={exists:true,state:'handoff_complete',pidActive:true};
  assert.equal(evaluateReleaseGate(value,{now}).checks.no_manual_session.ok,false);
  value.manualSessions.value[0].pidActive=false;assert.equal(evaluateReleaseGate(value,{now}).ok,true);
});
test('missing today report and yesterday report are before_run',()=>{
  for(const report of [{ok:false,error:'missing'},good({...snapshot().finalReport.value,runId:'20261030-080500-001-abcdef',finishedAt:'2026-10-30T01:00:00Z'})]){
    const value=snapshot();value.finalReport=report;
    const result=evaluateReleaseGate(value,{now});assert.equal(result.ok,false);assert.equal(result.phase,'before_run');
  }
});
test('Shanghai midnight changes the required business day at UTC 16:00',()=>{
  const before=new Date('2026-10-31T15:59:59Z'),after=new Date('2026-10-31T16:00:00Z');
  assert.equal(shanghaiDay(before),'2026-10-31');assert.equal(shanghaiDay(after),'2026-11-01');
  assert.equal(evaluateReleaseGate(snapshot(before),{now:before}).ok,true);
  const value=snapshot(before);value.capturedAt=after.toISOString();
  const result=evaluateReleaseGate(value,{now:after});assert.equal(result.ok,false);assert.equal(result.phase,'before_run');
});
test('day override cannot skip any operational safety check',()=>{
  for(const code of ['tasks_ready','no_active_process','no_pt_lifecycle','no_manual_session']){
    const value=snapshot();failures[code](value);value.finalReport={ok:false,error:'missing'};
    const result=evaluateReleaseGate(value,{now,overrideDayGate:'emergency repair'});
    assert.equal(result.ok,false);assert.equal(result.checks[code].ok,false);assert.equal(result.checks.final_report_today.skipped,true);
  }
  const value=snapshot();delete value.finalReport;delete value.harvest;
  const result=evaluateReleaseGate(value,{now,overrideDayGate:'emergency repair'});assert.equal(result.ok,true);assert.equal(result.phase,'override');
});
test('retry schedules today block; next-day schedules and exhausted results do not',()=>{
  const value=snapshot();value.finalReport.value.results=[{status:'deferred',nextEligibleAt:'2026-10-31T08:00:00Z'}];
  assert.equal(evaluateReleaseGate(value,{now}).checks.no_retry_pending.ok,false);
  value.finalReport.value.results[0].nextEligibleAt='2026-11-01T01:00:00Z';assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.finalReport.value.results[0].nextEligibleAt='2026-10-31T01:00:00Z';value.finalReport.value.results[0].retryExhaustedForDay=true;
  assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.fallback.value.pending=[{kind:'scheduled_fallback'}];assert.equal(evaluateReleaseGate(value,{now}).checks.no_retry_pending.ok,false);
});
test('passive budgets, future steps, changed reviews and dirty publications are accounted for',()=>{
  const value=snapshot(),candidate={ptOnly:true,changedReview:false,previous:{businessDate:'2026-10-31',attempts:1,wakeups:0,totalAttempts:1,nextAttemptAt:'2026-10-31T08:00:00Z'}};
  value.evidence.value.candidates=[candidate];assert.equal(evaluateReleaseGate(value,{now}).checks.evidence_settled.ok,false);
  candidate.previous.nextAttemptAt='2026-11-01T01:00:00Z';assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  candidate.previous.attempts=2;candidate.previous.nextAttemptAt='2026-10-31T01:00:00Z';assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  candidate.changedReview=true;assert.equal(evaluateReleaseGate(value,{now}).ok,false);
  candidate.previous.totalAttempts=6;assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.evidence.value.dirtyMarkerPresent=true;assert.equal(evaluateReleaseGate(value,{now}).ok,false);
});
test('disabled Harvest is explicit; an ended failed Harvest task is settled',()=>{
  const value=snapshot();value.harvest.value.taskCompletion.status='failed';assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.harvest=good({enabled:false});value.evidence=good({enabled:false});assert.equal(evaluateReleaseGate(value,{now}).ok,true);
  value.harvest=good({});assert.equal(evaluateReleaseGate(value,{now}).ok,false);
});

test('CLI refuses an omitted ops root before planning or writing',()=>{
  const result=spawnSync(process.execPath,[path.join(project,'tools/release.mjs'),'plan'],{encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/--ops-root.*--no-ops/);
});
test('local config has relative roots; command line fields take precedence',t=>{
  const f=fixture(t),file=path.join(f.root,'release.local.json');
  save(file,{executionRoot:'execution',observationRoot:'observation',opsRoot:'operations',backupRoot:'backup',taskNames:{main:'fixture-main',sync:'fixture-sync'}});
  const options=parseReleaseOptions(['--config',file,'--execution-root',f.source,'--backup-root',f.root,'--task-names','{"main":"main-override","sync":"sync-override"}']);
  assert.equal(options.executionRoot,f.source);assert.equal(options.observationRoot,f.observationRoot);assert.equal(options.backupRoot,f.root);
  assert.equal(options.taskNames.main,'main-override');assert.equal(parseReleaseOptions(['--config',file,'--no-ops']).opsRoot,undefined);
  assert.throws(()=>parseReleaseOptions(['--no-ops','--ops-root',f.root]),/conflicts/);
  assert.throws(()=>parseReleaseOptions(['--override-day-gate','  ']),/non-empty/);
});
test('both gate evaluations precede backup creation and keep the runtime untouched on refusal',async t=>{
  for(const failAt of [1,2]){
    const f=fixture(t),plan=planRelease(f),backupRoot=path.join(f.root,'backup');let calls=0,held=false;
    const probe=()=>{calls++;assert.equal(held,calls>1);assert.equal(fs.existsSync(backupRoot),false);const value=snapshot();if(calls===failAt)value.lifecycle.value.exists=true;return value;};
    await assert.rejects(applyRelease(plan,{backupRoot,lock:async(_p,run)=>{held=true;return run();},...callbacks(probe)}),/release gate refused/);
    assert.equal(calls,failAt);assert.equal(fs.existsSync(backupRoot),false);assert.equal(fs.readFileSync(path.join(f.executionRoot,'src/runner.mjs'),'utf8'),'old runner');
  }
});
test('isolated three-root plan/apply/audit/rollback preserves private files and release markers',async t=>{
  const f=fixture(t),plan=planRelease(f);let calls=0;
  const out=await applyRelease(plan,{backupRoot:path.join(f.root,'backup'),lock,...callbacks(()=>{calls++;return snapshot();})});
  assert.equal(calls,3);assert.deepEqual(auditRelease(plan).drift,[]);assert.equal(fs.readFileSync(path.join(f.executionRoot,'config/config.json'),'utf8'),'private fixture configuration');
  for(const root of [f.executionRoot,f.observationRoot,f.opsRoot])assert.equal(JSON.parse(fs.readFileSync(path.join(root,'release.json'))).revision,revision);
  const record=JSON.parse(fs.readFileSync(path.join(out.backup,'release-record.json')));
  assert.equal(record.preflight.gate.ok,true);assert.equal(record.baseline.gate.ok,true);assert.deepEqual(record.baseline.health.failedChecks,['existingFailure']);assert.equal(record.validation.ok,true);
  await rollbackRelease(out.backup,{lock});assert.equal(fs.readFileSync(path.join(f.executionRoot,'src/runner.mjs'),'utf8'),'old runner');
  assert.equal(fs.existsSync(path.join(f.observationRoot,'public/app.js')),false);
});
for(const kind of ['audit','task definition','schedule boundary','health','health unreadable'])test(`post-apply ${kind} failure automatically restores files and records rollback`,async t=>{
  const f=fixture(t),plan=planRelease(f);let calls=0,healthCalls=0;
  const probe=()=>{const value=snapshot();if(++calls===3){if(kind==='task definition')value.tasks.value[0].definitionHash='c'.repeat(64);if(kind==='schedule boundary')value.tasks.value[0].lastRun=now.toISOString();}return value;};
  const health=()=>{healthCalls++;if(healthCalls===2&&kind==='health unreadable')throw Error('fixture health read failed');return {healthy:false,failedChecks:healthCalls===2&&kind==='health'?['existingFailure','newFailure']:['existingFailure']};};
  const audit=kind==='audit'?()=>({drift:['fixture'],dependencyDrift:[]}):auditRelease;
  const before=Buffer.from('old marker');fs.writeFileSync(path.join(f.executionRoot,'release.json'),before);
  await assert.rejects(applyRelease(plan,{backupRoot:path.join(f.root,'backup'),lock,...callbacks(probe,{health,audit})}),error=>{
    assert.equal(error.rollback.ok,true);const record=JSON.parse(fs.readFileSync(path.join(error.backup,'release-record.json')));
    assert.equal(record.status,'validation_failed');assert.equal(record.rollback.ok,true);return true;
  });
  assert.equal(fs.readFileSync(path.join(f.executionRoot,'src/runner.mjs'),'utf8'),'old runner');
  assert.deepEqual(fs.readFileSync(path.join(f.executionRoot,'release.json')),before);
  assert.equal(fs.existsSync(path.join(f.observationRoot,'public/app.js')),false);
});
test('automatic rollback still refuses independent runtime drift',async t=>{
  const f=fixture(t),plan=planRelease(f);
  const health=(()=>{let calls=0;return ()=>{if(++calls===2){fs.writeFileSync(path.join(f.executionRoot,'src/runner.mjs'),'independent edit');return {failedChecks:['newFailure']};}return {failedChecks:[]};};})();
  await assert.rejects(applyRelease(plan,{backupRoot:path.join(f.root,'backup'),lock,...callbacks(undefined,{health})}),error=>{assert.equal(error.rollback.ok,false);return true;});
  assert.equal(fs.readFileSync(path.join(f.executionRoot,'src/runner.mjs'),'utf8'),'independent edit');
});
test('override reason is saved with both gate results',async t=>{
  const f=fixture(t),plan=planRelease(f),out=await applyRelease(plan,{backupRoot:path.join(f.root,'backup'),lock,
    ...callbacks(()=>{const value=snapshot();delete value.finalReport;return value;},{overrideDayGate:'emergency fixture repair'})});
  const record=JSON.parse(fs.readFileSync(path.join(out.backup,'release-record.json')));
  assert.equal(record.preflight.overrideDayGate,'emergency fixture repair');assert.equal(record.baseline.gate.checks.final_report_today.reason,'emergency fixture repair');
});

const deployedAt='2026-10-31T02:00:00Z';
function verificationSnapshot(){
  const value=snapshot();value.markers=good(Object.fromEntries(['execution','observation','operations'].map(role=>[role,{revision,deployedAt}])));
  value.gatewayEvents=good([]);return value;
}
const verifyOptions={revision,roots:['execution','observation','operations'],deployedAt};
test('verification distinguishes pending, pass and fail, including result codes 267009 and 2',()=>{
  const value=verificationSnapshot();assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pass');
  value.tasks.value[0].lastResult=2;assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pass');
  value.tasks.value[0].lastResult=267009;assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pending');
  value.tasks.value[0].lastResult=2;value.finalReport.value.finishedAt='2026-10-31T01:00:00Z';assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pending');
  value.tasks.value[0].lastResult=1;assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'fail');
});
test('verification waits for a new report when a successful post-deployment main run is a no-op',()=>{
  const value=verificationSnapshot();value.finalReport.value.finishedAt='2026-10-31T01:00:00Z';
  const result=evaluateReleaseVerification(value,verifyOptions);
  assert.equal(result.status,'pending');assert.deepEqual(result.reasons,['waiting for a new final report after deployment']);
});
test('verification accepts a post-deployment final report before later main no-ops',()=>{
  const value=verificationSnapshot();value.finalReport.value.finishedAt='2026-10-31T02:05:00Z';
  assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pass');
  value.finalReport.value.isComplete=false;assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'fail');
  value.finalReport.value.isComplete=true;value.finalReport.value.finishedAt='2026-10-31T04:00:01Z';
  assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'fail');
});
test('verification still rejects a failed main task with either an old or new report',()=>{
  for(const finishedAt of ['2026-10-31T01:00:00Z','2026-10-31T02:05:00Z']){
    const value=verificationSnapshot();value.tasks.value[0].lastResult=1;value.finalReport.value.finishedAt=finishedAt;
    const result=evaluateReleaseVerification(value,verifyOptions);
    assert.equal(result.status,'fail');assert.match(result.reasons.join(' '),/main task result rejected/);
  }
});
test('verification rejects markers, new gateway errors, residual lifecycle and bad evidence',()=>{
  for(const mutate of [s=>s.markers.value.operations.revision='c'.repeat(40),s=>s.gatewayEvents.value.push({time:deployedAt}),
    s=>s.lifecycle.value.exists=true,s=>s.gatewayEvents={ok:false,error:'invalid_json'},s=>s.finalReport.value.isComplete=false,
    s=>s.tasks.value.find(task=>task.role==='sync').lastResult=2]){
    const value=verificationSnapshot();mutate(value);assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'fail');
  }
  const value=verificationSnapshot();value.tasks.value.forEach(task=>task.lastRun='2026-10-31T01:00:00Z');assert.equal(evaluateReleaseVerification(value,verifyOptions).status,'pending');
});
test('verify CLI maps pass/pending/fail to 0/3/1 without mutating files',async t=>{
  const f=fixture(t),plan=planRelease(f),file=path.join(f.root,'manifest.json');save(file,plan);
  for(const [code,change] of [[0,()=>{}],[3,s=>{s.tasks.value[0].lastResult=267009;}],[1,s=>{s.lifecycle.value.exists=true;}]]){
    const value=verificationSnapshot();change(value);let body;
    const result=await runReleaseCli(['verify','--manifest',file],{probe:()=>value,stdout:text=>{body=JSON.parse(text);},stderr:assert.fail});
    assert.equal(result,code);assert.equal(body.status,{0:'pass',3:'pending',1:'fail'}[code]);
    assert.equal(fs.readFileSync(path.join(f.executionRoot,'src/runner.mjs'),'utf8'),'old runner');assert.equal(fs.existsSync(path.join(f.root,'backup')),false);
  }
  assert.equal(verifyRelease(plan,{probe:()=>{throw Error('unavailable');}}).status,'fail');
});
function guardReadOnly(t){
  const open=fs.openSync;
  for(const method of ['mkdirSync','writeFileSync','renameSync','unlinkSync','rmSync'])
    t.mock.method(fs,method,()=>assert.fail(`read-only CLI called ${method}`));
  t.mock.method(fs,'openSync',(file,flags,...args)=>{
    assert.ok(flags==='r'||flags===fs.constants.O_RDONLY,'read-only CLI tried to create a file or lock');
    return open(file,flags,...args);
  });
}
for(const allowed of [true,false])test(`gate CLI returns ${allowed?0:3} without locking or writing`,async t=>{
  const f=fixture(t),plan=planRelease(f),file=path.join(f.root,'manifest.json');save(file,plan);
  guardReadOnly(t);
  try{
    let body,calls=0;
    const result=await runReleaseCli(['gate','--manifest',file],{
      probe:current=>{calls++;assert.deepEqual(current,plan);const value=snapshot(new Date());if(!allowed)value.lifecycle.value.exists=true;return value;},
      stdout:text=>{body=JSON.parse(text);},stderr:assert.fail
    });
    assert.equal(result,allowed?0:3);assert.equal(body.ok,allowed);assert.equal(calls,1);
  }finally{t.mock.restoreAll();}
});
test('gate CLI returns 1 for a missing manifest without probing, locking or writing',async t=>{
  const f=fixture(t);guardReadOnly(t);
  try{
    for(const args of [[],['--manifest',path.join(f.root,'missing.json')]]){
      let error;
      const result=await runReleaseCli(['gate',...args],{probe:assert.fail,stdout:assert.fail,stderr:text=>{error=text;}});
      assert.equal(result,1);assert.match(error,/manifest.*(?:required|missing)/);
    }
  }finally{t.mock.restoreAll();}
});
test('probe execution is bounded at 15 seconds and health errors cannot become an empty failure set',()=>{
  const plan={roots:{execution:'execution',observation:'observation',operations:'operations'}};
  const result=probeRelease(plan,{taskNames:{main:'fixture-main',sync:'fixture-sync'},exec:(_shell,args,options)=>{
    assert.equal(options.timeout,15_000);assert.equal(options.windowsHide,true);assert.ok(args.includes('-File'));return JSON.stringify(snapshot());
  }});assert.equal(result.schemaVersion,1);
  assert.throws(()=>probeRelease(plan,{taskNames:{main:'fixture-main',sync:'fixture-sync'},exec:()=>'{broken'}),/unavailable/);
  assert.throws(()=>checkReleaseHealth(plan,{spawn:()=>({status:1,stdout:'{}'})}),/health check/);
  assert.deepEqual(checkReleaseHealth(plan,{spawn:()=>({status:2,stdout:'{"healthy":false,"failedChecks":["existingFailure"]}'})}).failedChecks,['existingFailure']);
  assert.throws(()=>checkReleaseHealth(plan,{spawn:()=>({status:3,stdout:'{"healthy":false,"failedChecks":["healthCheckExecution"]}'})}),/health check/);
});

function probeFixture(t){
  const f=fixture(t),at=new Date(),value=snapshot(at),today=shanghaiDay(at);
  save(path.join(f.executionRoot,'logs/latest.json'),value.finalReport.value);
  save(path.join(f.executionRoot,'data/scheduler-state.json'),value.scheduler.value);
  save(path.join(f.executionRoot,'data/notification-outbox/item.json'),{delivered:true,account:'fixture-secret'});
  save(path.join(f.opsRoot,'config/pt-monitor.local.json'),{harvestDatabase:'<database-placeholder>'});
  save(path.join(f.opsRoot,'tmp/nas-sync/harvest-pt-status.json'),{...value.harvest.value,source:'harvest'});
  save(path.join(f.opsRoot,'tmp/nas-sync/pt-monitor-catalog.json'),{sites:[]});
  save(path.join(f.observationRoot,'outputs/shadow-beta-snapshot.json'),{businessDate:today,tasks:[],receipts:[],ptStatus:{sites:[],harvestWindow:null}});
  save(path.join(f.observationRoot,'data/pt-evidence-repair.json'),{sites:{}});
  save(path.join(f.observationRoot,`outputs/harvest-fallback-attempts-${today}.json`),{businessDate:today,attempts:[]});
  const q=text=>"'"+text.replaceAll("'","''")+"'";
  const run=(processes=[])=>{
    const code=`
function Get-ScheduledTask { [CmdletBinding()]param($TaskName) [pscustomobject]@{State='Ready'} }
function Get-ScheduledTaskInfo { [CmdletBinding()]param($TaskName) [pscustomobject]@{LastRunTime=[datetimeoffset]::UtcNow.AddMinutes(-2);LastTaskResult=0;NextRunTime=[datetimeoffset]::UtcNow.AddMinutes(5)} }
function Export-ScheduledTask { [CmdletBinding()]param($TaskName) '<Task />' }
function Get-CimInstance { [CmdletBinding()]param($ClassName,$Filter) ConvertFrom-Json -InputObject ${q(JSON.stringify(processes))} }
& ${q(path.join(project,'tools/release-probe.ps1'))} -ExecutionRoot ${q(f.executionRoot)} -ObservationRoot ${q(f.observationRoot)} -OpsRoot ${q(f.opsRoot)} -TaskNamesJson '{"main":"fixture-main","sync":"fixture-sync"}'
`;
    return JSON.parse(execFileSync(process.platform==='win32'?'pwsh.exe':'pwsh',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',timeout:15_000}));
  };
  return {...f,run};
}
test('probe records unreadable command lines without hiding a readable project process',t=>{
  const f=probeFixture(t),unreadable={ProcessId:2147483647,Name:'powershell.exe',CommandLine:null};
  let value=f.run([unreadable]);
  assert.equal(value.processes.ok,true);assert.deepEqual(value.processes.value,{count:0,roles:[],unreadable:1});
  assert.equal(evaluateReleaseGate(value,{now:new Date()}).checks.no_active_process.ok,true);
  value=f.run([unreadable,{ProcessId:2147483646,Name:'node.exe',CommandLine:`node "${path.join(f.observationRoot,'scripts/run-v1-engine.mjs')}"`}]);
  assert.equal(value.processes.value.count,1);assert.equal(value.processes.value.unreadable,1);
  assert.equal(evaluateReleaseGate(value,{now:new Date()}).checks.no_active_process.ok,false);
});
test('PowerShell probe reads synthetic files and mocked task queries without disclosing private values',t=>{
  const f=probeFixture(t),value=f.run();
  const gate=evaluateReleaseGate(value,{now:new Date()});assert.equal(gate.ok,true,JSON.stringify(gate));
  assert.equal(value.markers.ok,false);assert.deepEqual(value.gatewayEvents.value,[]);
  const output=JSON.stringify(value);assert.equal(output.includes('fixture-secret'),false);assert.equal(output.includes(f.root),false);assert.equal(output.includes('CommandLine'),false);
  fs.writeFileSync(path.join(f.executionRoot,'logs/latest.json'),'{broken');
  const corrupt=f.run();assert.equal(corrupt.finalReport.error,'invalid_json');assert.equal(evaluateReleaseGate(corrupt,{now:new Date()}).ok,false);
  fs.unlinkSync(path.join(f.executionRoot,'logs/latest.json'));assert.equal(f.run().finalReport.error,'missing');
});
test('probe traces passive candidates and budgets while stripping account/site identities',t=>{
  const f=probeFixture(t),today=shanghaiDay(new Date()),origin='https://review.example.test',at=new Date(Date.now()-120_000).toISOString();
  const output=path.join(f.observationRoot,'outputs/shadow-beta-snapshot.json');
  save(path.join(f.opsRoot,'tmp/nas-sync/pt-monitor-catalog.json'),{sites:[{origin}]});
  save(output,{businessDate:today,tasks:[{origin,taskId:'fixture-task',observedStatus:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}],receipts:[],ptStatus:{sites:[],harvestWindow:null}});
  const stateFile=path.join(f.observationRoot,'data/pt-evidence-repair.json');
  const old={businessDate:today,attempts:2,wakeups:0,checkedAt:at,nextAttemptAt:at};
  save(stateFile,{sites:{[origin]:old}});
  let value=f.run();assert.equal(evaluateReleaseGate(value,{now:new Date()}).ok,true,JSON.stringify(value.evidence));
  assert.equal(JSON.stringify(value).includes(origin),false);assert.equal(value.evidence.value.candidates.length,1);
  old.attempts=1;save(stateFile,{sites:{[origin]:old}});value=f.run();
  assert.equal(evaluateReleaseGate(value,{now:new Date()}).checks.evidence_settled.ok,false);
  fs.writeFileSync(stateFile,'{broken');assert.equal(f.run().evidence.error,'invalid_json');
});
test('probe does not treat superseded deferred audits or exhausted fallback budgets as pending',t=>{
  const f=probeFixture(t),today=shanghaiDay(new Date()),origin='https://fallback.example.test',at=new Date(Date.now()-120_000).toISOString();
  const file=path.join(f.observationRoot,`outputs/harvest-fallback-attempts-${today}.json`);
  const busy={origin,state:'deferred_busy',nextEligibleAt:at},completed={origin,state:'completed',v1Status:'signed'};
  save(file,{businessDate:today,attempts:[busy,completed],verifications:[]});
  assert.deepEqual(f.run().fallback.value.pending,[]);
  save(file,{businessDate:today,attempts:[busy],verifications:[]});assert.equal(f.run().fallback.value.pending.length,1);
  save(file,{businessDate:today,attempts:[completed,completed,completed,busy],verifications:[]});assert.deepEqual(f.run().fallback.value.pending,[]);
  save(path.join(f.observationRoot,`outputs/pt-fallback-results-${today}.json`),{businessDate:today,sites:[{status:'not_signed',submissionAttempted:false,evidence:{authoritative:true,confirmedAt:at}}]});
  assert.equal(f.run().fallback.value.pending[0].kind,'unsettled_unsigned_wakeup');
});

function fallbackProbeFixture(t){
  const f=probeFixture(t),today=shanghaiDay(new Date()),origin='https://fallback.example.test',startedAt=`${today}T00:00:00+08:00`;
  const verification={origin,accountKey:'fixture-account',state:'not_signed',startedAt,outcome:{status:'not_signed'}};
  const audit={businessDate:today,attempts:[],verifications:[verification]};
  const view={businessDate:today,tasks:[],receipts:[],ptStatus:{sites:[],harvestWindow:null}};
  const effective={status:'signed',authoritative:true,fresh:true,observedAt:startedAt};
  const site={origin,accountKey:verification.accountKey,capabilities:{read:true},effective};
  const run=()=>{
    save(path.join(f.observationRoot,`outputs/harvest-fallback-attempts-${today}.json`),audit);
    save(path.join(f.observationRoot,'outputs/shadow-beta-snapshot.json'),view);
    const value=f.run();assert.equal(value.fallback.ok,true,JSON.stringify(value.fallback));
    const pending=value.fallback.value.pending;
    assert.equal(evaluateReleaseGate(value,{now:new Date()}).checks.no_retry_pending.ok,pending.length===0);
    return pending;
  };
  return {...f,today,origin,startedAt,verification,audit,view,effective,site,run};
}
test('probe settles passive verification after a completed successful attempt for the same identity today',t=>{
  const f=fallbackProbeFixture(t);
  for(const status of ['signed','already_signed']){
    f.audit.attempts=[{origin:f.origin,accountKey:f.verification.accountKey,businessDate:f.today,state:'completed',outcome:{status}}];
    assert.deepEqual(f.run(),[]);
  }
  delete f.verification.accountKey;delete f.audit.attempts[0].accountKey;
  assert.deepEqual(f.run(),[]);
});
test('probe does not use another origin or account successful attempt to settle passive verification',t=>{
  const f=fallbackProbeFixture(t);
  for(const other of [{origin:'https://other.example.test',accountKey:f.verification.accountKey},{origin:f.origin,accountKey:'another-account'}]){
    f.audit.attempts=[{...other,businessDate:f.today,state:'completed',outcome:{status:'signed'}}];
    assert.deepEqual(f.run(),[{kind:'unsettled_passive_fallback_budget'}]);
  }
});
test('probe settles unverified passive checks using a unique origin completed authoritatively today',t=>{
  const f=fallbackProbeFixture(t);f.verification.state='unverified';f.verification.outcome={};f.view.ptStatus.sites=[f.site];
  for(const status of ['signed','already_signed']){
    f.effective.status=status;assert.deepEqual(f.run(),[]);
  }
});
test('probe keeps passive verification pending when effective completion is from yesterday in Shanghai',t=>{
  const f=fallbackProbeFixture(t);f.verification.state='unverified';f.verification.outcome={};f.view.ptStatus.sites=[f.site];
  f.effective.observedAt=new Date(Date.parse(f.startedAt)-1).toISOString();
  assert.deepEqual(f.run(),[{kind:'unsettled_passive_fallback_budget'}]);
});
test('probe requires authoritative fresh successful effective evidence with a timestamp',t=>{
  const f=fallbackProbeFixture(t);f.verification.state='unverified';f.view.ptStatus.sites=[f.site];
  for(const change of [{authoritative:false},{fresh:false},{status:'not_signed'},{observedAt:null}]){
    f.site.effective={...f.effective,...change};assert.deepEqual(f.run(),[{kind:'unsettled_passive_fallback_budget'}]);
  }
});
test('probe keeps passive verification pending for multiple accounts at one origin',t=>{
  const f=fallbackProbeFixture(t);f.view.ptStatus.sites=[f.site,{...f.site,accountKey:'another-account'}];
  assert.deepEqual(f.run(),[{kind:'unsettled_passive_fallback_budget'}]);
});
test('probe keeps in-progress fallback pending despite authoritative effective completion',t=>{
  const f=fallbackProbeFixture(t);f.view.ptStatus.sites=[f.site];
  for(const kind of ['attempts','verifications']){
    f.audit[kind].push({...f.verification,state:'in_progress'});
    assert.deepEqual(f.run(),[{kind:'active_fallback'}]);f.audit[kind].pop();
  }
});
test('probe preserves due deferred, Harvest and unsigned wakeups despite effective completion',t=>{
  const f=fallbackProbeFixture(t);f.view.ptStatus.sites=[f.site];
  for(const state of ['deferred_busy','deferred_preflight']){
    f.verification.state=state;f.verification.nextEligibleAt=f.startedAt;
    assert.deepEqual(f.run(),[{kind:'scheduled_fallback'}]);
  }
  f.verification.state='not_signed';
  f.audit.attempts=[{origin:f.origin,accountKey:f.verification.accountKey,state:'completed',submissionState:'not_submitted',v1Status:'deferred'}];
  assert.deepEqual(f.run(),[{kind:'harvest_wakeup'}]);f.audit.attempts=[];
  save(path.join(f.observationRoot,`outputs/pt-fallback-results-${f.today}.json`),{businessDate:f.today,sites:[{
    status:'not_signed',submissionAttempted:false,evidence:{authoritative:true,confirmedAt:new Date().toISOString()}
  }]});
  assert.deepEqual(f.run(),[{kind:'unsettled_unsigned_wakeup'}]);
});
test('probe permits a site_maintenance outcome after its passive budget is exhausted',t=>{
  const f=fallbackProbeFixture(t);
  f.audit.verifications=Array.from({length:3},()=>({...f.verification,state:'unverified',outcome:{status:'site_maintenance'}}));
  assert.deepEqual(f.run(),[]);
});
