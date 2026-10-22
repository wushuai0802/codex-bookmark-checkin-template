import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {boundMonitorCatalog,validateCurrentPtCatalog,currentBoundMonitorCatalog} from '../src/monitor-catalog.mjs';
test('PT catalog is bound to fresh exact bookmarks and rejects deleted or changed entries',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'Bookmarks'),now=new Date('2026-09-30T01:00:00Z');
  const bookmarks={roots:{bookmark_bar:{id:'1',children:[{id:'2',children:[{type:'url',url:'https://pt.example/attendance.php',name:'Fixture PT'}]}]}}};
  fs.writeFileSync(file,JSON.stringify(bookmarks));
  const catalog=boundMonitorCatalog(file,{parentId:'1',folderId:'2'},now);
  assert.equal(validateCurrentPtCatalog(catalog,{bookmarksPath:file,now}),true);
  assert.throws(()=>validateCurrentPtCatalog(catalog,{bookmarksPath:file,now:new Date(now.getTime()+31*60_000)}),e=>e.code==='PT_PREFLIGHT');
  bookmarks.roots.bookmark_bar.children[0].children=[];fs.writeFileSync(file,JSON.stringify(bookmarks));
  assert.throws(()=>validateCurrentPtCatalog(catalog,{bookmarksPath:file,now}),e=>e.code==='PT_PREFLIGHT');
});

test('reviewed PT in another approved daily folder joins monitoring without admitting unrelated sites',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-registered-scope-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'Bookmarks'),now=new Date('2026-10-07T01:00:00Z');
  fs.writeFileSync(file,JSON.stringify({roots:{bar:{id:'1',children:[
    {id:'2',children:[{type:'url',url:'https://dstudio.me/attendance.php',name:'Depth'}]},
    {id:'3',children:[{type:'url',url:'https://open.cd/index.php',name:'OpenCD'},
      {type:'url',url:'https://service.example/',name:'Service'}]},
    {id:'4',children:[{type:'url',url:'https://piggo.me/attendance.php',name:'Outside approved scope'}]}
  ]}}}));
  const config={bookmarksPath:file,excludedOrigins:[]};
  const plan={targets:[{origin:'https://dstudio.me',title:'Depth',candidates:['https://dstudio.me/attendance.php']},
    {origin:'https://open.cd',title:'OpenCD',folderNames:['公益站'],candidates:['https://open.cd/index.php#']},
    {origin:'https://service.example',candidates:['https://service.example/']}]};
  const catalog=boundMonitorCatalog(file,{parentId:'1',folderId:'2'},now,{config,plan});
  assert.equal(catalog.registration,'current-execution-plan');
  assert.deepEqual(catalog.sites.map(s=>s.origin),['https://dstudio.me','https://open.cd']);
  assert.equal(catalog.sites[1].entryUrl,'https://open.cd/index.php');
  assert.equal(validateCurrentPtCatalog(catalog,{bookmarksPath:file,now,config,plan}),true);
  assert.throws(()=>validateCurrentPtCatalog(catalog,{bookmarksPath:file,now}),e=>e.code==='PT_PREFLIGHT');
  const removed={targets:plan.targets.filter(t=>t.origin!=='https://open.cd')};
  assert.throws(()=>validateCurrentPtCatalog(catalog,{bookmarksPath:file,now,config,plan:removed}),e=>e.code==='PT_PREFLIGHT');
  const excluded={...config,excludedOrigins:['https://open.cd']};
  assert.throws(()=>validateCurrentPtCatalog(catalog,{bookmarksPath:file,now,config:excluded,plan}),e=>e.code==='PT_PREFLIGHT');
  assert.deepEqual(boundMonitorCatalog(file,{parentId:'1',folderId:'2'},now,{config:excluded,plan}).sites.map(s=>s.origin),['https://dstudio.me']);
});

test('current catalog collector reuses execution plan selection, not stale saved results',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-current-plan-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'Bookmarks');fs.mkdirSync(root+'/config');
  fs.writeFileSync(file,JSON.stringify({roots:{bar:{id:'1',children:[{id:'2',children:[]}]}}}));
  fs.writeFileSync(root+'/config/config.json',JSON.stringify({bookmarksPath:file,targetFolderNames:['Approved']}));
  let inspected=false;
  const catalog=await currentBoundMonitorCatalog(root,{parentId:'1',folderId:'2'},new Date('2026-10-07T01:00:00Z'),{
    readPlan:async(bookmarksPath,config)=>{
      inspected=true;assert.equal(bookmarksPath,file);assert.deepEqual(config.targetFolderNames,['Approved']);
      return {targets:[{origin:'https://open.cd',title:'OpenCD',candidates:['https://open.cd/index.php']}]};
    }});
  assert.equal(inspected,true);assert.deepEqual(catalog.sites.map(s=>s.origin),['https://open.cd']);
});
