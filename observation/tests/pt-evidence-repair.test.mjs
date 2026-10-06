import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ptEvidenceCandidates,repairPtEvidence,refreshEvidenceCatalog,previousEvidenceHealth} from '../src/pt-evidence-repair.mjs';
import {boundMonitorCatalog,validateCurrentPtCatalog} from '../src/monitor-catalog.mjs';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';
import {rebuildDashboardAfterEvidence} from '../src/pt-evidence-repair.mjs';

const now=new Date('2026-09-30T12:00:00Z'),origin='https://pt.example';
function snapshot(){return {businessDate:'2026-09-30',tasks:[{taskId:'t',origin,observedStatus:'signed',submissionAttempted:true}],
  receipts:[{taskId:'t',evidence:{authoritative:false}}]};}
const catalog={sites:[{origin}]};

test('evidence rebuild carries forward the previous health source when a fresh probe is unavailable',()=>{
  const health=previousEvidenceHealth({health:{healthy:true,sourceCheckedAt:'2026-09-30T11:55:00.000Z',
    failedCheckCount:2,reason:'ok'}});
  assert.equal(health.healthy,true);assert.equal(health.checkedAt,'2026-09-30T11:55:00.000Z');
  assert.equal(health.failedChecks.length,2);assert.equal(health.reason,'ok');
});

test('refreshing a catalog keeps its exact folder while rebinding harmless bookmark changes',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-evidence-catalog-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacy=root+'/legacy';fs.mkdirSync(legacy+'/config',{recursive:true});fs.mkdirSync(root+'/config');
  const bookmarksPath=root+'/Bookmarks',document={roots:{bookmark_bar:{id:'1',type:'folder',children:[
    {id:'2',type:'folder',name:'PT',children:[{id:'3',type:'url',name:'Site',url:origin+'/attendance.php'}]},
    {id:'4',type:'folder',name:'Other',children:[{id:'5',type:'url',name:'Other site',url:'https://outside.example/'}]}
  ]}}};
  fs.writeFileSync(bookmarksPath,JSON.stringify(document));
  fs.writeFileSync(legacy+'/config/config.json',JSON.stringify({bookmarksPath}));
  fs.writeFileSync(root+'/config/runtime.local.json',JSON.stringify({legacyRoot:legacy}));
  const original=boundMonitorCatalog(bookmarksPath,{parentId:'1',folderId:'2'},now),file=root+'/catalog.json';
  fs.writeFileSync(file,JSON.stringify(original));
  document.checksum='changed-by-browser';fs.writeFileSync(bookmarksPath,JSON.stringify(document));
  assert.throws(()=>validateCurrentPtCatalog(original,{bookmarksPath,now}));
  const fresh=JSON.parse(fs.readFileSync(refreshEvidenceCatalog(root,file,now)));
  assert.equal(validateCurrentPtCatalog(fresh,{bookmarksPath,now}),true);
  assert.deepEqual(fresh.scope,original.scope);assert.deepEqual(fresh.sites.map(s=>s.origin),[origin]);
});
test('only same-day reported PT completions without evidence enter passive repair',()=>{
  assert.deepEqual(ptEvidenceCandidates(snapshot(),catalog,{sites:{}},now),[origin]);
  assert.deepEqual(ptEvidenceCandidates({...snapshot(),businessDate:'2026-09-29'},catalog,{sites:{}},now),[]);
  const wrong=snapshot();wrong.tasks[0].failureCode='submission_outcome_unknown';
  wrong.tasks[0].observedStatus='needs_attention';wrong.tasks[0].submissionAttempted=true;
  assert.deepEqual(ptEvidenceCandidates(wrong,catalog,{sites:{}},now),[origin]);
  wrong.tasks[0].submissionAttempted=false;
  assert.deepEqual(ptEvidenceCandidates(wrong,catalog,{sites:{}},now),[]);
  const verified=snapshot();verified.receipts[0].evidence.authoritative=true;
  assert.deepEqual(ptEvidenceCandidates(verified,catalog,{sites:{}},now),[]);
  assert.deepEqual(ptEvidenceCandidates(snapshot(),{sites:[]},{sites:{}},now),[]);
});

test('repair never submits or erases a reported completion; unresolved evidence is bounded',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-repair-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify(catalog));
  const refreshCatalog=()=>catalogFile;
  let calls=0,records=0;
  const runSite=async input=>{calls++;assert.equal(input.readOnly,true);return {origin,status:'unknown',evidence:{authoritative:false}};};
  await repairPtEvidence({root,catalogFile,refreshCatalog,clock:()=>now,runSite,record:()=>records++});
  await repairPtEvidence({root,catalogFile,refreshCatalog,clock:()=>now,runSite,record:()=>records++});
  assert.equal(calls,1);assert.equal(records,0);
  assert.equal(JSON.parse(fs.readFileSync(root+'/outputs/shadow-beta-snapshot.json')).tasks[0].observedStatus,'signed');
  const later=new Date(now.getTime()+3*3600000);
  await repairPtEvidence({root,catalogFile,refreshCatalog,clock:()=>later,runSite:async input=>{
    assert.equal(input.readOnly,true);return {origin,status:'already_signed',evidence:{authoritative:true}};
  },record:()=>{records++;return {recorded:true};}});
  assert.equal(records,1);
  const state=JSON.parse(fs.readFileSync(root+'/data/pt-evidence-repair.json'));
  assert.equal(state.sites[origin].outcome,'verified');
  assert.deepEqual(ptEvidenceCandidates(snapshot(),catalog,state,later),[]);
});

test('fair queue advances to the next registered PT after a bounded review',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-fair-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');
  const audiences='https://audiences.example',dstudio='https://dstudio.example';
  const value={businessDate:'2026-09-30',tasks:[
    {taskId:'a',origin:audiences,observedStatus:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true},
    {taskId:'d',origin:dstudio,observedStatus:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}
  ],receipts:[{taskId:'a',evidence:{authoritative:false}},{taskId:'d',evidence:{authoritative:false}}]};
  fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(value));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin:audiences},{origin:dstudio}]}));
  const seen=[];
  const runSite=async input=>{seen.push(input.origin);assert.equal(input.readOnly,true);return {origin:input.origin,status:'unknown',evidence:{authoritative:false}};};
  await repairPtEvidence({root,catalogFile,maxSites:1,refreshCatalog:()=>catalogFile,clock:()=>now,runSite});
  await repairPtEvidence({root,catalogFile,maxSites:1,refreshCatalog:()=>catalogFile,clock:()=>now,runSite});
  assert.deepEqual(seen,[audiences,dstudio]);
  const audit=fs.readFileSync(root+'/data/pt-evidence-repair-audit-2026-09-30.jsonl','utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(audit.map(item=>item.origin),[audiences,dstudio]);
  assert.ok(audit.every(item=>item.readOnly===true&&item.submissionAttempted===false&&item.errorStage==='readback'));
  const marker=JSON.parse(fs.readFileSync(root+'/outputs/pt-evidence-repair-dirty-2026-09-30.json'));
  assert.equal(marker.needsDashboardSync,true);assert.equal(marker.resultCount,1);
});

test('completion invokes a dashboard rebuild callback after passive verification',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-rebuild-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify(catalog));
  let rebuilt=null;
  const result=await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,clock:()=>now,
    runSite:async input=>({origin,status:'already_signed',observedAt:now.toISOString(),accountKey:'site-default',profileBinding:'a'.repeat(64),
      operationMode:'safe_history_page',readSafety:'reviewed_passive',evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-30',evidenceScope:'site_account_day'}}),
    record:()=>({recorded:true}),rebuild:async value=>{rebuilt=value;return {rebuilt:true,snapshotId:'snap_test'};}});
  assert.equal(result.rebuild.rebuilt,true);assert.equal(rebuilt.results[0].origin,origin);
  assert.equal(result.dirtyMarker,'pt-evidence-repair-dirty-2026-09-30.json');
});

test('an empty evidence pass does not create a recurring publication marker',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-empty-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify({sites:[]}));
  const result=await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,clock:()=>now,runSite:async()=>{
    throw new Error('runSite must not be called for an empty candidate set');
  }});
  assert.equal(result.results.length,0);
  assert.equal(result.dirtyMarker,null);
  assert.equal(fs.existsSync(root+'/outputs/pt-evidence-repair-dirty-2026-09-30.json'),false);
});

test('busy passive reviews have a separate bounded wakeup budget',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-busy-budget-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify(catalog));
  let calls=0;
  const runSite=async()=>{calls++;throw Error('V2 runner is already active');};
  for(let index=0;index<24;index++){
    const at=new Date(now.getTime()+index*5*60_000);
    await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,clock:()=>at,runSite});
  }
  const state=JSON.parse(fs.readFileSync(root+'/data/pt-evidence-repair.json'));
  assert.equal(calls,24);assert.equal(state.sites[origin].wakeups,24);
  assert.equal(state.sites[origin].outcome,'busy_budget_exhausted');
  await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,
    clock:()=>new Date(now.getTime()+25*5*60_000),runSite});
  assert.equal(calls,24,'busy wakeups must stop after the daily bound');
});

test('malformed passive state is normalized and cannot bypass the attempt bound',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-state-guard-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/outputs');fs.mkdirSync(root+'/data');
  fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  fs.writeFileSync(root+'/data/pt-evidence-repair.json',JSON.stringify({schemaVersion:1,sites:{[origin]:{
    businessDate:'2026-09-30',nextAttemptAt:'not-a-date'
  }}}));
  const catalogFile=root+'/catalog.json';fs.writeFileSync(catalogFile,JSON.stringify(catalog));
  let calls=0;const runSite=async()=>{calls++;return {origin,status:'unknown',evidence:{authoritative:false}};};
  await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,clock:()=>now,runSite});
  await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,
    clock:()=>new Date(now.getTime()+2*3600000),runSite});
  await repairPtEvidence({root,catalogFile,refreshCatalog:()=>catalogFile,
    clock:()=>new Date(now.getTime()+4*3600000),runSite});
  const state=JSON.parse(fs.readFileSync(root+'/data/pt-evidence-repair.json'));
  assert.equal(calls,2);assert.equal(state.sites[origin].attempts,2);
  assert.ok(Number.isFinite(Date.parse(state.sites[origin].nextAttemptAt)));
});

test('busy publication rebuild releases the engine lease before deferring',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-proof-lock-release-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/config',{recursive:true});fs.mkdirSync(root+'/outputs');fs.mkdirSync(root+'/data');
  const legacy=root+'/legacy';fs.mkdirSync(legacy);
  fs.writeFileSync(root+'/config/runtime.local.json',JSON.stringify({legacyRoot:legacy}));
  fs.writeFileSync(root+'/outputs/shadow-beta-snapshot.json',JSON.stringify(snapshot()));
  const publication=acquireExecutionLock(root,{name:'shadow-publication.lock'});
  try {
    const result=rebuildDashboardAfterEvidence({root,catalogFile:root+'/catalog.json',now});
    assert.equal(result.reason,'runner_busy');
    assert.equal(fs.existsSync(root+'/data/v2-run.lock'),false);
  } finally { releaseExecutionLock(publication); }
});
