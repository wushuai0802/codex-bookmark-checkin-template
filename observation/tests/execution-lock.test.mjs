import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';

test('V2 execution lock is exclusive and releases its owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),lease=acquireExecutionLock(root);
  assert.throws(()=>acquireExecutionLock(root),/already active/);assert.equal(releaseExecutionLock(lease),true);assert.equal(releaseExecutionLock(lease),false);
});

test('dead V2 execution lock is recoverable',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),file=path.join(root,'data','v2-run.lock');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,pid:2147483647,nonce:'stale'}));const lease=acquireExecutionLock(root);assert.equal(releaseExecutionLock(lease),true);
});

test('an incomplete lock is not reclaimed on age alone',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),file=path.join(root,'data','v2-run.lock');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{');
  const old=new Date(Date.now()-10_000);fs.utimesSync(file,old,old);
  assert.throws(()=>acquireExecutionLock(root),/unreadable/);assert.equal(fs.readFileSync(file,'utf8'),'{');
});

test('worker lock release cannot remove a replacement owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'worker-lock-')),lease=acquireExecutionLock(root,{name:'harvest-fallback.lock'});
  assert.throws(()=>acquireExecutionLock(root,{name:'harvest-fallback.lock'}),/already active/);
  const replacement={...lease.owner,nonce:'replacement-owner'};fs.writeFileSync(lease.file,JSON.stringify(replacement));
  assert.equal(releaseExecutionLock(lease),false);assert.equal(JSON.parse(fs.readFileSync(lease.file,'utf8')).nonce,replacement.nonce);
  fs.rmSync(root,{recursive:true,force:true});
});

test('two processes cannot both reclaim and hold a dead lease',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'concurrent-lock-'));
  fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/v2-run.lock'),JSON.stringify({pid:2147483647,nonce:'dead'}));
  const children=[];
  t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();fs.rmSync(root,{recursive:true,force:true});});
  const program="import {acquireExecutionLock,releaseExecutionLock} from "+JSON.stringify(new URL('../src/execution-lock.mjs',import.meta.url).href)+";let lease;try{lease=acquireExecutionLock(process.argv[1]);console.log('owned');process.stdin.once('data',()=>{releaseExecutionLock(lease);process.exit(0);});}catch{console.log('busy');}";
  const launch=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',program,root],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    children.push(child);child.once('error',reject);child.stdout.once('data',bytes=>resolve(bytes.toString().trim()));
  });
  const results=await Promise.all([launch(),launch()]);
  assert.deepEqual(results.sort(),['busy','owned']);
  await Promise.all(children.map(child=>new Promise(resolve=>{
    if(child.exitCode!==null){resolve();return;}
    child.once('exit',resolve);child.stdin.end('release');
  })));
});
