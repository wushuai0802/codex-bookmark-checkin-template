import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {beginV2AccountHandoff,completeV2AccountHandoff,rollbackV2AccountHandoff,assertV1Idle} from '../src/v1-account-handoff.mjs';

test('V2 handoff controls one V1 account and supports rollback',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-account-handoff-')),pending=beginV2AccountHandoff({v1Root:root,accountKey:'acct7',origin:'https://fixture.example',now:'2026-09-09T00:00:00Z'});
  assert.equal(pending.state,'pending_v2');
  const file=path.join(root,'data','v2-account-handoff.json');
  const staged=JSON.parse(fs.readFileSync(file,'utf8'));staged.accounts[0].quarantine={state:'submission_unknown',reason:'prepared'};fs.writeFileSync(file,JSON.stringify(staged));
  assert.equal(completeV2AccountHandoff({v1Root:root,accountKey:'acct7',now:'2026-09-09T00:01:00Z'}).state,'v2_owned');
  const completed=JSON.parse(fs.readFileSync(file,'utf8')).accounts[0];assert.equal(completed.state,'v2_owned');assert.equal('quarantine' in completed,false);
  assert.equal(rollbackV2AccountHandoff({v1Root:root,accountKey:'acct7'}).state,'legacy-checkin');
});

test('active V1 lock refuses handoff',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-account-handoff-'));fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp','run.lock'),'active');
  assert.throws(()=>beginV2AccountHandoff({v1Root:root,accountKey:'acct7',origin:'https://fixture.example'}),/lock is active/);
});

test('dead V1 lock owner does not permanently block a handoff',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-account-handoff-'));fs.mkdirSync(path.join(root,'tmp'),{recursive:true});
  fs.writeFileSync(path.join(root,'tmp','run.lock'),JSON.stringify({version:1,pid:2147483647,nonce:'stale'}));
  const result=beginV2AccountHandoff({v1Root:root,accountKey:'acct7',origin:'https://fixture.example'});
  assert.equal(result.state,'pending_v2');
});

test('completed V1 run supersedes a dead running heartbeat but never a live owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-heartbeat-'));fs.mkdirSync(path.join(root,'data'));
  const stateFile=path.join(root,'data','scheduler-state.json'),pulseFile=path.join(root,'data','scheduler-heartbeat.json');
  const state={phase:'finished',lastAttemptStartedAt:'2026-09-01T00:00:00Z',lastFinishedAt:'2026-09-01T00:01:00Z'};
  fs.writeFileSync(stateFile,JSON.stringify(state));
  for(const [pid,updatedAt,allowed] of [[2147483647,'2026-09-01T00:00:02Z',true],[process.pid,'2026-09-01T00:00:02Z',false],[null,'2026-09-01T00:00:02Z',false],[2147483647,'2026-09-01T00:02:00Z',false]]){
    const pulse=JSON.stringify({phase:'running_checkin',processId:pid,updatedAt});fs.writeFileSync(pulseFile,pulse);
    if(allowed)assert.doesNotThrow(()=>assertV1Idle(root));else assert.throws(()=>assertV1Idle(root),/scheduler is active/);
    assert.equal(fs.readFileSync(pulseFile,'utf8'),pulse);
  }
});

test('unified engine preserves retired handoffs without allowing ownership writes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v1-retired-handoff-'));
  fs.mkdirSync(path.join(root,'data'),{recursive:true});
  const file=path.join(root,'data','v2-account-handoff.json');
  const original=JSON.stringify({schemaVersion:1,accounts:[{accountKey:'acct7',origin:'https://fixture.example',state:'v2_owned',expiresAt:null}]});
  fs.writeFileSync(file,original);
  fs.writeFileSync(path.join(root,'data','v2-integration.json'),JSON.stringify({executionEngine:'v1'}));
  assert.throws(()=>beginV2AccountHandoff({v1Root:root,accountKey:'acct8',origin:'https://fixture.example'}),/retired/);
  assert.throws(()=>rollbackV2AccountHandoff({v1Root:root,accountKey:'acct7'}),/retired/);
  assert.equal(fs.readFileSync(file,'utf8'),original);
});
