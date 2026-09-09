import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareV1ProfileHandoff,validateProfileHandoff} from '../src/profile-handoff.mjs';

test('profile handoff requires drained V1 runner and binds account/origin/path',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-handoff-')),profile=path.join(root,'data','accounts','acct7','chrome-user-data');
  fs.mkdirSync(profile,{recursive:true});
  const handoff=prepareV1ProfileHandoff({v1Root:root,profileDir:profile,accountKey:'acct7',origin:'https://fixture.example',now:'2026-09-09T01:00:00Z'});
  assert.equal(validateProfileHandoff(handoff,{accountKey:'acct7',origin:'https://fixture.example',profileDir:profile}),true);
  assert.throws(()=>validateProfileHandoff({...handoff,accountKey:'other'},{accountKey:'acct7'}),/mismatch/);
});

test('active V1 run lock blocks profile handoff',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-handoff-')),profile=path.join(root,'data','accounts','acct7');
  fs.mkdirSync(profile,{recursive:true}); fs.mkdirSync(path.join(root,'tmp'),{recursive:true}); fs.writeFileSync(path.join(root,'tmp','run.lock'),'active');
  assert.throws(()=>prepareV1ProfileHandoff({v1Root:root,profileDir:profile,accountKey:'acct7',origin:'https://fixture.example'}),/lock is active/);
});
