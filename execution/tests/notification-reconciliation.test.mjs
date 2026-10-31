import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {notificationOverrides,notificationAvailability,notificationSupplementalResults,reconcileNotification,notificationVerdict} from '../src/notification-reconciliation.mjs';
import {authorizedWorkload} from '../../observation/src/workload-view.mjs';
import {confirmedPtByTask} from '../../observation/src/daily-reconciliation.mjs';
import {commitDashboardGeneration} from '../../observation/src/dashboard-generation.mjs';
import {accountRef,planHash,taskIdentity} from '../../observation/src/contracts.mjs';

function digestSandbox(t){
  const now=new Date('2026-10-31T02:50:00Z'),f=sandbox(t,now);
  const configFile=path.join(f.root,'config/config.json'),outbox=path.join(f.root,'data/notification-outbox');
  fs.copyFileSync(path.join(sourceRoot,'config/defaults.json'),path.join(f.root,'config/defaults.json'));
  const notification={mode:'command',executable:process.execPath,arguments:[],taskId:'synthetic-daily',name:'合成日报',source:'test-suite'};
  fs.writeFileSync(configFile,JSON.stringify({nodeExecutable:process.execPath,notification}));
  f.save=()=>{
    fs.writeFileSync(f.reportFile,JSON.stringify(f.report));f.snapshot.planHash=planHash(f.snapshot.tasks);
    const ledgerFile=path.join(f.controller,'outputs/shadow-ledger.jsonl');
    fs.writeFileSync(ledgerFile,JSON.stringify({schemaVersion:1,snapshotId:f.snapshot.snapshotId,businessDate:f.snapshot.businessDate,
      planHash:f.snapshot.planHash,recordedAt:f.snapshot.generatedAt})+'\n');
    commitDashboardGeneration({snapshot:f.snapshot,snapshotFile:path.join(f.controller,'outputs/shadow-beta-snapshot.json'),ledgerFile});
  };
  f.run=(at='2026-10-31T03:00:00Z',args=[])=>JSON.parse(execFileSync('pwsh.exe',[
    '-NoProfile','-NonInteractive','-File',path.join(f.root,'scripts/Submit-UnifiedCheckinReport.ps1'),
    '-ReportPath',f.reportFile,'-NowUtc',at,...args],{encoding:'utf8',windowsHide:true,timeout:30_000,stdio:['ignore','pipe','pipe']}).trim());
  f.items=()=>fs.existsSync(outbox)?fs.readdirSync(outbox).filter(file=>file.endsWith('.json')).map(file=>
    JSON.parse(fs.readFileSync(path.join(outbox,file),'utf8'))):[];
  f.mark=(index,patch)=>{
    Object.assign(f.report.results[index],patch,{observedAt:now.toISOString()});
    Object.assign(f.snapshot.tasks[index],patch,{observedStatus:patch.status,observedAt:now.toISOString()});
    Object.assign(f.snapshot.receipts[index],{status:patch.status,observedAt:now.toISOString(),evidence:patch.evidence??{authoritative:false,verification:'unverified'}});
    f.save();
  };
  f.notification=notification;f.configFile=configFile;f.outbox=outbox;
  return f;
}

test('daily digest inherits defaults, defers before 11, freezes one daily event and resets next day',t=>{
  const f=digestSandbox(t),before=fs.readFileSync(f.configFile,'utf8');
  const early=f.run('2026-10-31T02:59:59Z');assert.equal(early.deferred,true);assert.equal(f.items().length,0);
  const first=f.run();assert.equal(first.enqueued,true);assert.equal(first.events.length,1);
  assert.equal(first.events[0].category,'daily_digest');assert.equal(first.status,'unconfirmed');
  const saved=f.items()[0];assert.match(saved.eventKey,/:2026-10-31$/);
  assert.equal(f.run().deferred,true);assert.deepEqual(f.items(),[saved]);
  f.mark(1,{status:'signed',evidence:{source:'pt_page',authoritative:true,businessDate:f.date,confirmedAt:'2026-10-31T02:50:00Z'}});
  const changed=f.run();assert.equal(changed.status,'success');assert.equal(changed.events.length,0);assert.deepEqual(f.items(),[saved]);
  const next='2026-11-01',nextAt=next+'T03:00:00Z';
  f.report.runId=next.replaceAll('-','')+'-fixture';f.report.finishedAt=nextAt;
  f.snapshot.businessDate=next;f.snapshot.generatedAt=nextAt;f.snapshot.source.runId=f.report.runId;
  f.snapshot.tasks.forEach(task=>{task.businessDate=next;});f.snapshot.ptStatus.businessDate=next;
  f.save();assert.equal(f.run(nextAt).events.filter(event=>event.category==='daily_digest').length,1);
  assert.equal(f.items().length,2);assert.equal(fs.readFileSync(f.configFile,'utf8'),before);
});

test('only new action-needed sites alert, shrinking or repeated sets and verification/external changes stay silent',t=>{
  const f=digestSandbox(t),early='2026-10-31T02:59:00Z';
  f.mark(1,{status:'login_required',retryable:false,reason:'synthetic-account-marker user@example.com https://secret.example'});
  let output=f.run(early);assert.deepEqual(output.events.map(event=>event.category),['action_needed']);
  assert.equal(output.status,'needs_attention');assert.equal(f.run(early).events.length,0);
  const extra=structuredClone(f.snapshot.tasks[1]);extra.taskId='extra_task';extra.origin='https://new-action.example';
  f.snapshot.tasks.push(extra);f.snapshot.receipts.push({...f.snapshot.receipts[1],taskId:extra.taskId});
  f.report.bookmarkSummary.targets.push({origin:extra.origin,accountKey:'site-default'});
  f.report.results.push({...f.report.results[1],origin:extra.origin});
  f.report.plannedTotal=3;f.report.processedTotal=3;f.save();
  output=f.run(early);assert.deepEqual(output.events.map(event=>event.category),['action_needed']);
  f.mark(1,{status:'needs_attention',retryable:true,failureCode:'submission_outcome_unknown',submissionAttempted:true});
  assert.equal(f.run(early).events.length,0);
  f.snapshot.tasks[2].failureCode='site_maintenance';f.snapshot.tasks[2].retryable=true;f.save();
  assert.equal(f.run(early).events.length,0);assert.equal(f.items().length,2);
  for(const item of f.items())assert.doesNotMatch(item.summary,/synthetic-account-marker|@|https?:\/\//);
});

test('yesterday final report defers digest and actions, then today final report supplies the one immutable digest',t=>{
  const f=digestSandbox(t);
  f.mark(1,{status:'login_required',retryable:false});
  const todayReport=structuredClone(f.report),todaySnapshot=structuredClone(f.snapshot);
  f.report.runId='20261030-fixture';f.report.finishedAt='2026-10-30T02:50:00Z';
  f.snapshot.businessDate='2026-10-30';f.snapshot.generatedAt=f.report.finishedAt;
  f.snapshot.source.runId=f.report.runId;f.snapshot.ptStatus.businessDate='2026-10-30';
  for(const task of f.snapshot.tasks){task.businessDate='2026-10-30';task.observedAt=f.report.finishedAt;}
  for(const receipt of f.snapshot.receipts)receipt.observedAt=f.report.finishedAt;
  f.save();
  const before=f.run('2026-10-31T03:30:00Z');
  assert.equal(before.deferred,true);assert.deepEqual(before.events,[]);assert.equal(f.items().length,0);
  // A current action view alone must not turn yesterday's final report into today's alert.
  Object.assign(f.snapshot,todaySnapshot);f.save();
  assert.deepEqual(f.run('2026-10-31T03:30:00Z').events,[]);
  Object.assign(f.report,todayReport);f.save();
  f.mark(0,{status:'signed',evidence:{source:'pt_page',authoritative:true,businessDate:f.date,confirmedAt:'2026-10-31T02:50:00Z'}});
  const ready=f.run('2026-10-31T05:00:00Z');
  assert.deepEqual(ready.events.map(event=>event.category),['action_needed','daily_digest']);
  assert.deepEqual(ready.dayVerdict.counts,{done:1,verifying:0,actionNeeded:1,external:0,paused:0,noFeature:0});
  assert.match(ready.events.find(event=>event.category==='daily_digest').summary,/有效 2：已完成 1，核验中 0，需处理 1/);
  const saved=f.items();assert.equal(f.run('2026-10-31T06:00:00Z').deferred,true);assert.deepEqual(f.items(),saved);
});

test('regular-task digest waits for noon while authorized workload can publish at 11:05',t=>{
  const authorized=digestSandbox(t);
  const full=authorized.run('2026-10-31T03:05:00Z');
  assert.equal(full.scope,'authorized_workload');assert.deepEqual(full.events.map(event=>event.category),['daily_digest']);
  const regular=digestSandbox(t);
  for(const name of ['dashboard-generation.json','dashboard-generation.previous.json','shadow-beta-snapshot.json'])
    fs.rmSync(path.join(regular.controller,'outputs',name),{force:true});
  const early=regular.run('2026-10-31T03:05:00Z');
  assert.equal(early.scope,'regular_tasks');assert.equal(early.deferred,true);assert.equal(regular.items().length,0);
  const later=regular.run('2026-10-31T04:05:00Z');
  assert.deepEqual(later.events.map(event=>event.category),['daily_digest']);assert.match(later.summary,/仅主任务口径/);
  assert.equal(regular.run('2026-10-31T05:00:00Z').events.length,0);
});

for(const [exitCode,runnerStatus,expected] of [[0,'completed',[]],[2,'completed',[]],[1,'completed',['run_failed']],[0,'timeout',['run_failed']]]){
  test(`finished scheduler exit ${exitCode}, runner ${runnerStatus}: failure alert follows execution semantics`,t=>{
    const f=digestSandbox(t);
    fs.writeFileSync(path.join(f.root,'data/scheduler-state.json'),JSON.stringify({lastAttemptDate:f.date,
      lastFinishedAt:f.report.finishedAt,phase:'finished',automaticRetryCount:0,nextEligibleAt:null,lastExitCode:exitCode}));
    const output=f.run('2026-10-31T02:59:00Z',['-RunnerStatus',runnerStatus]);
    assert.deepEqual(output.events.map(event=>event.category),expected);
    assert.equal(f.items().length,expected.length);
    assert.equal(f.run('2026-10-31T02:59:00Z',['-RunnerStatus',runnerStatus]).events.length,0);
  });
}

test('retryable login, waiting, external and cleanup warnings alone never create exception alerts',t=>{
  const f=digestSandbox(t);
  for(const patch of [{status:'login_required',retryable:true,nextEligibleAt:'2026-10-31T04:00:00Z'},
    {status:'needs_attention',failureCode:'site_maintenance'},
    {status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,cleanupFailureCode:'window_cleanup_failed'},
    {status:'deferred',retryCause:'harvest_waiting'}]){
    f.mark(1,patch);assert.equal(f.run('2026-10-31T02:59:00Z').events.length,0);
  }
  assert.equal(f.items().length,0);
});

test('run failure requires confirmed absence of another automatic retry; failure and identity conflict each alert once',t=>{
  const f=digestSandbox(t),early='2026-10-31T02:59:00Z',file=path.join(f.root,'data/scheduler-state.json');
  assert.equal(f.run(early,['-RunnerStatus','failed']).events.length,0);
  const state={lastAttemptDate:f.date,lastFinishedAt:f.report.finishedAt,phase:'finished',automaticRetryCount:1,nextEligibleAt:'2026-10-31T04:00:00Z',lastExitCode:1};
  fs.writeFileSync(file,JSON.stringify(state));assert.equal(f.run(early,['-RunnerStatus','timeout']).events.length,0);
  Object.assign(state,{automaticRetryCount:0,nextEligibleAt:null});fs.writeFileSync(file,JSON.stringify(state));
  assert.deepEqual(f.run(early,['-RunnerStatus','failed']).events.map(event=>event.category),['run_failed']);
  assert.equal(f.run(early,['-RunnerStatus','timeout']).events.length,0);
  f.snapshot.receipts[0].evidence={verification:'identity_conflict',authoritative:false};
  f.snapshot.receipts[0].observedAt=f.report.finishedAt;f.save();
  assert.deepEqual(f.run(early).events.map(event=>event.category),['identity_conflict']);
  assert.equal(f.run(early).events.length,0);assert.equal(f.items().length,2);
});

test('sync-path missing-run check waits until noon, requires no final report and alerts once',t=>{
  const f=digestSandbox(t);
  f.run();f.report.runState='partial';f.report.isComplete=false;f.save();
  assert.equal(f.run('2026-10-31T03:59:59Z',['-CheckRunMissing']).events.length,0);
  assert.deepEqual(f.run('2026-10-31T04:00:00Z',['-CheckRunMissing']).events.map(event=>event.category),['run_missing']);
  assert.equal(f.run('2026-10-31T04:01:00Z',['-CheckRunMissing']).events.length,0);
  f.report.runState='final';f.report.isComplete=true;f.save();
  assert.equal(f.run('2026-10-31T04:02:00Z',['-CheckRunMissing']).events.length,0);
});

test('sync missing-run check also covers an absent or corrupt final report without running the engine',t=>{
  for(const corrupt of [false,true]){
    const f=digestSandbox(t);
    if(corrupt)fs.writeFileSync(f.reportFile,'{');else fs.rmSync(f.reportFile);
    const output=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
      path.join(f.root,'scripts/Submit-UnifiedCheckinReport.ps1'),'-CheckRunMissing','-NowUtc','2026-10-31T04:00:00Z',
      ...(corrupt?['-ReportPath',f.reportFile]:[])],{encoding:'utf8',windowsHide:true,timeout:30_000,stdio:['ignore','pipe','pipe']}).trim());
    assert.deepEqual(output.events.map(event=>event.category),['run_missing']);assert.equal(f.items().length,1);
  }
});

test('digest omits paused sites from work/actions, removes account details, limits text, Preview and none do not write',t=>{
  const f=digestSandbox(t);
  f.mark(1,{status:'not_available',availabilityKind:'task_disabled',disabledByConfig:true,accountLabel:'synthetic-account-marker',
    reason:'synthetic-account-marker user@example.com https://secret.example'});
  const preview=f.run(undefined,['-Preview']);assert.equal(preview.dayVerdict.counts.paused,1);
  assert.equal(preview.dayVerdict.total,1);assert.equal(preview.dayVerdict.counts.actionNeeded,0);
  assert.match(preview.summary,/已暂停 1/);assert.doesNotMatch(preview.summary,/synthetic-account-marker|@|https?:\/\//);
  assert.ok(preview.summary.length<=950);assert.equal(f.items().length,0);
  f.notification.mode='none';fs.writeFileSync(f.configFile,JSON.stringify({notification:f.notification,nodeExecutable:process.execPath}));
  assert.equal(f.run().enqueued,false);assert.equal(f.items().length,0);
});

test('daily and exception events use the unchanged outbox, survive delivery independently and never refresh a delivered body',t=>{
  const f=digestSandbox(t);f.mark(1,{status:'login_required',retryable:false});
  fs.writeFileSync(path.join(f.root,'data/scheduler-state.json'),JSON.stringify({lastAttemptDate:f.date,
    lastFinishedAt:f.report.finishedAt,phase:'finished',automaticRetryCount:0,nextEligibleAt:null,lastExitCode:1}));
  const output=f.run();assert.deepEqual(output.events.map(event=>event.category),['action_needed','daily_digest','run_failed']);
  f.snapshot.receipts[0].evidence={verification:'identity_conflict',authoritative:false};
  f.snapshot.receipts[0].observedAt=f.report.finishedAt;f.save();
  assert.deepEqual(f.run('2026-10-31T03:01:00Z').events.map(event=>event.category),['identity_conflict']);
  f.report.runState='partial';f.report.isComplete=false;f.save();
  assert.deepEqual(f.run('2026-10-31T04:00:00Z',['-CheckRunMissing']).events.map(event=>event.category),['run_missing']);
  assert.equal(f.items().length,5);
  f.notification.arguments=['-e','console.log(JSON.stringify({accepted:true,duplicate:false}))'];
  fs.writeFileSync(f.configFile,JSON.stringify({notification:f.notification}));
  const delivered=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',
    path.join(sourceRoot,'scripts/Invoke-CheckinNotificationOutbox.ps1'),'-OutboxPath',f.outbox,
    '-ConfigPath',f.configFile,'-ForceDue','-MutexName',`Local\\SyntheticDigest${process.pid}`],
    {encoding:'utf8',windowsHide:true,timeout:30_000,stdio:['ignore','pipe','pipe']}).trim());
  assert.equal(delivered.delivered,5);assert.equal(delivered.superseded,0);
  const before=f.items();assert.ok(before.every(item=>item.delivered));
  assert.equal(f.run().enqueued,false);assert.deepEqual(f.items(),before);
});

test('daily verdict reuses retained authoritative completion when the observation sidecar is temporarily missing',async t=>{
  const f=sandbox(t),view=await reconcileNotification({root:f.root,report:f.report,persist:true});
  for(const name of ['dashboard-generation.json','dashboard-generation.previous.json','shadow-beta-snapshot.json'])
    fs.rmSync(path.join(f.controller,'outputs',name),{force:true});
  const retained=await reconcileNotification({root:f.root,report:f.report});assert.equal(retained.overrides.length,1);
  const projected=await notificationVerdict({root:f.root,report:f.report,reconciliation:retained});
  assert.equal(view.overrides.length,1);assert.equal(projected.dayVerdict.counts.done,1);
  assert.equal(projected.verdictScope,'regular_tasks');
});

test('large digest and new-action exception bodies both fit the 950-character limit without account information',t=>{
  const f=digestSandbox(t);f.mark(1,{status:'login_required',retryable:false});
  for(let i=0;i<45;i++){
    const origin=`https://long-action-${i}.example`,taskId='synthetic_long_'+i;
    f.report.bookmarkSummary.targets.push({origin,accountKey:'site-default'});
    f.report.results.push({...f.report.results[1],origin,accountLabel:'synthetic-private-label'});
    f.snapshot.tasks.push({...f.snapshot.tasks[1],origin,taskId});
    f.snapshot.receipts.push({...f.snapshot.receipts[1],taskId});
  }
  f.report.plannedTotal=f.report.processedTotal=f.report.results.length;f.save();
  const output=f.run();assert.equal(output.events.length,2);
  for(const event of output.events){assert.ok(event.summary.length<=950);assert.doesNotMatch(event.summary,/synthetic-private-label|@|https?:\/\//);}
  assert.equal(f.run().events.length,0);
});

const sourceRoot=fileURLToPath(new URL('../',import.meta.url)),observationRoot=fileURLToPath(new URL('../../observation/',import.meta.url));
const today=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
function model(now=new Date()){
  const date=today(now),origins=['https://pt.example','https://still-unknown.example'];
  const targets=origins.map(origin=>({origin,accountKey:'site-default'}));
  const report={runId:date.replaceAll('-','')+'-fixture',finishedAt:now.toISOString(),runState:'final',isComplete:true,
    plannedTotal:2,processedTotal:2,bookmarkSummary:{planFingerprint:'a'.repeat(64),targets},results:targets.map(target=>({...target,
      status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:false,reason:'PRIVATE_READ_REASON'}))};
  const tasks=targets.map(target=>({...taskIdentity({businessDate:date,logicalSiteKey:target.origin,accountKey:target.accountKey}),
    ...target,logicalSiteKey:target.origin,actionType:'checkin',scheduleOccurrence:'daily',businessDate:date,accountRef:accountRef(target.accountKey)}));
  const snapshot={schemaVersion:1,mode:'shadow_read_only',snapshotId:'snap_fixture',businessDate:date,generatedAt:now.toISOString(),
    source:{runId:report.runId},tasks,planHash:planHash(tasks),receipts:tasks.map(task=>({taskId:task.taskId,evidence:{verification:'unverified'}})),
    ptStatus:{businessDate:date,sites:[{origin:origins[0],accountRef:tasks[0].accountRef,discrepancy:false,
      effective:{status:'signed',fresh:true,authoritative:true,source:'harvest',observedAt:now.toISOString(),
        evidence:{source:'harvest',authoritative:true,businessDate:date,confirmedAt:now.toISOString()}}}]}};
  return {report,snapshot,date};
}
function sandbox(t,now=new Date()){
  const base=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'notification-reconciliation-'))),root=path.join(base,'execution'),controller=path.join(base,'observation');
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  for(const dir of [root+'/data',root+'/config',root+'/logs',root+'/src',root+'/scripts',controller+'/config',controller+'/src',controller+'/public',controller+'/outputs'])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  for(const name of ['dashboard-generation.mjs','daily-reconciliation.mjs','workload-view.mjs'])fs.writeFileSync(path.join(controller,'src',name),
    `export * from ${JSON.stringify(pathToFileURL(path.join(observationRoot,'src',name)).href)};\n`);
  fs.writeFileSync(path.join(controller,'public/harvest-window.mjs'),
    `export * from ${JSON.stringify(pathToFileURL(path.join(observationRoot,'public/harvest-window.mjs')).href)};\n`);
  fs.writeFileSync(path.join(controller,'public/day-verdict.mjs'),
    `export * from ${JSON.stringify(pathToFileURL(path.join(observationRoot,'public/day-verdict.mjs')).href)};\n`);
  fs.copyFileSync(path.join(sourceRoot,'src/notification-reconciliation.mjs'),path.join(root,'src/notification-reconciliation.mjs'));
  fs.copyFileSync(path.join(sourceRoot,'src/checkin-contract.generated.mjs'),path.join(root,'src/checkin-contract.generated.mjs'));
  for(const name of ['Submit-UnifiedCheckinReport.ps1','Notification-Digest.ps1','ResultIdentity.ps1','ResultContract.ps1','CheckinContract.generated.ps1','Resolve-Runtime.ps1'])
    fs.copyFileSync(path.join(sourceRoot,'scripts',name),path.join(root,'scripts',name));
  const fixture=model(now),reportFile=path.join(root,'logs/latest.json'),ledgerFile=path.join(controller,'outputs/shadow-ledger.jsonl');
  fs.writeFileSync(reportFile,JSON.stringify(fixture.report));
  const publish=()=>{
    fs.writeFileSync(ledgerFile,JSON.stringify({schemaVersion:1,snapshotId:fixture.snapshot.snapshotId,businessDate:fixture.date,
      planHash:fixture.snapshot.planHash,recordedAt:fixture.snapshot.generatedAt})+'\n');
    commitDashboardGeneration({snapshot:fixture.snapshot,snapshotFile:path.join(controller,'outputs/shadow-beta-snapshot.json'),ledgerFile});
  };publish();
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({nodeExecutable:process.execPath,notification:{mode:'none',policy:'per_change'}}));
  const preview=()=>JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/Submit-UnifiedCheckinReport.ps1'),
    '-ReportPath',reportFile,'-Preview'],{encoding:'utf8',windowsHide:true,timeout:30_000,stdio:['ignore','pipe','pipe']}).trim());
  return {...fixture,root,controller,reportFile,publish,preview,cache:path.join(root,'data/notification-reconciliation',fixture.date+'.json')};
}

test('notification uses the same authoritative PT completion as the dashboard without erasing another unknown',()=>{
  const {report,snapshot}=model(),overrides=notificationOverrides({report,snapshot,confirmed:confirmedPtByTask(snapshot)});
  assert.equal(overrides.length,1);assert.equal(overrides[0].origin,'https://pt.example');assert.equal(overrides[0].status,'already_signed');
  assert.equal(report.results[0].status,'needs_attention');assert.equal(report.results[1].failureCode,'submission_outcome_unknown');
  assert.doesNotMatch(JSON.stringify(overrides),/PRIVATE|userId|username|profilePath/);
});

test('wrong day, plan, account, stale, future, ambiguous and non-authoritative observations cannot upgrade a notification',()=>{
  for(const kind of ['day','plan','account','old_snapshot','future','weak','stale','identity_conflict','ambiguous']){
    const {report,snapshot}=model(),site=snapshot.ptStatus.sites[0];
    if(kind==='day')snapshot.businessDate='2000-01-01';
    if(kind==='plan')snapshot.source.runId+='-foreign';
    if(kind==='account')snapshot.tasks[0].accountKey='other';
    if(kind==='old_snapshot')snapshot.generatedAt=new Date(Date.now()-61*60_000).toISOString();
    if(kind==='future')site.effective.observedAt=new Date(Date.now()+120_000).toISOString();
    if(kind==='weak')site.effective.evidence.authoritative=false;
    if(kind==='stale')site.effective.fresh=false;
    if(kind==='identity_conflict')snapshot.receipts[0].evidence.verification='identity_conflict';
    if(kind==='ambiguous'){site.accountRef=null;snapshot.tasks.push({...snapshot.tasks[0],accountKey:'other'});}
    assert.deepEqual(notificationOverrides({report,snapshot,confirmed:confirmedPtByTask(snapshot)}),[],kind);
  }
});

test('published generation is bound in both directions and preview performs no reconciliation writes',async t=>{
  const f=sandbox(t),before=fs.readFileSync(f.reportFile);
  const view=await reconcileNotification({root:f.root,report:f.report});
  assert.equal(view.ready,true);assert.equal(view.overrides.length,1);assert.equal(fs.existsSync(f.cache),false);
  assert.deepEqual(fs.readFileSync(f.reportFile),before);
  fs.writeFileSync(path.join(f.controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:path.dirname(f.root)}));
  assert.deepEqual((await reconcileNotification({root:f.root,report:f.report})).overrides,[]);
});

test('a temporary observation outage or late raw unknown cannot downgrade a previously persisted same-day completion',async t=>{
  const f=sandbox(t),first=await reconcileNotification({root:f.root,report:f.report,persist:true});
  assert.equal(first.overrides.length,1);assert.equal(fs.existsSync(f.cache),true);
  fs.rmSync(path.join(f.controller,'outputs/dashboard-generation.json'));
  f.report.runId+='-late';
  const later=await reconcileNotification({root:f.root,report:f.report});
  assert.equal(later.ready,true);assert.equal(later.overrides.length,1);
  f.report.bookmarkSummary.planFingerprint='b'.repeat(64);
  assert.deepEqual((await reconcileNotification({root:f.root,report:f.report})).overrides,[]);
});

test('an older raw engine report is deferred after a newer daily result instead of overwriting a terminal notification',async t=>{
  const f=sandbox(t),old={...f.report,runId:f.report.runId+'-old',finishedAt:new Date(Date.now()-5000).toISOString()};
  const view=await reconcileNotification({root:f.root,report:old});
  assert.equal(view.ready,false);assert.equal(view.superseded,true);assert.deepEqual(view.overrides,[]);
});

test('a newer authoritative negative revokes cached completion, while ordinary raw unknown does not',async t=>{
  const f=sandbox(t);await reconcileNotification({root:f.root,report:f.report,persist:true});
  const next=new Date(Date.now()+10),site=f.snapshot.ptStatus.sites[0];
  site.effective.status='not_signed';site.effective.observedAt=next.toISOString();site.effective.evidence.confirmedAt=next.toISOString();
  f.snapshot.generatedAt=next.toISOString();f.publish();
  const view=await reconcileNotification({root:f.root,report:f.report,now:next,persist:true});
  assert.deepEqual(view.overrides,[]);assert.deepEqual(JSON.parse(fs.readFileSync(f.cache)).overrides,[]);
});

test('real reporter preview reflects merged completion, keeps genuine verification and never creates the outbox',t=>{
  const f=sandbox(t),preview=f.preview();
  assert.equal(preview.siteCount,2);assert.equal(preview.problemCount,1);assert.equal(preview.verificationPendingCount,1);
  assert.match(preview.summary,/今日完成 1 项/);assert.doesNotMatch(preview.summary,/pt\.example：/);
  assert.match(preview.summary,/still-unknown\.example/);assert.equal(preview.reconciliationReady,true);
  assert.equal(fs.existsSync(path.join(f.root,'data/notification-outbox')),false);assert.equal(fs.existsSync(f.cache),false);
  const again=f.preview();assert.equal(again.eventKey,preview.eventKey);
  f.snapshot.generatedAt=new Date().toISOString();f.publish();assert.equal(f.preview().eventKey,preview.eventKey);
});

test('external-only success never hides a recoverable local login failure',t=>{
  const f=sandbox(t);fs.rmSync(path.join(f.root,'data/v2-integration.json'));
  f.report.results=[{origin:'https://pt.example',accountKey:'site-default',status:'signed'},
    {origin:'https://still-unknown.example',accountKey:'site-default',status:'error',retryCause:'login_required'},
    {origin:'https://upstream.example',accountKey:'site-default',status:'deferred',retryCause:'upstream_unavailable'}];
  f.report.plannedTotal=3;f.report.processedTotal=3;f.report.bookmarkSummary.targets=f.report.results.map(({origin,accountKey})=>({origin,accountKey}));
  fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const preview=f.preview();assert.notEqual(preview.status,'success');assert.notEqual(preview.status,'already_done');
  assert.match(preview.summary,/登录恢复 1/);assert.equal(preview.businessComplete,false);
});

test('normal scheduled notification refresh happens before outbox delivery without requiring another engine run',()=>{
  const scheduler=fs.readFileSync(path.join(sourceRoot,'scripts/Start-UserScheduler.ps1'),'utf8');
  const loop=scheduler.slice(scheduler.indexOf('while ($true)'));
  assert.ok(loop.indexOf('$latestReportState = Get-LatestReportState')<loop.indexOf('& $reporterScript -RunnerStatus completed -ReportPath'));
  assert.ok(loop.indexOf('& $reporterScript -RunnerStatus completed -ReportPath')<loop.indexOf('$outboxResult = (& $outboxScript'));
  assert.ok(loop.indexOf('$outboxResult = (& $outboxScript')<loop.indexOf('$shouldRun ='));
});

function addMaintenance(f){
  const target=f.snapshot.tasks[1];
  f.report.results[1].submissionAttempted=true;
  f.snapshot.ptStatus.sites.push({origin:target.origin,accountRef:target.accountRef,discrepancy:false,
    effective:{source:'execution-supplement',status:'needs_attention',fresh:true,authoritative:false,
      siteCondition:'site_maintenance',observedAt:f.snapshot.generatedAt,
      evidence:{source:'page_text',authoritative:false,summary:'PRIVATE_MAINTENANCE_TEXT'}}});
  return f.snapshot.ptStatus.sites.at(-1);
}

test('current site maintenance affects notification wording without changing the uncertain submit or inventing completion',()=>{
  const f=model();addMaintenance(f);
  const before=JSON.stringify(f.report),items=notificationAvailability(f);
  assert.equal(items.length,1);assert.equal(items[0].origin,'https://still-unknown.example');
  assert.equal(items[0].condition,'site_maintenance');
  assert.equal(JSON.stringify(f.report),before);
  assert.equal(f.report.results[1].submissionAttempted,true);
  assert.equal(f.report.results[1].failureCode,'submission_outcome_unknown');
  assert.equal(items[0].status,undefined);assert.equal(items[0].evidence,undefined);
  assert.doesNotMatch(JSON.stringify(items),/PRIVATE|username|profile/);
});

test('maintenance projection refuses wrong date, run, plan, account, ambiguous, stale, future and completed state',()=>{
  for(const kind of ['day','run','plan','account','ambiguous','stale','future','date','completed','disabled','conflict']){
    const f=model(),site=addMaintenance(f);
    if(kind==='day')f.snapshot.businessDate='2000-01-01';
    if(kind==='run')f.snapshot.source.runId+='-other';
    if(kind==='plan')f.snapshot.tasks[1].accountKey='other';
    if(kind==='account')site.accountRef='acct_other';
    if(kind==='ambiguous')f.snapshot.ptStatus.sites.push({...site});
    if(kind==='stale')site.effective.fresh=false;
    if(kind==='future')site.effective.observedAt=new Date(Date.now()+120000).toISOString();
    if(kind==='date')site.effective.observedAt='2000-01-01T00:00:00Z';
    if(kind==='completed')site.effective.status='already_signed';
    if(kind==='disabled')f.report.results[1].status='not_available';
    if(kind==='conflict')site.discrepancy=true;
    assert.deepEqual(notificationAvailability(f),[],kind);
  }
});

test('real reporter preview places maintenance in external conditions and preserves the raw unknown report',t=>{
  const f=sandbox(t);addMaintenance(f);f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const before=fs.readFileSync(f.reportFile),preview=f.preview();
  assert.equal(preview.verificationPendingCount,0);assert.equal(preview.externalPendingCount,1);
  assert.equal(preview.status,'already_done');
  assert.match(preview.summary,/等待外部 1/);assert.match(preview.summary,/站点维护，恢复后只读核验/);
  assert.doesNotMatch(preview.summary,/提交结果未确认|待核验|PRIVATE/);
  assert.deepEqual(fs.readFileSync(f.reportFile),before);
  assert.equal(fs.existsSync(path.join(f.root,'data/notification-outbox')),false);
  const key=preview.eventKey;
  f.snapshot.generatedAt=new Date().toISOString();f.publish();assert.equal(f.preview().eventKey,key);
  delete f.snapshot.ptStatus.sites.at(-1).effective.siteCondition;f.publish();
  const unresolved=f.preview();assert.equal(unresolved.verificationPendingCount,1);assert.notEqual(unresolved.eventKey,key);
});

test('a brief observation outage retains bounded maintenance and a fresh recovery clears it immediately',async t=>{
  const now=new Date(today(new Date())+'T01:00:00Z'),f=sandbox(t,now),site=addMaintenance(f);f.publish();
  const first=await reconcileNotification({root:f.root,report:f.report,now,persist:true});
  assert.equal(first.availability.length,1);assert.equal(JSON.parse(fs.readFileSync(f.cache)).availability.length,1);
  fs.rmSync(path.join(f.controller,'outputs/dashboard-generation.json'));
  assert.equal((await reconcileNotification({root:f.root,report:f.report,now:new Date(now.getTime()+30000)})).availability.length,1);
  assert.equal((await reconcileNotification({root:f.root,report:f.report,now:new Date(now.getTime()+61*60000)})).availability.length,0);
  delete site.effective.siteCondition;f.publish();
  assert.equal((await reconcileNotification({root:f.root,report:f.report,now,persist:true})).availability.length,0);
  assert.equal(JSON.parse(fs.readFileSync(f.cache)).availability.length,0);
});

test('one maintenance site cannot hide a genuine local login failure or another unverified submission',t=>{
  const f=sandbox(t);addMaintenance(f);
  f.report.results[0]={...f.report.results[0],status:'error',retryCause:'login_required',failureCode:undefined};
  f.snapshot.ptStatus.sites.shift();f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const preview=f.preview();
  assert.notEqual(preview.status,'success');assert.notEqual(preview.status,'already_done');
  assert.equal(preview.externalPendingCount,1);assert.match(preview.summary,/登录恢复 1/);
});

test('an unbound raw availability field cannot suppress verification or change notification deduplication',t=>{
  const f=sandbox(t);fs.rmSync(path.join(f.root,'data/v2-integration.json'));
  const before=f.preview();
  f.report.results[1].availability={condition:'site_maintenance'};
  fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const after=f.preview();
  assert.equal(after.verificationPendingCount,before.verificationPendingCount);
  assert.equal(after.externalPendingCount,0);assert.equal(after.eventKey,before.eventKey);
});

test('a current server fault changes the notice to external without clearing the unknown submission',t=>{
  const f=sandbox(t),site=addMaintenance(f);
  delete site.effective.siteCondition;site.effective.failureCode='site_server_error';f.publish();
  fs.writeFileSync(f.reportFile,JSON.stringify(f.report));const before=fs.readFileSync(f.reportFile),preview=f.preview();
  assert.equal(preview.externalPendingCount,1);assert.equal(preview.verificationPendingCount,0);
  assert.equal(preview.status,'already_done');assert.match(preview.summary,/站点服务异常/);
  assert.doesNotMatch(preview.summary,/提交结果未确认|PRIVATE/);assert.deepEqual(fs.readFileSync(f.reportFile),before);
});

test('an arbitrary local error is never classified as an external server fault',()=>{
  const f=model(),site=addMaintenance(f);delete site.effective.siteCondition;site.effective.failureCode='browser_launch_failed';
  assert.deepEqual(notificationAvailability(f),[]);
});

function addSupplemental(f,overrides={}){
  const site={origin:'https://fallback.example',displayName:'Fallback',inLegacyPlan:false,fallbackEnabled:true,
    effective:{status:'signed',fresh:true,authoritative:true,observedAt:f.snapshot.generatedAt,
      evidence:{source:'pt_page',authoritative:true,businessDate:f.date,confirmedAt:f.snapshot.generatedAt}},...overrides};
  f.snapshot.ptStatus.sites.push(site);return site;
}

test('the real notification includes authorized PT-only completion and keeps total, classification and deduplication aligned',t=>{
  const f=sandbox(t),fault=addMaintenance(f);delete fault.effective.siteCondition;fault.effective.failureCode='site_server_error';
  const site=addSupplemental(f);f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const before=fs.readFileSync(f.reportFile),preview=f.preview();
  assert.equal(preview.scope,'authorized_workload');assert.equal(preview.siteCount,3);assert.equal(preview.plannedTotal,3);
  assert.equal(preview.processedTotal,3);assert.match(preview.summary,/今日完成 2 项/);assert.equal(preview.externalPendingCount,1);
  assert.equal(preview.verificationPendingCount,0);assert.equal(preview.status,'success');
  assert.deepEqual(fs.readFileSync(f.reportFile),before);assert.equal(fs.existsSync(f.cache),false);
  site.effective.observedAt=new Date().toISOString();f.publish();assert.equal(f.preview().eventKey,preview.eventKey);
});

test('monitor-only and overlapping PT sites are not added again to notification totals',()=>{
  const f=model();addSupplemental(f,{fallbackEnabled:false});
  addSupplemental(f,{origin:f.report.results[0].origin});
  assert.deepEqual(notificationSupplementalResults({...f,projectWorkload:authorizedWorkload}),[]);
});

test('stale, future, conflicting and unverified supplemental success cannot inflate the notification',()=>{
  for(const kind of ['date','future','stale','conflict','weak']){
    const f=model(),site=addSupplemental(f);
    if(kind==='date')site.effective.evidence.businessDate='2000-01-01';
    if(kind==='future')site.effective.observedAt=new Date(Date.now()+120000).toISOString();
    if(kind==='stale')site.effective.fresh=false;
    if(kind==='conflict')site.discrepancy=true;
    if(kind==='weak')site.effective.evidence.authoritative=false;
    const results=notificationSupplementalResults({...f,projectWorkload:authorizedWorkload});
    assert.equal(results.length,1);assert.notEqual(results[0].status,'signed',kind);assert.notEqual(results[0].status,'already_signed',kind);
  }
});

test('a true PT-only pending task stays visible beside completed regular tasks',t=>{
  const f=sandbox(t),site=addSupplemental(f);site.effective.status='not_signed';
  f.publish();const preview=f.preview();
  assert.equal(preview.siteCount,3);assert.notEqual(preview.status,'success');assert.match(preview.summary,/fallback\.example/);
});

test('a corrupt supplemental inventory fails back to an explicit regular scope instead of claiming a complete global report',async t=>{
  const f=sandbox(t);addSupplemental(f,{origin:'https://user:private@fallback.example'});f.publish();
  const view=await reconcileNotification({root:f.root,report:f.report});
  assert.equal(view.scope,'regular_tasks');assert.deepEqual(view.supplementalResults,[]);
  assert.equal(view.ready,false);assert.doesNotMatch(JSON.stringify(view),/private|user:/);
});

function addWaiting(f){
  const now=new Date(),site=addSupplemental(f,{harvestManaged:true});
  site.effective={status:'unknown',fresh:false,authoritative:false,observedAt:null,evidence:{source:'none',authoritative:false}};
  f.snapshot.ptStatus.harvestWindow={source:'harvest',businessDate:f.date,observedAt:now.toISOString(),phase:'scheduled',
    referenceAt:now.toISOString(),deadlineAt:new Date(now.getTime()+30*60000).toISOString()};
  return site;
}

test('waiting is listed separately and never hides a genuine unknown submission',t=>{
  const f=sandbox(t);addWaiting(f);f.publish();const before=fs.readFileSync(f.reportFile),preview=f.preview();
  assert.equal(preview.waitingPendingCount,1);assert.equal(preview.verificationPendingCount,1);
  assert.match(preview.summary,/等待 Harvest 1/);assert.doesNotMatch(preview.summary,/需处理 1|fallback\.example：/);
  assert.equal(preview.problemCount,1);assert.deepEqual(fs.readFileSync(f.reportFile),before);
});

test('only scheduled waiting and external faults defer delivery without creating an outbox or declaring completion',t=>{
  const f=sandbox(t);addMaintenance(f);addWaiting(f);f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const preview=f.preview();assert.equal(preview.waitingPendingCount,1);assert.equal(preview.externalPendingCount,1);
  assert.equal(preview.verificationPendingCount,0);assert.equal(preview.deferred,true);assert.equal(preview.enqueued,false);
  assert.notEqual(preview.status,'success');assert.equal(preview.businessComplete,false);
  const config=JSON.parse(fs.readFileSync(path.join(f.root,'config/config.json')));config.notification.mode='command';
  fs.writeFileSync(path.join(f.root,'config/config.json'),JSON.stringify(config));
  const output=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(f.root,'scripts/Submit-UnifiedCheckinReport.ps1'),
    '-ReportPath',f.reportFile],{encoding:'utf8',windowsHide:true,timeout:30000}).trim());
  assert.equal(output.deferred,true);assert.equal(fs.existsSync(path.join(f.root,'data/notification-outbox')),false);
});

test('expired waiting becomes actionable again instead of suppressing recovery indefinitely',t=>{
  const f=sandbox(t);addMaintenance(f);addWaiting(f);
  const window=f.snapshot.ptStatus.harvestWindow;window.referenceAt=new Date(Date.now()-31*60000).toISOString();
  window.deadlineAt=new Date(Date.now()-60000).toISOString();f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));
  const preview=f.preview();assert.equal(preview.waitingPendingCount,0);assert.equal(preview.status,'needs_attention');
  assert.match(preview.summary,/fallback\.example/);assert.match(preview.summary,/尚无当日权威签到证据/);
});

function expireBeforePublication(f,minutesAgo=1){
  const site=addWaiting(f),window=f.snapshot.ptStatus.harvestWindow;
  const deadline=Date.now()-minutesAgo*60000;
  window.referenceAt=new Date(deadline-30*60000).toISOString();
  window.deadlineAt=new Date(deadline).toISOString();
  window.observedAt=new Date(deadline-25*60000).toISOString();
  return site;
}

test('a notification racing the Harvest publication defers, then uses the new receipt without another signing run',async t=>{
  const f=sandbox(t);addMaintenance(f);const site=expireBeforePublication(f);
  f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));const before=fs.readFileSync(f.reportFile);
  const preview=f.preview();assert.equal(preview.synchronizationPendingCount,1);assert.equal(preview.deferred,true);
  assert.equal(preview.enqueued,false);assert.equal(preview.problemCount,1);assert.equal(preview.businessComplete,false);
  assert.doesNotMatch(preview.summary,/需处理|fallback\.example：/);
  const config=JSON.parse(fs.readFileSync(path.join(f.root,'config/config.json')));config.notification.mode='command';
  fs.writeFileSync(path.join(f.root,'config/config.json'),JSON.stringify(config));
  const run=()=>JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(f.root,'scripts/Submit-UnifiedCheckinReport.ps1'),
    '-ReportPath',f.reportFile],{encoding:'utf8',windowsHide:true,timeout:30000}).trim());
  assert.equal(run().deferred,true);assert.equal(fs.existsSync(path.join(f.root,'data/notification-outbox')),false);
  site.effective={status:'signed',fresh:true,authoritative:true,observedAt:new Date().toISOString(),
    evidence:{source:'harvest',authoritative:true,businessDate:f.date,confirmedAt:new Date().toISOString()}};
  f.snapshot.ptStatus.harvestWindow=null;f.snapshot.generatedAt=new Date().toISOString();f.publish();
  const synchronized=run();assert.equal(synchronized.synchronizationPendingCount,0);assert.equal(synchronized.enqueued,true);
  assert.equal(synchronized.status,'success');assert.match(synchronized.summary,/今日完成 2 项/);
  assert.deepEqual(fs.readFileSync(f.reportFile),before);assert.equal((await reconcileNotification({root:f.root,report:f.report})).syncPending,null);
});

test('a lost publication reports a bounded sync delay, retaining actual login failures and unknown submissions',t=>{
  const f=sandbox(t);expireBeforePublication(f,6);f.snapshot.ptStatus.sites.shift();
  f.report.results[0]={...f.report.results[0],status:'login_required',failureCode:'login_required',submissionAttempted:false};
  f.publish();fs.writeFileSync(f.reportFile,JSON.stringify(f.report));const preview=f.preview();
  assert.equal(preview.synchronizationPendingCount,1);assert.notEqual(preview.deferred,true);
  assert.equal(preview.verificationPendingCount,1);assert.match(preview.summary,/登录恢复 1/);
  assert.match(preview.summary,/等待状态同步 1/);assert.match(preview.summary,/状态更新延迟/);
  assert.doesNotMatch(preview.summary,/fallback\.example：/);assert.equal(preview.problemCount,2);
  assert.equal(preview.businessComplete,false);
});

test('a site migration still reports while unrelated Harvest sites are waiting',t=>{
  const f=sandbox(t);addWaiting(f);f.report.results[1].failureCode='site_migration';f.publish();
  fs.writeFileSync(f.reportFile,JSON.stringify(f.report));const preview=f.preview();
  assert.equal(preview.waitingPendingCount,1);assert.notEqual(preview.deferred,true);
  assert.match(preview.summary,/站点地址已变化/);
});
