import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {appendFreshProfile,enrollFreshProfile,markProfileReady} from '../src/v2-profile-registry.mjs';

test('fresh profile enrollment creates a clean V2 path and blocks V1 stop until identity proof',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-profile-'));
  const pending=enrollFreshProfile({v2Root:root,accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',provider:'LinuxDO'});
  assert.equal(pending.state,'pending_login'); assert.equal(pending.v1TaskStopEligible,false); assert.ok(fs.existsSync(pending.profileDir));
  const ready=markProfileReady(pending,{identity:'7',username:'reader'});
  assert.equal(ready.state,'ready'); assert.equal(ready.v1TaskStopEligible,false); assert.equal(ready.verificationReason,null);
  assert.throws(()=>markProfileReady(pending,{identity:'8'}),/mismatch/);
});

test('one fresh site profile appends without replacing existing registrations',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-profile-append-'));
  const existing=enrollFreshProfile({v2Root:root,accountKey:'existing',origin:'https://existing.example',expectedIdentity:'1',provider:'LinuxDO'});
  const base={schemaVersion:1,mode:'fresh_v2_profiles',executionEnabled:false,profiles:[existing]};
  const added=appendFreshProfile(base,{v2Root:root,accountKey:'next',origin:'https://next.example',expectedIdentity:'2',provider:'Password'});
  assert.equal(added.reused,false);assert.equal(added.registry.profiles.length,2);assert.equal(added.profile.state,'pending_login');
  const reused=appendFreshProfile(added.registry,{v2Root:root,accountKey:'next',origin:'https://next.example',expectedIdentity:'2',provider:'Password'});
  assert.equal(reused.reused,true);assert.equal(reused.registry.profiles.length,2);
  assert.throws(()=>appendFreshProfile(added.registry,{v2Root:root,accountKey:'next',origin:'https://other.example',expectedIdentity:'3'}),/another profile/);
  assert.throws(()=>appendFreshProfile(added.registry,{v2Root:root,accountKey:'duplicate',origin:'https://next.example',expectedIdentity:'2'}),/already registered/);
});
