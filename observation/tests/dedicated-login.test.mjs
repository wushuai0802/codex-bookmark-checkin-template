import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {dedicatedLoginPlan,launchDedicatedLogin,validateLoginFiles} from '../src/dedicated-login.mjs';
import {freshProfilePath} from '../src/v2-profile-registry.mjs';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dedicated-login-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const profile={accountKey:'account1',origin:'https://fixture.example',expectedIdentity:'7',state:'pending_login'};
 profile.profileDir=freshProfilePath({v2Root:root,...profile});fs.mkdirSync(profile.profileDir,{recursive:true});
 const executablePath=path.join(root,'chrome.exe');fs.writeFileSync(executablePath,'fixture');
 return {root,registry:{profiles:[profile]},accountKey:profile.accountKey,executablePath,visible:true};
}
test('visible login binds exact account and uses positive coordinates without CDP',t=>{
 const options=fixture(t),plan=dedicatedLoginPlan(options);validateLoginFiles(plan,options.root);
 assert.equal(plan.expectedIdentity,'7');assert.ok(plan.args.includes('--window-position=100,80'));
 assert.equal(plan.args.at(-1),'https://fixture.example');
 assert.ok(!plan.args.some(arg=>/remote-debugging|start-minimized|-32000/.test(arg)));
 assert.ok(plan.args.includes(`--user-data-dir=${options.registry.profiles[0].profileDir}`));
});
test('rejects missing consent, unknown/duplicate accounts, other profiles and executables',t=>{
 const options=fixture(t);
 assert.throws(()=>dedicatedLoginPlan({...options,visible:false}),/explicit/);
 assert.throws(()=>dedicatedLoginPlan({...options,accountKey:'unknown'}),/exactly one/);
 assert.throws(()=>dedicatedLoginPlan({...options,registry:{profiles:[...options.registry.profiles,...options.registry.profiles]}}),/exactly one/);
 assert.throws(()=>dedicatedLoginPlan({...options,executablePath:path.join(options.root,'powershell.exe')}),/Chrome executable/);
 options.registry.profiles[0].profileDir=path.join(options.root,'normal-chrome');
 assert.throws(()=>dedicatedLoginPlan(options),/does not match/);
});
test('manual login holds execution lock until browser closes, without changing registry',async t=>{
 const options=fixture(t),plan=dedicatedLoginPlan(options),before=JSON.stringify(options.registry),child=new EventEmitter();child.pid=321;
 let started=false;
 const running=launchDedicatedLogin({root:options.root,plan,spawnBrowser:(exe,args,config)=>{
  assert.equal(exe,plan.executablePath);assert.equal(config.shell,false);assert.equal(config.windowsHide,false);
  queueMicrotask(()=>child.emit('spawn'));return child;
 },onStarted:()=>{started=true;}});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(started,true);
 assert.throws(()=>acquireExecutionLock(options.root),/already active/);
 child.emit('exit',0);await running;
 const lease=acquireExecutionLock(options.root);releaseExecutionLock(lease);
 assert.equal(JSON.stringify(options.registry),before);
});
test('active worker blocks launch; spawn failure releases only its own lock',async t=>{
 const options=fixture(t),plan=dedicatedLoginPlan(options),lease=acquireExecutionLock(options.root);
 await assert.rejects(()=>launchDedicatedLogin({root:options.root,plan,spawnBrowser:()=>{throw Error('should not spawn');}}),/already active/);
 releaseExecutionLock(lease);
 await assert.rejects(()=>launchDedicatedLogin({root:options.root,plan,spawnBrowser:()=>{throw Error('launch blocked');}}),/launch blocked/);
 assert.equal(fs.existsSync(path.join(options.root,'data/v2-run.lock')),false);
});
