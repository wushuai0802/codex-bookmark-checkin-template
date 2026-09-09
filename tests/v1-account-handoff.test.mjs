import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beginV2AccountHandoff,completeV2AccountHandoff,rollbackV2AccountHandoff} from '../src/v1-account-handoff.mjs';

test('V2 handoff controls one V1 account and supports rollback',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-account-handoff-')),pending=beginV2AccountHandoff({v1Root:root,accountKey:'acct7',origin:'https://fixture.example',now:'2026-09-09T00:00:00Z'});
  assert.equal(pending.state,'pending_v2'); assert.equal(completeV2AccountHandoff({v1Root:root,accountKey:'acct7',now:'2026-09-09T00:01:00Z'}).state,'v2_owned');
  assert.equal(rollbackV2AccountHandoff({v1Root:root,accountKey:'acct7'}).state,'legacy-checkin');
});

test('active V1 lock refuses handoff',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-account-handoff-'));fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp','run.lock'),'active');
  assert.throws(()=>beginV2AccountHandoff({v1Root:root,accountKey:'acct7',origin:'https://fixture.example'}),/lock is active/);
});
