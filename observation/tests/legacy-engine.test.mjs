import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {engineCommand,validateEngineLease,runLegacyEngine,readLegacyHealth} from '../src/legacy-engine.mjs';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';
import {runCanary} from '../src/canary-runner.mjs';
import {publicCanaryResults} from '../src/canary-report-view.mjs';
import {runtimeOwners} from '../src/dashboard-runtime.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-engine-')),legacyRoot=path.join(root,'legacy');
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 for(const folder of ['config','outputs','legacy/config','legacy/data'])fs.mkdirSync(path.join(root,folder),{recursive:true});
 const shell=path.join(root,'pwsh.exe');fs.writeFileSync(shell,'fixture');
 fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot,powershellExecutable:shell}));
 fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
 fs.writeFileSync(path.join(legacyRoot,'config/config.json'),'{}');return {root,legacyRoot};
}
test('unified engine uses original scripts without shell interpolation or copied profiles',()=>{
 const args=engineCommand({legacyRoot:path.resolve('fixture'),mode:'execute',accountKeys:['acct7','acct8']});
 assert.ok(args.includes('-SuppressReport'));assert.ok(args.includes('acct7,acct8'));assert.match(args[7],/Run-Checkin\.ps1$/);
 assert.throws(()=>engineCommand({legacyRoot:'.',mode:'execute',accountKeys:['x;exit']}),/invalid account/);
 assert.throws(()=>engineCommand({legacyRoot:'.',mode:'execute',origins:['https://site.example/logout?token=x']}),/invalid origin/);
});
test('engine child requires matching root nonce and live owner',t=>{
 const f=fixture(t),lease=acquireExecutionLock(f.root),env={CHECKIN_V2_ENGINE_ROOT:f.root,CHECKIN_V2_ENGINE_LEASE:lease.owner.nonce};
 assert.equal(validateEngineLease({...f,env}),true);
 assert.throws(()=>validateEngineLease({...f,env:{...env,CHECKIN_V2_ENGINE_LEASE:'other'}}),/lease mismatch/);
 assert.throws(()=>validateEngineLease({...f,legacyRoot:path.join(f.root,'other'),env}),/binding mismatch/);
 releaseExecutionLock(lease);
});
test('dry run holds V2 lock until V1 child exits and releases on spawn failure',async t=>{
 const f=fixture(t);let captured;
 const r=await runLegacyEngine({...f,mode:'dry-run',spawnChild:(shell,args,options)=>{
   captured=options;assert.ok(args.includes('-DryRun'));assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
   assert.throws(()=>acquireExecutionLock(f.root),/already active/);validateEngineLease({...f,env:options.env});
   const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;
 }});
 assert.equal(r.exitCode,0);assert.equal(fs.existsSync(path.join(f.root,'data/v2-run.lock')),false);assert.ok(captured.env.CHECKIN_V2_ENGINE_LEASE);
 await assert.rejects(()=>runLegacyEngine({...f,spawnChild:()=>{throw Error('spawn failed');}}),/spawn failed/);
 assert.equal(fs.existsSync(path.join(f.root,'data/v2-run.lock')),false);
});

test('scheduled probe without a new final report leaves yesterday and dashboard state unchanged',async t=>{
 const f=fixture(t),file=path.join(f.root,'outputs/engine-latest.json'),value='{"sentinel":"keep"}';
 fs.writeFileSync(file,value);
 const result=await runLegacyEngine({...f,mode:'scheduled',spawnChild:()=>{const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}});
 assert.equal(result.skipped,true);assert.equal(result.reason,'no_new_final_report');
 assert.equal(fs.readFileSync(file,'utf8'),value);
 assert.equal(fs.existsSync(path.join(f.root,'outputs/shadow-beta-snapshot.json')),false);
});
test('scheduled invocation skips an active V2 run without a failed task result',async t=>{
 const f=fixture(t),lease=acquireExecutionLock(f.root);
 try {
   const r=await runLegacyEngine({...f,mode:'scheduled',spawnChild:()=>{throw Error('cannot start while locked');}});
   assert.equal(r.skipped,true);assert.equal(r.reason,'executor_busy');assert.equal(r.exitCode,0);
   await assert.rejects(()=>runLegacyEngine({...f,mode:'execute'}),/already active/);
 }finally{releaseExecutionLock(lease);}
});
test('fresh V1 health is consumed only from a valid read-only check',t=>{
 const f=fixture(t),file=path.join(f.legacyRoot,'scripts/Test-CheckinHealth.ps1');
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'fixture');
 const healthy={healthy:true,checkedAt:new Date().toISOString(),failedChecks:[]};
 const valid=readLegacyHealth({...f,spawnHealth:()=>({status:0,stdout:JSON.stringify(healthy)})});
 assert.deepEqual(valid,healthy);
 assert.equal(readLegacyHealth({...f,spawnHealth:()=>({status:1,stdout:'{}'})}),null);
 assert.equal(readLegacyHealth({...f,spawnHealth:()=>({status:0,stdout:'{}'})}),null);
});
test('retired standalone executor and stale dashboard canaries cannot run or overlay',async t=>{
 const f=fixture(t);await assert.rejects(()=>runCanary({root:f.root,execute:true}),/retired/);
 fs.writeFileSync(path.join(f.root,'outputs/engine-selection.json'),JSON.stringify({executionEngine:'v1'}));
 assert.deepEqual(publicCanaryResults(path.join(f.root,'outputs')),[]);assert.deepEqual(runtimeOwners(path.join(f.root,'outputs')),[]);
});
