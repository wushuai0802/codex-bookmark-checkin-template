import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureRuntime} from '../../tools/configure-runtime.mjs';
test('fresh runtime binding keeps the existing account config and refuses another execution owner',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bind-runtime-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const executionRoot=path.join(root,'execution'),observationRoot=path.join(root,'observation');
  fs.mkdirSync(executionRoot+'/config',{recursive:true});fs.mkdirSync(executionRoot+'/data');
  fs.writeFileSync(executionRoot+'/config/config.json','{"existingAccount":"fixture"}');fs.writeFileSync(executionRoot+'/data/last-valid-bookmark-plan.json','{"targets":[]}');
  await configureRuntime({executionRoot,observationRoot,lock:async(_plan,run)=>run()});
  assert.equal(fs.readFileSync(executionRoot+'/config/config.json','utf8'),'{"existingAccount":"fixture"}');
  assert.equal(JSON.parse(fs.readFileSync(observationRoot+'/config/runtime.local.json')).legacyRoot,executionRoot);
  await assert.rejects(()=>configureRuntime({executionRoot,observationRoot:root+'/different',lock:async()=>{throw Error('must not lock');}}),/binding differs/);
});
