import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {notificationOverrides,notificationAvailability,reconcileNotification} from '../src/notification-reconciliation.mjs';
import {confirmedPtByTask} from '../../observation/src/daily-reconciliation.mjs';
import {commitDashboardGeneration} from '../../observation/src/dashboard-generation.mjs';
import {accountRef,planHash,taskIdentity} from '../../observation/src/contracts.mjs';

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
  for(const dir of [root+'/data',root+'/config',root+'/logs',root+'/src',root+'/scripts',controller+'/config',controller+'/src',controller+'/outputs'])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  for(const name of ['dashboard-generation.mjs','daily-reconciliation.mjs'])fs.writeFileSync(path.join(controller,'src',name),
    `export * from ${JSON.stringify(pathToFileURL(path.join(observationRoot,'src',name)).href)};\n`);
  fs.copyFileSync(path.join(sourceRoot,'src/notification-reconciliation.mjs'),path.join(root,'src/notification-reconciliation.mjs'));
  for(const name of ['Submit-UnifiedCheckinReport.ps1','ResultIdentity.ps1','ResultContract.ps1','CheckinContract.generated.ps1','Resolve-Runtime.ps1'])
    fs.copyFileSync(path.join(sourceRoot,'scripts',name),path.join(root,'scripts',name));
  const fixture=model(now),reportFile=path.join(root,'logs/latest.json'),ledgerFile=path.join(controller,'outputs/shadow-ledger.jsonl');
  fs.writeFileSync(reportFile,JSON.stringify(fixture.report));
  const publish=()=>{
    fs.writeFileSync(ledgerFile,JSON.stringify({schemaVersion:1,snapshotId:fixture.snapshot.snapshotId,businessDate:fixture.date,
      planHash:fixture.snapshot.planHash,recordedAt:fixture.snapshot.generatedAt})+'\n');
    commitDashboardGeneration({snapshot:fixture.snapshot,snapshotFile:path.join(controller,'outputs/shadow-beta-snapshot.json'),ledgerFile});
  };publish();
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({nodeExecutable:process.execPath,notification:{mode:'none'}}));
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
