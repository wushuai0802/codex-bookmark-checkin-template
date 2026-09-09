import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireExecutionLock,releaseExecutionLock} from '../src/execution-lock.mjs';

test('V2 execution lock is exclusive and releases its owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),lease=acquireExecutionLock(root);
  assert.throws(()=>acquireExecutionLock(root),/already active/);assert.equal(releaseExecutionLock(lease),true);assert.equal(releaseExecutionLock(lease),false);
});

test('dead V2 execution lock is recoverable',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),file=path.join(root,'data','v2-run.lock');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,pid:2147483647,nonce:'stale'}));const lease=acquireExecutionLock(root);assert.equal(releaseExecutionLock(lease),true);
});

test('an old incomplete lock is quarantined after its grace period',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-lock-')),file=path.join(root,'data','v2-run.lock');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'{');
  const old=new Date(Date.now()-10_000);fs.utimesSync(file,old,old);const lease=acquireExecutionLock(root);assert.equal(releaseExecutionLock(lease),true);
});
