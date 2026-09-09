import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {verifyProfile} from '../src/profile-verifier.mjs';

test('profile verifier promotes only the expected identity without mutation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'profile-verify-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),responses=[{status:200,storageIds:['7'],body:{success:true,data:{id:7,username:'reader'}}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,quota_awarded:1}]}}}}];
  const page={goto:async()=>{},evaluate:async()=>responses.shift()},profile={accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',profileDir:path.join(root,'profiles','acct7'),state:'pending_login'};
  const result=await verifyProfile({profile,root,planHash:'a'.repeat(64),executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}})});assert.equal(result.state,'ready');assert.equal(result.identity,'7');assert.equal(result.statusVerified,'already_done');
});

test('profile verifier requires an explicit non-zero plan binding',async()=>{
  const profile={accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',profileDir:'profiles/acct7'};
  await assert.rejects(()=>verifyProfile({profile,root:process.cwd(),executablePath:'chrome.exe',launchPersistentContext:async()=>({})}),/non-zero SHA-256 hash/);
});
