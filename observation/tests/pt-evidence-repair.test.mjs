import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ptEvidenceCandidates,repairPtEvidence,refreshEvidenceCatalog} from '../src/pt-evidence-repair.mjs';
import {boundMonitorCatalog,validateCurrentPtCatalog} from '../src/monitor-catalog.mjs';

const now=new Date('2026-09-30T12:00:00Z'),origin='https://pt.example';
function snapshot(){return {businessDate:'2026-09-30',tasks:[{taskId:'t',origin,observedStatus:'signed',submissionAttempted:true}],
  receipts:[{taskId:'t',evidence:{authoritative:false}}]};}
const catalog={sites:[{origin}]};

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
