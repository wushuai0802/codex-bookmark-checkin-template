import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {planHarvestFallback,runHarvestFallback,pendingHarvestFallbackAttempts,loadHarvestFallbackInputs} from '../src/harvest-fallback.mjs';
import {summarizeHarvest,retainHarvestObservation,latestHarvestObservation} from '../src/harvest-observations.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {verdictSnapshot,harvestOutage} from '../src/daily-reconciliation.mjs';
import {dayVerdict} from '../public/day-verdict.mjs';
import {harvestOverdueAt} from '../public/harvest-overdue.mjs';
import {planHistoryArchive} from '../src/history-archive.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';
import {readDashboardGeneration} from '../src/dashboard-generation.mjs';

const now=new Date('2026-11-11T04:05:00Z'),businessDate='2026-11-11',origin='https://guarded.example';
const report=(at=now)=>({schemaVersion:1,source:'harvest',businessDate,generatedAt:at.toISOString(),checkinInventoryComplete:true,
  taskCompletion:null,sites:[{origin,checkinEnabled:true,status:'unknown',observedAt:null,lastReceiptDay:'2026-11-10'}]});
const policy={reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',dailyHeader:true};
const proof=(status='not_signed',at=now)=>({origin,accountKey:'site-default',businessDate,profileBinding:'b'.repeat(64),
  status,observedAt:at.toISOString(),operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
  evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:at.toISOString(),evidenceScope:'site_account_day',
    statusSignal:status==='not_signed'?'nexus_daily_header_unsigned':'nexus_daily_header_signed'}});
function fixture(t){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'harvest-outage-'))),legacyRoot=path.join(root,'execution');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','outputs','execution/config','execution/data','execution/logs'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot,ptFallbackOnlyEnabled:true}));
  fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
  const catalog={sites:[{origin,entryUrl:origin+'/index.php'}]},harvest=report();
  return {root,now,clock:()=>now,harvest,harvestObservation:summarizeHarvest(harvest,{now}),catalog,plan:{targets:[]},
    latest:{runId:'20261111-fixture',runState:'final',isComplete:true,results:[]},fallbackOnlyEnabled:true,
    readOnlyOrigins:[origin],config:{ptReadOnlyPolicies:{[origin]:policy}},catalogFile:path.join(root,'catalog.json'),catalogHash:'a'.repeat(64)};
}
function projection(f,{harvest=f.harvest,fallbackReport=null,takeoverReport=null}={}){
  const ptStatus=buildPtStatus({businessDate,generatedAt:now.toISOString(),externalReport:harvest,harvestAvailable:Boolean(harvest),
    harvestObservation:f.harvestObservation,overdueAt:'12:00',monitorCatalog:f.catalog,readPolicies:f.config.ptReadOnlyPolicies,
    fallbackOnlyEnabled:true,fallbackReport,takeoverReport});
  return {businessDate,generatedAt:now.toISOString(),tasks:[],ptStatus};
}

test('bounded public cutoff defaults to noon and private settings reject invalid or late times',t=>{
  const f=fixture(t);assert.equal(loadRuntimeConfig(f.root).harvestOverdueAt,'12:00');
  for(const value of ['24:00','18:01','19:00','12:60',12,null])assert.throws(()=>harvestOverdueAt(value));
  assert.equal(harvestOverdueAt('18:00'),'18:00');
  fs.writeFileSync(path.join(f.root,'config/runtime.local.json'),JSON.stringify({harvestOverdueAt:'13:00'}));
  assert.equal(loadRuntimeConfig(f.root).harvestOverdueAt,'13:00');
});

for(const mode of ['missing','invalid','stale','live'])for(const result of ['not_signed','already_signed','unknown','old-proof','wrong-account','no-binding']){
  test(`real fallback entry ${mode} Harvest, ${result}: passive first, at most one daily takeover`,async t=>{
    const f=fixture(t),calls=[];
    if(mode==='missing')f.harvest=null;
    if(mode==='invalid')f.harvest={source:'invalid'};
    if(mode==='stale')f.harvest={...f.harvest,generatedAt:'2026-11-11T01:00:00Z'};
    f.harvestUnavailable=mode!=='live';
    const args={...f,execute:true,refreshHarvest:async()=>{if(mode!=='live')throw Error('synthetic transport unavailable');return f.harvest;},
      runSite:async request=>{
        assert.ok(fs.existsSync(path.join(f.root,'data/harvest-fallback.lock')),'dispatcher owns its lock');
        calls.push(request.readOnly?'read':'submit');
        if(request.readOnly){
          const value=proof(result==='already_signed'?'already_signed':result==='unknown'?'unknown':'not_signed');
          if(result==='unknown')value.evidence.authoritative=false;
          if(result==='old-proof')value.evidence.confirmedAt='2026-11-11T03:55:00Z';
          if(result==='wrong-account')value.accountKey='other';
          if(result==='no-binding')delete value.profileBinding;
          return value;
        }
        assert.equal(request.verifyBeforeSubmit,true);assert.match(request.fallbackAttemptId,/^[a-f0-9-]{36}$/);
        assert.equal(request.overdueTakeover,true);
        return {...proof('signed'),submissionAttempted:true};
      }};
    const preview=planHarvestFallback(args);assert.equal(preview.eligible.length,1);
    assert.equal(preview.eligible[0].overdueReason,mode==='live'?'harvest_overdue_incomplete':'harvest_overdue_unavailable');
    await runHarvestFallback(args);await runHarvestFallback(args);
    assert.deepEqual(calls,result==='not_signed'?['read','submit']:['read']);
    assert.equal(pendingHarvestFallbackAttempts(f.root,preview,{now,readOnlyOrigins:[origin]}).length,0);
    if(['not_signed','already_signed'].includes(result)){
      const fallbackReport=JSON.parse(fs.readFileSync(path.join(f.root,`outputs/pt-fallback-results-${businessDate}.json`)));
      const snapshot=projection(f,{harvest:mode==='live'?f.harvest:null,fallbackReport});
      assert.equal(dayVerdict(verdictSnapshot(snapshot,{now}),{now}).counts.done,1);
    }
  });
}

test('before cutoff, invalid observation still fails closed; unchanged pre-cutoff live eligibility and running wait remain',t=>{
  const f=fixture(t),early=new Date('2026-11-11T03:59:59Z');
  assert.throws(()=>planHarvestFallback({...f,now:early,harvest:null}),/stale or invalid/);
  const live=planHarvestFallback({...f,now:early,harvest:report(early)});assert.equal(live.eligible.length,1);assert.equal(live.eligible[0].overdueReason,undefined);
  f.harvest.taskCompletion={status:'running',resultId:1,activeTaskCount:1,startedAt:'2026-11-11T04:00:00Z'};
  assert.equal(planHarvestFallback(f).eligible.length,0);
  assert.equal(planHarvestFallback(f).blocked[0].reason,'harvest_waiting');
  f.harvestObservation=summarizeHarvest(f.harvest,{now});f.harvest=null;f.harvestUnavailable=true;
  assert.equal(planHarvestFallback(f).eligible.length,0,'a failed probe cannot erase a still-valid recorded running window');
  assert.equal(planHarvestFallback({...f,now:new Date('2026-11-11T04:31:00Z')}).eligible.length,1,'the recorded window cannot extend itself');
});

test('no reader and read-only capabilities never dispatch and become actionable with fixed outage codes',t=>{
  for(const unavailable of [false,true])for(const readOnly of [false,true]){
    const f=fixture(t);f.config.ptReadOnlyPolicies=readOnly?{[origin]:{...policy,dailyHeader:false}}:{};f.readOnlyOrigins=[];
    if(unavailable){f.harvest=null;f.harvestUnavailable=true;}
    assert.equal(planHarvestFallback(f).eligible.length,0);
    const snapshot=projection(f),verdict=dayVerdict(verdictSnapshot(snapshot,{now}),{now});
    assert.equal(verdict.counts.actionNeeded,1);
    assert.equal(verdict.items[0].reasonCode,unavailable?'harvest_overdue_unavailable':'harvest_overdue_incomplete');
    assert.equal(harvestOutage(snapshot,{now}).needsHuman,1);
  }
});

test('a missing private opt-in is not represented as an executable takeover',t=>{
  const f=fixture(t);assert.equal(planHarvestFallback({...f,fallbackOnlyEnabled:false}).eligible.length,0);
  const snapshot=projection(f);snapshot.ptStatus.sites[0].fallbackEnabled=false;
  const verdict=dayVerdict(verdictSnapshot(snapshot,{now}),{now});
  assert.equal(verdict.counts.actionNeeded,1);assert.equal(harvestOutage(snapshot,{now}).needsHuman,1);
});

test('unknown submission is not replayed even after a later Harvest failure or a new unsigned wakeup',async t=>{
  const f=fixture(t),calls=[];
  const args={...f,execute:true,runSite:async request=>{calls.push(request.readOnly?'read':'write');
    if(request.readOnly)return proof();throw Error('synthetic uncertain write');}};
  await runHarvestFallback(args);
  f.harvest.sites[0]={...f.harvest.sites[0],status:'failed',observedAt:now.toISOString()};
  await runHarvestFallback({...args,harvest:f.harvest});
  assert.deepEqual(calls,['read','write']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,`outputs/harvest-fallback-attempts-${businessDate}.json`))).attempts[0].state,'outcome_unknown');
});

test('unavailable probes cannot expand takeover to execution-owned or unassigned origins and an invalid live refresh still permits only a passive read',async t=>{
  const f=fixture(t);f.harvest=null;f.harvestUnavailable=true;
  const absent='https://unassigned.example',owned='https://execution-owned.example';
  f.catalog.sites.push({origin:absent,entryUrl:absent+'/index.php'},{origin:owned,entryUrl:owned+'/index.php'});
  f.harvestObservation.sites.push({...f.harvestObservation.sites[0],origin:owned,checkinEnabled:false});
  assert.deepEqual(planHarvestFallback(f).eligible.map(site=>site.origin),[origin]);
  let reads=0;
  await runHarvestFallback({...f,execute:true,refreshHarvest:async()=>({source:'invalid'}),runSite:async request=>{
    assert.equal(request.readOnly,true);reads++;return proof('already_signed');}});
  assert.equal(reads,1);
});

test('an unbound or wrong-account old supplement never suppresses an overdue passive takeover',t=>{
  const f=fixture(t);
  for(const change of [{accountKey:'other'},{profileBinding:null},{evidence:{...proof('signed').evidence,businessDate:'2026-11-10'}}]){
    f.fallbackReport={source:'execution-supplement',businessDate,sites:[{...proof('signed'),...change}]};
    assert.equal(planHarvestFallback(f).eligible.length,1);
  }
});

test('later Harvest positive preserves bound unsigned -> executor completion history without a false identity conflict',t=>{
  const f=fixture(t),accountRef='acct_0123456789abcdef',before=proof('not_signed',new Date('2026-11-11T04:01:00Z'));
  before.evidence.readSafety='reviewed_passive';
  const completion={...proof('signed',new Date('2026-11-11T04:02:00Z')),submissionAttempted:true};
  const positive=report();positive.sites[0]={...positive.sites[0],status:'already_signed',observedAt:'2026-11-11T04:04:00Z',
    evidence:{source:'harvest',authoritative:true}};
  const ptStatus=buildPtStatus({businessDate,generatedAt:now.toISOString(),tasks:[{taskId:'one',origin,accountRef,
    observedStatus:'not_signed',profileBinding:before.profileBinding,submissionAttempted:false}],
    receipts:[{taskId:'one',observedAt:before.observedAt,evidence:before.evidence}],planTargets:[{origin,folderNames:['PT']}],
    monitorCatalog:f.catalog,externalReport:positive,fallbackReport:{schemaVersion:1,source:'execution-supplement',businessDate,sites:[completion]}});
  assert.equal(ptStatus.sites[0].discrepancy,false);assert.ok(['signed','already_signed'].includes(ptStatus.sites[0].effective.status));
  assert.equal(planHarvestFallback({...f,harvest:positive}).eligible.length,0);
});

test('summary retains only latest valid observation per Shanghai day, excludes private fields and follows daily archive rules',t=>{
  const f=fixture(t),input=report();Object.assign(input.sites[0],{userId:'synthetic-private-id',username:'synthetic-name',cookie:'x'.repeat(8)});
  const first=retainHarvestObservation(f.root,input,{now});
  const later=report(new Date('2026-11-11T04:06:00Z'));later.sites[0].lastReceiptDay=businessDate;
  const last=retainHarvestObservation(f.root,later,{now:new Date('2026-11-11T04:06:01Z')});
  assert.equal(last.sites[0].hasTodayReceipt,true);assert.equal(last.sites[0].checkinEnabled,true);
  assert.equal(last.sites[0].taskCompletion.status,null);assert.equal(last.sites[0].observedAt,'2026-11-11T04:06:00.000Z');
  assert.deepEqual(retainHarvestObservation(f.root,input,{now}),last);
  assert.throws(()=>retainHarvestObservation(f.root,{...input,source:'bad'},{now}));
  assert.deepEqual(latestHarvestObservation(f.root,{now:new Date('2026-11-11T04:07:00Z')}),last);
  const next=report(new Date('2026-11-11T16:00:00Z'));next.businessDate='2026-11-12';
  retainHarvestObservation(f.root,next,{now:new Date('2026-11-11T16:00:00Z')});
  assert.equal(latestHarvestObservation(f.root,{now:new Date('2026-11-11T16:00:00Z')}).businessDate,'2026-11-12');
  assert.equal(fs.readdirSync(path.join(f.root,'outputs')).length,2);
  assert.doesNotMatch(JSON.stringify([first,last]),/userId|username|cookie|synthetic-private|synthetic-secret|synthetic-name/);
  assert.deepEqual(Object.keys(first.sites[0]).sort(),['checkinEnabled','hasTodayReceipt','lastReceiptDay','observedAt','origin','taskCompletion']);
  const archive=planHistoryArchive(path.join(f.root,'outputs'),'2026-12',{now:new Date('2026-12-02T04:00:00Z')});assert.equal(archive.files.length,2);
});

test('prepared context CLI and fallback input loader distinguish a failed probe from its old display receipt',t=>{
  const f=fixture(t),scripts=path.join(f.root,'scripts'),src=path.join(f.root,'src'),pub=path.join(f.root,'public');
  for(const dir of [scripts,src,pub])fs.mkdirSync(dir,{recursive:true});
  const project=fileURLToPath(new URL('../',import.meta.url));
  for(const [dir,names] of [['scripts',['prepare-harvest-context.mjs']],['src',['harvest-observations.mjs','pt-coordination.generated.mjs','checkin-contract.generated.mjs']],
    ['public',['harvest-overdue.mjs','harvest-window.mjs','checkin-contract.generated.mjs']]])for(const name of names)
    fs.copyFileSync(path.join(project,dir,name),path.join(f.root,dir,name));
  const out=path.join(f.root,'context.json');
  execFileSync(process.execPath,[path.join(scripts,'prepare-harvest-context.mjs'),'--out',out],{windowsHide:true});
  for(const [name,value] of [['data/last-valid-bookmark-plan.json',f.plan],['config/config.json',f.config],['logs/latest.json',f.latest]])
    fs.writeFileSync(path.join(f.root,'execution',name),JSON.stringify(value));
  fs.writeFileSync(f.catalogFile,JSON.stringify(f.catalog));
  const input=loadHarvestFallbackInputs({root:f.root,reportFile:out,catalogFile:f.catalogFile});
  assert.equal(input.harvest,null);assert.equal(input.harvestUnavailable,true);assert.equal(input.overdueAt,'12:00');
});

for(const mode of ['before','after','no-upload','skip-fallback'])test(`full PowerShell sync entry ${mode}: unavailable Harvest, isolated transports, local generation and notification handoff`,t=>{
  const f=fixture(t),project=fileURLToPath(new URL('../',import.meta.url)),ops=path.join(f.root,'operations');
  const at=mode==='before'?'2026-11-11T03:59:00Z':now.toISOString();
  const regular={origin:'https://regular.example',accountKey:'site-default',folderNames:['example-folder']};
  f.plan.targets=[regular];f.latest.results=[{...regular,status:'signed',observedAt:at,evidence:{source:'api',authoritative:true,businessDate,confirmedAt:at}}];
  for(const dir of ['scripts','src','public','execution/scripts','execution/src','operations/config','operations/outputs'])fs.mkdirSync(path.join(f.root,dir),{recursive:true});
  const frozen=path.join(f.root,'clock.mjs');
  fs.writeFileSync(frozen,`const OriginalDate=Date;const fixed=OriginalDate.parse(${JSON.stringify(at)});globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};`);
  for(const file of ['Sync-NasShadow.ps1','prepare-harvest-context.mjs','harvest-fallback.mjs'])fs.copyFileSync(path.join(project,'scripts',file),path.join(f.root,'scripts',file));
  // Isolate only the fixture's OS mutex from another test process. The product
  // entry, publication lease and all dispatch logic still execute unchanged.
  const syncFile=path.join(f.root,'scripts/Sync-NasShadow.ps1');
  fs.writeFileSync(syncFile,fs.readFileSync(syncFile,'utf8').replace('Local\\CodexCheckinFabricV2ShadowSync',`Local\\SyntheticHarvestOutage${process.pid}-${mode}`));
  fs.copyFileSync(path.join(project,'src/shadow-run.mjs'),path.join(f.root,'src/shadow-run.mjs'));
  for(const name of ['harvest-fallback','harvest-observations','runtime-config','bridge','shadow-ledger','dashboard-generation','pt-reconciliation'])
    fs.writeFileSync(path.join(f.root,'src',name+'.mjs'),`export * from ${JSON.stringify(pathToFileURL(path.join(project,'src',name+'.mjs')).href)};`);
  fs.writeFileSync(path.join(f.root,'src/shadow-acceptance.mjs'),"console.log(JSON.stringify({accepted:false,eligibleRecentDays:0,requiredConsecutiveDays:3}));process.exitCode=2;");
  fs.writeFileSync(path.join(f.root,'execution/src/pt-read-policy.mjs'),`export function ptReadPolicy(origin,config){return config.ptReadOnlyPolicies?.[origin]??{};}`);
  fs.writeFileSync(path.join(f.root,'scripts/collect-desired-plan.mjs'),`import fs from 'node:fs';fs.writeFileSync(process.argv[3],${JSON.stringify(JSON.stringify(f.plan))});`);
  fs.writeFileSync(path.join(f.root,'scripts/collect-monitor-catalog.mjs'),`import fs from 'node:fs';fs.writeFileSync(process.argv[4],${JSON.stringify(JSON.stringify(f.catalog))});`);
  fs.writeFileSync(path.join(f.root,'execution/scripts/Test-CheckinHealth.ps1'),`Write-Output '{"healthy":true,"checkedAt":"${at}"}'`);
  fs.writeFileSync(path.join(ops,'config/pt-monitor.local.json'),JSON.stringify({harvestDatabase:'/volume3/docker/example/fixture.db'}));
  for(const [name,value] of [['data/last-valid-bookmark-plan.json',f.plan],['data/scheduler-state.json',{}],['config/config.json',f.config],
    ['logs/latest.json',{...f.latest,finishedAt:at,bookmarkSummary:{targets:[]}}]])fs.writeFileSync(path.join(f.root,'execution',name),JSON.stringify(value));
  retainHarvestObservation(f.root,report(new Date(at)),{now:new Date(at)});
  const quote=value=>"'"+value.replaceAll("'","''")+"'",calls=path.join(f.root,'calls.jsonl');
  fs.writeFileSync(path.join(f.root,'scripts/Sync-OperationsSupport.ps1'),`
function Invoke-BoundedSyncProcess([string]$Executable,[string[]]$Arguments,[string]$Phase,[string]$InputFile='',[int]$TimeoutSeconds=30,[switch]$CooperativeStop,[int]$CleanupGraceSeconds=0){
  [IO.File]::AppendAllText(${quote(calls)},($Phase+[Environment]::NewLine))
  if($Phase -eq 'harvest_read'){return [pscustomobject]@{exitCode=255;output=@();failure='synthetic_unavailable'}}
  if($Phase -eq 'harvest_fallback'){return [pscustomobject]@{exitCode=0;output=@()}}
  if($Phase -eq 'dashboard_status_sync'){return [pscustomobject]@{exitCode=255;failure='synthetic_upload_failed'}}
  throw 'unexpected synthetic transport phase'
}
function Receive-SyncPhaseTiming {}
function Write-SyncPhaseTiming {}
function Update-SynchronizedCheckinNotification([string]$LegacyRoot){
  if(-not (Test-Path -LiteralPath ${quote(path.join(f.root,'outputs/dashboard-generation.json'))})){throw 'local generation not committed'}
  [IO.File]::AppendAllText(${quote(calls)},('notification_refresh'+[Environment]::NewLine))
}
`);
  fs.writeFileSync(path.join(f.root,'scripts/Sync-ShadowPublication.ps1'),"function Invoke-ShadowPublication { throw 'unexpected synthetic upload' }");
  const args=['-NoProfile','-NonInteractive','-File',path.join(f.root,'scripts/Sync-NasShadow.ps1'),'-ProjectRoot',f.root,
    '-LegacyRoot',path.join(f.root,'execution'),'-OpsRoot',ops,'-SshTarget','fixture','-NodePath',process.execPath];
  if(mode==='no-upload')args.push('-NoUpload');if(mode==='skip-fallback')args.push('-SkipHarvestFallback');
  const run=spawnSync('pwsh.exe',args,{encoding:'utf8',windowsHide:true,timeout:30_000,
    env:{...process.env,NODE_OPTIONS:'--import '+pathToFileURL(frozen).href}});
  assert.equal(run.status,mode==='no-upload'?0:1,run.stderr||run.stdout);
  assert.match(run.stdout,/Harvest unavailable/);
  const phases=fs.readFileSync(calls,'utf8').trim().split(/\r?\n/);
  assert.equal(phases.filter(value=>value==='harvest_fallback').length,mode==='after'?1:0,run.stdout);
  assert.equal(phases.filter(value=>value==='notification_refresh').length,mode==='no-upload'?0:1,run.stdout);
  const generation=readDashboardGeneration(path.join(f.root,'outputs'));assert.ok(generation&&!generation.stale,run.stdout);
  assert.equal(generation.current.snapshot.ptStatus.harvestAvailability.available,false);
  assert.equal(generation.current.snapshot.ptStatus.sites[0].harvestManaged,true);
  assert.equal(fs.existsSync(path.join(f.root,'data/shadow-publication.lock')),false);
});
