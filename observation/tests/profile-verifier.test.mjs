import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import {verifyProfile} from '../src/profile-verifier.mjs';

test('profile verifier promotes only the expected identity without mutation',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'profile-verify-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),responses=[{status:200,storageIds:['7'],body:{success:true,data:{id:7,username:'reader'}}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,quota_awarded:1}]}}}}];
  const page={goto:async()=>{},evaluate:async()=>responses.shift()},profile={accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',profileDir:path.join(root,'data','v2-profiles','acct7','chrome-user-data'),state:'pending_login'};
  const result=await verifyProfile({profile:{...profile,verificationReason:'challenge_required'},root,planHash:'a'.repeat(64),executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}})});assert.equal(result.state,'ready');assert.equal(result.identity,'7');assert.equal(result.statusVerified,'already_done');assert.equal(result.verificationReason,null);
});

test('profile verifier requires an explicit non-zero plan binding',async()=>{
  const profile={accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',profileDir:'profiles/acct7'};
  await assert.rejects(()=>verifyProfile({profile,root:process.cwd(),executablePath:'chrome.exe',launchPersistentContext:async()=>({})}),/non-zero SHA-256 hash/);
});

test('failed identity verification clears stale identity fields',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'profile-verify-stale-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),profile={accountKey:'acct8',origin:'https://fixture.example',expectedIdentity:'8',profileDir:path.join(root,'data','v2-profiles','acct8','chrome-user-data'),state:'pending_login',identity:'8',username:'stale',statusVerified:'already_done'};
  const page={goto:async()=>{},evaluate:async()=>({status:200,storageIds:['9'],body:{success:true,data:{id:9,username:'wrong'}}})};
  const result=await verifyProfile({profile,root,planHash:'a'.repeat(64),executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}}),now:`${day}T01:00:00+08:00`});
  assert.equal(result.state,'pending_login');assert.equal(result.identity,null);assert.equal(result.username,null);assert.equal(result.statusVerified,null);
});

test('a WAF challenge preserves an already verified identity but defers execution',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'profile-verify-waf-')),profile={accountKey:'acct9',origin:'https://agentrouter.org',expectedIdentity:'9',profileDir:path.join(root,'data','v2-profiles','acct9','chrome-user-data'),state:'ready',identity:'9',username:'verified',identityVerifiedAt:'2026-09-14T01:00:00.000Z',statusVerified:'already_done'};
  const page={goto:async()=>{},evaluate:async()=>({status:200,storageIds:['9'],body:null,challenge:true})};
  const result=await verifyProfile({profile,root,planHash:'a'.repeat(64),executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}}),now:'2026-09-14T02:00:00.000Z'});
  assert.equal(result.state,'ready');assert.equal(result.identity,'9');assert.equal(result.verificationReason,'challenge_required');assert.equal(result.statusVerified,'deferred');
});

test('profile verification entrypoint imports site adapter rules from V1',()=>{
  const source=fs.readFileSync(new URL('../scripts/verify-v2-profile.mjs',import.meta.url),'utf8');
  assert.match(source,/legacyConfigFile/);assert.match(source,/executionBindingForOrigin/);assert.match(source,/adapterRule:binding\.adapterRule/);
});
