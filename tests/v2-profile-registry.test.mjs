import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {enrollFreshProfile,markProfileReady} from '../src/v2-profile-registry.mjs';

test('fresh profile enrollment creates a clean V2 path and blocks V1 stop until identity proof',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v2-profile-'));
  const pending=enrollFreshProfile({v2Root:root,accountKey:'acct7',origin:'https://fixture.example',expectedIdentity:'7',provider:'LinuxDO'});
  assert.equal(pending.state,'pending_login'); assert.equal(pending.v1TaskStopEligible,false); assert.ok(fs.existsSync(pending.profileDir));
  const ready=markProfileReady(pending,{identity:'7',username:'reader'});
  assert.equal(ready.state,'ready'); assert.equal(ready.v1TaskStopEligible,true);
  assert.throws(()=>markProfileReady(pending,{identity:'8'}),/mismatch/);
});
