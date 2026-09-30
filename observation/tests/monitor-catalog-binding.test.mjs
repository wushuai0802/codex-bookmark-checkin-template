import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {boundMonitorCatalog,validateCurrentPtCatalog} from '../src/monitor-catalog.mjs';
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
