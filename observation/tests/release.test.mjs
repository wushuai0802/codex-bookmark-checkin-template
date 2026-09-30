import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {planRelease,applyRelease,rollbackRelease,auditRelease} from '../../tools/release-lib.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-drill-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),executionRoot=path.join(root,'execution'),observationRoot=path.join(root,'observation');
  for(const dir of [source+'/execution/src',source+'/observation/public',executionRoot+'/src',executionRoot+'/config',observationRoot+'/public'])fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(source+'/execution/src/runner.mjs','new runner');fs.writeFileSync(source+'/observation/public/app.js','new ui');
  fs.writeFileSync(executionRoot+'/src/runner.mjs','old runner');fs.writeFileSync(executionRoot+'/config/config.json','private config');
  return {root,source,executionRoot,observationRoot,files:['execution/src/runner.mjs','observation/public/app.js'],revision:'a'.repeat(40),version:'1.1.0'};}
const lock=async(_plan,run)=>run();
test('release drill preserves private state and restores old code without destroying new files',async t=>{
  const f=fixture(t),plan=planRelease(f),out=await applyRelease(plan,{backupRoot:f.root+'/backups',lock});
  assert.equal(auditRelease(plan).drift.length,0);assert.equal(fs.readFileSync(f.executionRoot+'/config/config.json','utf8'),'private config');
  await rollbackRelease(out.backup,{lock});assert.equal(fs.readFileSync(f.executionRoot+'/src/runner.mjs','utf8'),'old runner');
  assert.equal(fs.existsSync(f.observationRoot+'/public/app.js'),false);assert.equal(fs.readFileSync(out.backup+'/retired/observation/public/app.js','utf8'),'new ui');
});
test('release and rollback refuse drift instead of overwriting unrelated changes',async t=>{
  const f=fixture(t),plan=planRelease(f);fs.writeFileSync(f.executionRoot+'/src/runner.mjs','user edit');
  await assert.rejects(()=>applyRelease(plan,{backupRoot:f.root+'/backups',lock}),/drift/);
  const next=planRelease(f),out=await applyRelease(next,{backupRoot:f.root+'/backups',lock});
  fs.writeFileSync(f.executionRoot+'/src/runner.mjs','later user edit');
  await assert.rejects(()=>rollbackRelease(out.backup,{lock}),/drift/);
  assert.equal(fs.readFileSync(f.executionRoot+'/src/runner.mjs','utf8'),'later user edit');
  assert.throws(()=>planRelease({...f,files:['execution/config/config.json']}),/scope/);
});
