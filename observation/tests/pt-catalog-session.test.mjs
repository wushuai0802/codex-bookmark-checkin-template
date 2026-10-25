import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {withCurrentPtCatalog,refreshEvidenceCatalog} from '../src/pt-catalog.mjs';
import {boundMonitorCatalog,validateCurrentPtCatalog} from '../src/monitor-catalog.mjs';
test('manual operations refresh stale inventory into an owned immutable file and reject a changed selected entry',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-catalog-session-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacy=path.join(root,'legacy'),bookmarksPath=path.join(root,'Bookmarks'),origin='https://cspt.top',now=new Date();
  for(const folder of ['legacy/config','config'])fs.mkdirSync(path.join(root,folder),{recursive:true});
  const document={roots:{bookmark_bar:{id:'1',type:'folder',children:[{id:'2',type:'folder',name:'PT',children:[{id:'3',type:'url',name:'Site',url:origin+'/attendance.php'}]}]}}};
  fs.writeFileSync(bookmarksPath,JSON.stringify(document));fs.writeFileSync(legacy+'/config/config.json',JSON.stringify({bookmarksPath}));
  fs.writeFileSync(root+'/config/runtime.local.json',JSON.stringify({legacyRoot:legacy}));
  const file=path.join(root,'catalog.json'),old=boundMonitorCatalog(bookmarksPath,{folderId:'2',parentId:'1'},new Date(now.getTime()-31*60_000));
  fs.writeFileSync(file,JSON.stringify(old));let owned;
  await withCurrentPtCatalog({root,catalogFile:file,origin,now},async input=>{
    owned=input.catalogFile;assert.notEqual(owned,file);assert.equal(validateCurrentPtCatalog(input.catalog,{bookmarksPath,now}),true);
    await refreshEvidenceCatalog(root,file,new Date(now.getTime()+1000));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(owned)).digest('hex'),input.catalogHash);
  });
  assert.equal(fs.existsSync(owned),false);assert.equal(JSON.parse(fs.readFileSync(file)).generatedAt,old.generatedAt);
  document.roots.bookmark_bar.children[0].children[0].url=origin+'/index.php';fs.writeFileSync(bookmarksPath,JSON.stringify(document));
  await assert.rejects(withCurrentPtCatalog({root,catalogFile:file,origin,now},async()=>{throw Error('must not dispatch');}),error=>error.code==='PT_PREFLIGHT');
  assert.deepEqual(fs.readdirSync(path.join(root,'tmp')),[]);
});
