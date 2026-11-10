import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseBaselineOptions,runSuccessBaseline,runBaselineCli,formatBaseline} from '../../tools/success-baseline.mjs';
import {managed} from '../../tools/release-lib.mjs';

const project=fileURLToPath(new URL('../../',import.meta.url)),now=new Date('2026-11-11T04:00:00Z');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const save=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
function fixture(t){
  fs.mkdirSync(path.join(project,'tmp'),{recursive:true});
  const root=fs.mkdtempSync(path.join(project,'tmp/success-baseline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const executionRoot=path.join(root,'execution'),observationRoot=path.join(root,'observation');
  fs.mkdirSync(executionRoot);fs.mkdirSync(observationRoot);
  const config=path.join(root,'config/release.local.json');
  save(config,{executionRoot:'../execution',observationRoot:'../observation',opsRoot:'../operations',backupRoot:'../backups',
    taskNames:{main:'synthetic-main',sync:'synthetic-sync'}});
  return {root,executionRoot,observationRoot,config,options:{executionRoot,observationRoot,days:7,until:'2026-11-10'}};
}
function daily(f,date,counts={done:3,verifying:1,actionNeeded:1,external:2,paused:4,noFeature:1},extra={}){
  const total=counts.done+counts.verifying+counts.actionNeeded;
  const item={schemaVersion:1,taskId:'bookmark_daily',name:'合成任务',source:'synthetic',
    createdAt:date+'T03:05:00Z',status:counts.actionNeeded?'needs_attention':counts.verifying?'unconfirmed':'success',
    summary:`签到日报 ${date.slice(5)}\n有效 ${total}：已完成 ${counts.done}，核验中 ${counts.verifying}，需处理 ${counts.actionNeeded}\n外部阻断 ${counts.external} · 已暂停 ${counts.paused} · 无此功能 ${counts.noFeature}`,
    delivered:true,attempts:9,notificationSites:['synthetic-hash'],...extra};
  item.eventKey=`external:${item.source}:${item.taskId}:${date}`;
  item.payloadHash=hash([item.eventKey,item.taskId,item.name,item.source,item.status,item.summary].join('\n'));
  const file=path.join(f.executionRoot,'data/notification-outbox',hash(item.eventKey)+'.json');save(file,item);
  return {item,file};
}
function snapshot(f,date,tasks,extra={}){
  const value={schemaVersion:1,mode:'shadow_read_only',businessDate:date,generatedAt:date+'T04:00:00Z',
    tasks:tasks.map((task,index)=>({taskId:'task_'+index,origin:`https://site-${index}.example`,businessDate:date,
      observedStatus:'needs_attention',observedAt:date+'T03:00:00Z',...task})),receipts:[],...extra};
  save(path.join(f.observationRoot,'outputs/shadow-beta-snapshot.json'),value);return value;
}
function report(f,date,results,extra={}){
  const runId=date.replaceAll('-','')+'-080500-001-abcdef';
  const value={runId,runState:'final',executionComplete:true,isComplete:true,finishedAt:date+'T03:00:00Z',
    bookmarkSummary:{targets:results.map(item=>({origin:item.origin,accountKey:item.accountKey??'site-default'}))},results,...extra};
  save(path.join(f.executionRoot,'logs',runId,'result.json'),value);return value;
}
const positive=date=>({status:'signed',observedAt:date+'T01:00:00Z',evidence:{source:'pt_page',authoritative:true,businessDate:date,confirmedAt:date+'T01:00:00Z'}});

test('complete seven-day baseline uses immutable digest counts and sums site-days',t=>{
  const f=fixture(t);
  for(let day=4;day<=10;day++)daily(f,'2026-11-'+String(day).padStart(2,'0'));
  const result=runSuccessBaseline(f.options,{now});
  assert.equal(result.from,'2026-11-04');assert.equal(result.days.length,7);
  for(const row of result.days){
    assert.equal(row.complete,true);assert.equal(row.total,5);assert.equal(row.completionRate,0.6);
    assert.deepEqual(row.counts,{done:3,verifying:1,actionNeeded:1,external:2,paused:4,noFeature:1});
    assert.equal(row.manualInterventions,1);assert.equal(row.source,'daily_digest');assert.deepEqual(row.missing,[]);
  }
  assert.equal(result.totals.total,35);assert.equal(result.totals.counts.done,21);
  assert.equal(result.totals.manualInterventions,7);assert.equal(result.totals.completionRate,0.6);
  assert.equal(result.totals.completeDays,7);assert.equal(result.manualInterventionBasis,'action_needed_rows');
  assert.equal(runBaselineCli(['--config',f.config,'--json'],{now,stdout:()=>{}}),0);
});

test('a missing day stays unknown and is excluded from aggregate coverage',t=>{
  const f=fixture(t);
  for(let day=4;day<=10;day++)if(day!==7)daily(f,'2026-11-'+String(day).padStart(2,'0'));
  // Today's snapshot must never fill the historical hole.
  snapshot(f,'2026-11-11',[{...positive('2026-11-11'),observedStatus:'signed'}]);
  const result=runSuccessBaseline(f.options,{now}),row=result.days[3];
  assert.equal(row.businessDate,'2026-11-07');assert.equal(row.complete,false);assert.equal(row.total,null);
  assert.equal(row.completionRate,null);assert.equal(row.manualInterventions,null);
  assert.ok(row.missing.includes('daily_digest_missing'));assert.ok(row.missing.includes('authorized_snapshot_missing'));
  assert.equal(result.totals.completeDays,6);assert.equal(result.totals.total,30);assert.equal(result.totals.completionRate,0.6);
  assert.equal(runBaselineCli(['--config',f.config],{now,stdout:()=>{}}),1);
});

test('report-only day is partial; old unknown carried in a new report is verifying',t=>{
  const f=fixture(t),date='2026-11-10';
  report(f,date,[{origin:'https://old.example',status:'needs_attention',observedAt:'2026-10-06T01:00:00Z',
    failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false},
  {origin:'https://done.example',...positive(date)},
  {origin:'https://paused.example',status:'not_available',disabledByConfig:true,availabilityKind:'task_disabled'},
  {origin:'https://manual.example',status:'login_required',observedAt:date+'T01:00:00Z',retryable:false}]);
  const row=runSuccessBaseline({...f.options,days:1,sites:true},{now}).days[0];
  assert.equal(row.complete,false);assert.equal(row.source,'execution_report_partial');
  assert.deepEqual(row.counts,{done:1,verifying:1,actionNeeded:1,external:0,paused:1,noFeature:0});
  assert.equal(row.total,3);assert.equal(row.manualInterventions,1);assert.ok(row.missing.includes('pt_verdict_inputs_missing'));
  assert.deepEqual(row.sites,[{domain:'manual.example',status:'actionNeeded'},{domain:'old.example',status:'verifying'}]);
  assert.equal(row.sitesComplete,false);
  const total=runSuccessBaseline({...f.options,days:1},{now}).totals;
  assert.equal(total.total,null);assert.equal(total.completionRate,null);
});

test('same-day snapshot reuses workload/PT verdict rules and excludes paused sites',t=>{
  const f=fixture(t),date='2026-11-10',at=date+'T03:00:00Z';
  snapshot(f,date,[{observedStatus:'signed',evidence:{source:'pt_page',authoritative:true}},
    {disabledByConfig:true,availabilityKind:'task_disabled'},
    {observedStatus:'not_available',availabilityKind:'feature_disabled'},
    {failureCode:'submission_outcome_unknown',observedAt:'2026-10-06T01:00:00Z',submissionAttempted:true,retryable:false}],
  {ptStatus:{businessDate:date,sites:[{origin:'https://supplement.example',fallbackEnabled:true,effective:{status:'signed',
    authoritative:true,fresh:true,observedAt:at,evidence:{source:'pt_page',authoritative:true,businessDate:date,confirmedAt:at}}},
  {origin:'https://monitor.example',fallbackEnabled:false,effective:{status:'signed',authoritative:true,fresh:true,observedAt:at}}]}});
  const row=runSuccessBaseline({...f.options,days:1,sites:true},{now}).days[0];
  assert.equal(row.complete,true);assert.equal(row.total,3);assert.equal(row.counts.done,2);
  assert.equal(row.counts.verifying,1);assert.equal(row.counts.actionNeeded,0);assert.equal(row.counts.paused,1);assert.equal(row.counts.noFeature,1);
  assert.deepEqual(row.sites,[{domain:'site-3.example',status:'verifying'}]);
});

test('Shanghai midnight follows observation timestamps, never report completion or host timezone',t=>{
  const f=fixture(t),date='2026-11-10';
  snapshot(f,date,[
    {observedStatus:'signed',observedAt:'2026-11-09T15:59:59Z',evidence:{source:'pt_page',authoritative:true}},
    {observedStatus:'signed',observedAt:'2026-11-09T16:00:00Z',evidence:{source:'pt_page',authoritative:true}},
    {observedStatus:'needs_attention',observedAt:'2026-11-09T15:59:59Z',retryable:false},
    {observedStatus:'signed',observedAt:'2026-11-10T16:00:00Z',evidence:{source:'pt_page',authoritative:true}}]);
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.counts.done,1);assert.equal(row.counts.verifying,3);assert.equal(row.counts.actionNeeded,0);
  assert.equal(parseBaselineOptions(['--config',f.config],{now:new Date('2026-11-10T15:59:59Z')}).until,'2026-11-09');
  assert.equal(parseBaselineOptions(['--config',f.config],{now:new Date('2026-11-10T16:00:00Z')}).until,'2026-11-10');
});

test('lossy ledger alone cannot reconstruct retry, availability or PT verdict fields',t=>{
  const f=fixture(t),date='2026-11-10',file=path.join(f.observationRoot,'outputs/shadow-ledger.jsonl');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,businessDate:date,counts:{status:{signed:90}},
    taskSummaries:[{origin:'https://old.example',observedStatus:'signed',observedAt:'2026-10-06T01:00:00Z'}]})+'\n');
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.source,'shadow_ledger_partial');assert.equal(row.total,null);assert.equal(row.counts.done,null);
  assert.ok(row.missing.includes('ledger_verdict_fields_missing'));
});

test('regular_tasks digest retains counts but is incomplete without authorized PT inventory',t=>{
  const f=fixture(t),date='2026-11-10',base=daily(f,date).item;
  daily(f,date,undefined,{summary:base.summary+'\n仅主任务口径，观测范围待同步'});
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.total,5);assert.equal(row.complete,false);assert.ok(row.missing.includes('pt_verdict_inputs_missing'));
});

test('digest hash, dates and integer arithmetic are validated; ambiguity never produces complete data',t=>{
  const f=fixture(t),date='2026-11-10',original=daily(f,date);
  save(original.file,{...original.item,summary:original.item.summary.replace('已完成 3','已完成 4')});
  let row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.total,null);assert.ok(row.missing.includes('daily_digest_invalid'));
  daily(f,date,undefined,{createdAt:'2026-11-09T15:59:59Z'});
  row=runSuccessBaseline({...f.options,days:1},{now}).days[0];assert.equal(row.complete,false);
  daily(f,date);daily(f,date,undefined,{source:'another-synthetic-source'});
  row=runSuccessBaseline({...f.options,days:1},{now}).days[0];assert.equal(row.complete,false);assert.ok(row.missing.includes('daily_evidence_conflict'));
});

test('output allowlist hides identities and paths; sites opt-in emits domains and fixed states only',t=>{
  const f=fixture(t),date='2026-11-10',marker='synthetic-private-identity';
  report(f,date,[{origin:'https://manual.example',accountKey:marker,accountLabel:marker,username:marker,
    status:'login_required',observedAt:date+'T01:00:00Z',retryable:false,reason:marker,
    rawResponse:{identity:marker},privatePath:f.root}]);
  const plain=runSuccessBaseline({...f.options,days:1},{now});
  for(const output of [JSON.stringify(plain),formatBaseline(plain)]){
    assert.ok(!output.includes(marker));assert.ok(!output.includes('manual.example'));assert.ok(!output.includes(f.root));
    assert.ok(!output.includes('baseline_0'));assert.ok(!output.includes('abcdef'));
  }
  const detailed=runSuccessBaseline({...f.options,days:1,sites:true},{now});
  assert.deepEqual(detailed.days[0].sites,[{domain:'manual.example',status:'actionNeeded'}]);
  assert.ok(!JSON.stringify(detailed).includes(marker));
  const errors=[];
  assert.equal(runBaselineCli(['--config',path.join(f.root,marker),'--json'],{now,stderr:value=>errors.push(value)}),2);
  assert.deepEqual(errors,[JSON.stringify({code:'baseline_unavailable'})]);
});

test('digest site details may be partial and neither delivery attempts nor automatic recovery count as humans',t=>{
  const f=fixture(t),date='2026-11-10',base=daily(f,date).item;
  daily(f,date,undefined,{summary:base.summary+'\n\n需处理\n• manual.example：登录或执行待人工恢复'});
  save(path.join(f.executionRoot,'data/bitwarden/recovery-state.json'),{schemaVersion:1,attempts:Array.from({length:20},()=>({state:'accepted'}))});
  const row=runSuccessBaseline({...f.options,days:1,sites:true},{now}).days[0];
  assert.equal(row.manualInterventions,1);assert.equal(row.sitesComplete,false);
  assert.deepEqual(row.sites,[{domain:'manual.example',status:'actionNeeded'}]);
  assert.deepEqual(row.siteCodes,['unfinished_site_verdicts_not_retained']);
});

test('daily conclusions survive pending delivery; exception/per-change keys never replace the digest',t=>{
  const f=fixture(t),date='2026-11-10',saved=daily(f,date,undefined,{delivered:false});
  const exception={...saved.item,eventKey:saved.item.eventKey+':action_needed:'+hash('synthetic-sites')};
  exception.payloadHash=hash([exception.eventKey,exception.taskId,exception.name,exception.source,exception.status,exception.summary].join('\n'));
  save(path.join(f.executionRoot,'data/notification-outbox',hash(exception.eventKey)+'.json'),exception);
  assert.equal(runSuccessBaseline({...f.options,days:1},{now}).days[0].complete,true);
  fs.unlinkSync(saved.file);
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.total,null);assert.equal(row.complete,false);
});

test('previous generation belongs only to its exact Shanghai day, even when observed on a later day',t=>{
  const f=fixture(t),date='2026-11-10';
  const saved=snapshot(f,date,[{observedStatus:'signed',...positive(date)}]);
  snapshot(f,'2026-11-11',[{observedStatus:'signed',...positive('2026-11-11')}]);
  save(path.join(f.observationRoot,'outputs/dashboard-generation.previous.json'),{schemaVersion:1,snapshot:saved});
  assert.equal(runSuccessBaseline({...f.options,days:1},{now}).days[0].counts.done,1);
  save(path.join(f.observationRoot,'outputs/dashboard-generation.previous.json'),{schemaVersion:1,
    snapshot:{...saved,generatedAt:'2026-11-10T16:00:00Z'}});
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.complete,false);assert.equal(row.total,null);assert.ok(row.missing.includes('snapshot_invalid'));
});

test('engine-daily is a partial fallback and cannot promote an old receipt or cross-day run',t=>{
  const f=fixture(t),date='2026-11-10',file=path.join(f.observationRoot,'outputs/engine-daily-'+date+'.json');
  const saved={businessDate:date,sourceFinishedAt:date+'T02:00:00Z',runId:'20261110-080500-001-abcdef',
    results:[{origin:'https://old.example',...positive('2026-11-09')}]};
  save(file,saved);
  let row=runSuccessBaseline({...f.options,days:1},{now}).days[0];
  assert.equal(row.source,'engine_daily_partial');assert.equal(row.counts.done,0);assert.equal(row.counts.verifying,1);assert.equal(row.complete,false);
  save(file,{...saved,completedCrossDay:true});
  row=runSuccessBaseline({...f.options,days:1},{now}).days[0];assert.equal(row.total,null);
});

test('CLI validation, empty denominator and current-version managed scope',t=>{
  const f=fixture(t),date='2026-11-10';
  for(const args of [['--days','0'],['--days','2.5'],['--until','2026-02-30'],['--sites','--sites'],['--unknown']]){
    assert.equal(runBaselineCli(['--config',f.config,...args],{now,stdout:()=>{},stderr:()=>{}}),2);
  }
  daily(f,date,{done:0,verifying:0,actionNeeded:0,external:0,paused:3,noFeature:2});
  const row=runSuccessBaseline({...f.options,days:1},{now}).days[0];assert.equal(row.total,0);assert.equal(row.completionRate,null);
  for(const file of ['tools/success-baseline.mjs','observation/tests/success-baseline.test.mjs','docs/release-and-recovery.md'])assert.equal(managed.test(file),false);
});

test('real CLI execution leaves every synthetic runtime file and directory unchanged',t=>{
  const f=fixture(t);daily(f,'2026-11-10');
  const inventory=directory=>fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(entry=>{
    const file=path.join(directory,entry.name),stat=fs.statSync(file);
    return [{file:path.relative(f.root,file),mtime:stat.mtimeMs,content:entry.isFile()?hash(fs.readFileSync(file)):null},
      ...(entry.isDirectory()?inventory(file):[])];
  });
  const before=inventory(f.root);
  const output=execFileSync(process.execPath,[path.join(project,'tools/success-baseline.mjs'),'--config',f.config,
    '--days','1','--until','2026-11-10','--json'],{encoding:'utf8',timeout:15000});
  assert.equal(JSON.parse(output).totals.completeDays,1);assert.deepEqual(inventory(f.root),before);
});
