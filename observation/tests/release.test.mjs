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
  fs.writeFileSync(source+'/observation/Dockerfile','FROM node:24-alpine\nCOPY package.json release.json ./\n');
  fs.writeFileSync(observationRoot+'/Dockerfile','FROM node:24-alpine\nCOPY package.json ./\n');
  fs.writeFileSync(executionRoot+'/src/runner.mjs','old runner');fs.writeFileSync(executionRoot+'/config/config.json','private config');
  return {root,source,executionRoot,observationRoot,files:['execution/src/runner.mjs','observation/public/app.js','observation/Dockerfile'],revision:'a'.repeat(40),version:'1.1.0'};}
const lock=async(_plan,run)=>run();
test('release drill preserves private state and restores old code without destroying new files',async t=>{
  const f=fixture(t),plan=planRelease(f),out=await applyRelease(plan,{backupRoot:f.root+'/backups',lock});
  assert.equal(auditRelease(plan).drift.length,0);assert.equal(fs.readFileSync(f.executionRoot+'/config/config.json','utf8'),'private config');
  assert.match(fs.readFileSync(f.observationRoot+'/Dockerfile','utf8'),/COPY package.json release.json/);
  await rollbackRelease(out.backup,{lock});assert.equal(fs.readFileSync(f.executionRoot+'/src/runner.mjs','utf8'),'old runner');
  assert.equal(fs.readFileSync(f.observationRoot+'/Dockerfile','utf8'),'FROM node:24-alpine\nCOPY package.json ./\n');
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
  if(process.platform==='win32')assert.throws(()=>planRelease({...f,observationRoot:f.executionRoot.toUpperCase()}),/distinct/);
});

test('public runtime rules and deployment inputs are released and rolled back without local configuration',async t=>{
  const f=fixture(t),publicFiles=[
    'execution/config/defaults.json','execution/config/qa-rules.json','execution/config/site-rules.public.json',
    'execution/requirements-ocr.txt','observation/compose.nas.yaml','observation/compose.worker.yaml','observation/.dockerignore'
  ];
  for(const file of publicFiles){
    const [layer,...parts]=file.split('/'),relative=parts.join('/');
    fs.mkdirSync(path.dirname(path.join(f.source,file)),{recursive:true});
    fs.writeFileSync(path.join(f.source,file),'new '+file);
    fs.writeFileSync(path.join(f[layer+'Root'],relative),'old '+file);
  }
  for(const file of ['execution/config/config.local.json','execution/config/qa-rules.local.json','execution/data/account-bindings.json','observation/config/runtime.local.json']){
    assert.throws(()=>planRelease({...f,files:[file]}),/outside release scope/);
  }
  const plan=planRelease({...f,files:[...f.files,...publicFiles]});
  const out=await applyRelease(plan,{backupRoot:f.root+'/backups',lock});
  assert.equal(auditRelease(plan).drift.length,0);
  for(const file of publicFiles){const [layer,...parts]=file.split('/');assert.equal(fs.readFileSync(path.join(f[layer+'Root'],...parts),'utf8'),'new '+file);}
  await rollbackRelease(out.backup,{lock});
  for(const file of publicFiles){const [layer,...parts]=file.split('/');assert.equal(fs.readFileSync(path.join(f[layer+'Root'],...parts),'utf8'),'old '+file);}
  assert.equal(fs.readFileSync(f.executionRoot+'/config/config.json','utf8'),'private config');
});

test('new public input refuses source or runtime drift before copying other code',async t=>{
  const f=fixture(t),file='execution/config/defaults.json';
  fs.mkdirSync(f.source+'/execution/config');fs.writeFileSync(f.source+'/'+file,'new defaults');
  fs.writeFileSync(f.executionRoot+'/config/defaults.json','old defaults');
  const first=planRelease({...f,files:[...f.files,file]});
  fs.writeFileSync(f.source+'/'+file,'changed source');
  await assert.rejects(()=>applyRelease(first,{backupRoot:f.root+'/backups',lock}),/release drift/);
  const second=planRelease({...f,files:[...f.files,file]});
  fs.writeFileSync(f.executionRoot+'/config/defaults.json','local runtime repair');
  await assert.rejects(()=>applyRelease(second,{backupRoot:f.root+'/backups',lock}),/release drift/);
  assert.equal(fs.readFileSync(f.executionRoot+'/src/runner.mjs','utf8'),'old runner');
  assert.equal(fs.readFileSync(f.executionRoot+'/config/defaults.json','utf8'),'local runtime repair');
});

test('failed release restores old code and retires newly installed files',async t=>{
  const f=fixture(t),plan=planRelease(f),rename=fs.renameSync;
  t.mock.method(fs,'renameSync',(from,to)=>{
    if(to===path.join(f.executionRoot,'src/runner.mjs')&&String(from).endsWith('.tmp'))throw Error('fixture write failure');
    return rename(from,to);
  });
  await assert.rejects(()=>applyRelease(plan,{backupRoot:f.root+'/backups',lock}),/fixture write failure/);
  assert.equal(fs.readFileSync(f.executionRoot+'/src/runner.mjs','utf8'),'old runner');
  assert.equal(fs.existsSync(f.observationRoot+'/public/app.js'),false);
  const [backup]=fs.readdirSync(f.root+'/backups');
  assert.equal(fs.readFileSync(path.join(f.root,'backups',backup,'retired/observation/public/app.js'),'utf8'),'new ui');
  assert.equal(fs.readFileSync(f.executionRoot+'/config/config.json','utf8'),'private config');
});

test('operations runtime receives bounded shadow sync code without replacing its private config',async t=>{
  const f=fixture(t),opsRoot=f.root+'/operations';fs.mkdirSync(opsRoot+'/scripts',{recursive:true});fs.mkdirSync(opsRoot+'/config',{recursive:true});
  fs.mkdirSync(f.source+'/observation/scripts',{recursive:true});
  fs.writeFileSync(f.source+'/observation/scripts/Sync-NasShadow.ps1','new sync');
  fs.writeFileSync(f.source+'/observation/scripts/Start-NasShadowScheduler.ps1','new scheduler');
  fs.writeFileSync(opsRoot+'/scripts/Sync-NasShadow.ps1','old sync');
  fs.writeFileSync(opsRoot+'/scripts/Start-NasShadowScheduler.ps1','old scheduler');
  fs.writeFileSync(opsRoot+'/config/config.json','private ops config');
  const plan=planRelease({...f,opsRoot,files:[...f.files,'observation/scripts/Sync-NasShadow.ps1','observation/scripts/Start-NasShadowScheduler.ps1']});
  const out=await applyRelease(plan,{backupRoot:f.root+'/backups',lock});
  assert.equal(fs.readFileSync(opsRoot+'/scripts/Sync-NasShadow.ps1','utf8'),'new sync');
  assert.equal(fs.readFileSync(opsRoot+'/scripts/Start-NasShadowScheduler.ps1','utf8'),'new scheduler');
  assert.equal(fs.readFileSync(opsRoot+'/config/config.json','utf8'),'private ops config');
  assert.equal(auditRelease(plan).drift.length,0);
  await rollbackRelease(out.backup,{lock});
  assert.equal(fs.readFileSync(opsRoot+'/scripts/Sync-NasShadow.ps1','utf8'),'old sync');
  assert.equal(fs.readFileSync(opsRoot+'/scripts/Start-NasShadowScheduler.ps1','utf8'),'old scheduler');
  assert.equal(fs.readFileSync(opsRoot+'/config/config.json','utf8'),'private ops config');
});
