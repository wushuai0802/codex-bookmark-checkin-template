import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {adoptOperatorConfirmedCheckin,cancelReservation,getExecution,getExecutionAdoption,getExecutionReconciliation,getExecutionRecovery,openExecutionJournal,reconcileUnknownExecution,recordOutcome,recordPrepared,recoverExecutionForRetry,reserveExecution} from '../src/execution-journal.mjs';
import {reconcileBlockedCompletion} from '../src/execution-journal.mjs';

test('blocked execution reconciles only with fresh exact account/day evidence and keeps original failure',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'blocked-completion-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_confirm',taskId:'task_confirm',planHash:'a'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-18'};
  reserveExecution(db,args);recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'blocked',outcome:{mutationCount:0,reason:'identity_missing'},now:'2026-09-18T00:00:00Z'});
  const proof={...args,authoritative:true,stage:'already_done',observedAt:'2026-09-18T01:00:00Z',evidence:{authoritative:true,source:'oauth_reward_log',accountId:'7',businessDate:args.businessDate}},options={...args,expectedIdentity:'7',proof,now:'2026-09-18T01:01:00Z'};
  assert.throws(()=>reconcileBlockedCompletion(db,{...options,expectedIdentity:'8'}),/account-bound/);
  assert.throws(()=>reconcileBlockedCompletion(db,{...options,now:'2026-09-18T02:00:00Z'}),/stale/);
  assert.throws(()=>reconcileBlockedCompletion(db,{...options,proof:{...proof,taskId:'wrong'}}),/binding/);
  assert.equal(reconcileBlockedCompletion(db,options).stage,'already_done');
  assert.match(getExecutionReconciliation(db,args.idempotencyKey).previous_outcome_json,/identity_missing/);
  assert.equal(JSON.parse(getExecution(db,args.idempotencyKey).outcome_json).mutationCount,0);db.close();
});

test('execution journal reserves once and refuses a second owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_1',taskId:'task_1',planHash:'a'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-09'};
  assert.equal(reserveExecution(db,args).duplicate,false); assert.equal(reserveExecution(db,args).state,'reserved');
  recordPrepared(db,{idempotencyKey:'idem_1',taskId:'task_1'}); recordOutcome(db,{idempotencyKey:'idem_1',phase:'submission_unknown',outcome:{reason:'timeout',mutationCount:1}});
  assert.equal(getExecution(db,'idem_1').phase,'submission_unknown'); assert.throws(()=>recordPrepared(db,{idempotencyKey:'idem_1'}),/not reserved/); db.close();
});

test('execution journal rejects an idempotency-key binding conflict',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_conflict',taskId:'task_1',planHash:'a'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-09'};
  reserveExecution(db,args);assert.throws(()=>reserveExecution(db,{...args,accountKey:'acct8'}),/binding conflict/);db.close();
});

test('execution journal cannot promote an unprepared or unverified task to success',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_forge',taskId:'task_1',planHash:'a'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-09'};reserveExecution(db,args);
  assert.throws(()=>recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'succeeded',outcome:{mutationCount:1,evidence:{authoritative:true}}}),/phase conflict/);
  recordPrepared(db,{idempotencyKey:args.idempotencyKey,taskId:args.taskId});assert.throws(()=>recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'succeeded',outcome:{mutationCount:1,evidence:{authoritative:false}}}),/not authoritative/);db.close();
});

test('execution journal keeps intent and outcome fields bounded',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_2',taskId:'task_2',planHash:'b'.repeat(64),accountKey:'acct8',origin:'https://fixture.example',businessDate:'2026-09-09'};
  reserveExecution(db,args); recordPrepared(db,{idempotencyKey:'idem_2',taskId:'task_2',mutationAllowed:true});
  recordOutcome(db,{idempotencyKey:'idem_2',phase:'blocked',outcome:{reason:'challenge_required'}});
  const row=getExecution(db,'idem_2'); assert.equal(row.phase,'blocked'); assert.match(row.intent_json,/task_2/); db.close();
});

test('reserved execution can be cancelled before any browser mutation',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  reserveExecution(db,{idempotencyKey:'idem_cancel',taskId:'task_cancel',planHash:'c'.repeat(64),accountKey:'acct',origin:'https://fixture.example',businessDate:'2026-09-09'});
  assert.equal(cancelReservation(db,'idem_cancel'),true);assert.equal(getExecution(db,'idem_cancel'),null);db.close();
});

test('execution journal refuses a sentinel plan hash',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  assert.throws(()=>reserveExecution(db,{idempotencyKey:'idem_zero',taskId:'task_zero',planHash:'0'.repeat(64),accountKey:'acct',origin:'https://fixture.example',businessDate:'2026-09-09'}),/non-zero SHA-256 hash/);db.close();
});

test('one authoritative not-signed proof can reopen a failed execution without deleting its audit',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-recovery-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_recover',taskId:'task_recover',planHash:'d'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-16',now:'2026-09-16T00:00:00Z'};
  reserveExecution(db,args);recordPrepared(db,{idempotencyKey:args.idempotencyKey,taskId:args.taskId},'2026-09-16T00:00:01Z');recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'submit_rejected',outcome:{reason:'client_defect',mutationCount:0},now:'2026-09-16T00:00:02Z'});
  const proof={authoritative:true,stage:'not_signed',kind:'durable_non_mutating_failure',source:'execution_journal',taskId:args.taskId,accountKey:args.accountKey,origin:args.origin,businessDate:args.businessDate,observedAt:'2026-09-16T00:01:00Z'};
  assert.equal(recoverExecutionForRetry(db,{...args,proof,now:'2026-09-16T00:01:01Z'}).recovered,true);
  assert.equal(reserveExecution(db,args).recovered,true);assert.equal(getExecutionRecovery(db,args.idempotencyKey).previous_phase,'submit_rejected');
  assert.throws(()=>recoverExecutionForRetry(db,{...args,proof,now:'2026-09-16T00:01:02Z'}),/not recoverable|already used/);db.close();
});

test('uncertain execution cannot reopen without fresh matching authoritative proof',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-recovery-proof-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_unknown',taskId:'task_unknown',planHash:'e'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-16',now:'2026-09-16T00:00:00Z'};
  reserveExecution(db,args);recordPrepared(db,{idempotencyKey:args.idempotencyKey,taskId:args.taskId},'2026-09-16T00:00:01Z');recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'submission_unknown',outcome:{reason:'transport',mutationCount:1},now:'2026-09-16T00:00:02Z'});
  const proof={authoritative:true,stage:'not_signed',kind:'authoritative_not_signed',source:'new_api_checkin_calendar',taskId:args.taskId,accountKey:args.accountKey,origin:args.origin,businessDate:args.businessDate,observedAt:'2026-09-16T00:01:00Z'};
  assert.throws(()=>recoverExecutionForRetry(db,{...args,proof:{...proof,accountKey:'other'}}),/proof mismatch/);
  assert.equal(recoverExecutionForRetry(db,{...args,proof,now:'2026-09-16T00:01:01Z'}).previousPhase,'submission_unknown');db.close();
});

test('unknown submission reconciles to success only from a fresh account-bound completion',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-reconcile-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_reconcile',taskId:'task_reconcile',planHash:'f'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-16',now:'2026-09-16T00:00:00Z'};
  reserveExecution(db,args);recordPrepared(db,{idempotencyKey:args.idempotencyKey,taskId:args.taskId},'2026-09-16T00:00:01Z');recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'submission_unknown',outcome:{reason:'verification_blocked',mutationCount:1},now:'2026-09-16T00:00:02Z'});
  const proof={authoritative:true,stage:'already_done',taskId:args.taskId,accountKey:args.accountKey,origin:args.origin,businessDate:args.businessDate,observedAt:'2026-09-16T00:01:00Z',evidence:{source:'oauth_reward_log',authoritative:true}};
  assert.throws(()=>reconcileUnknownExecution(db,{...args,proof:{...proof,accountKey:'other'}}),/proof mismatch/);
  assert.equal(reconcileUnknownExecution(db,{...args,proof,now:'2026-09-16T00:01:01Z'}).state,'succeeded');assert.equal(getExecution(db,args.idempotencyKey).phase,'succeeded');assert.ok(getExecutionReconciliation(db,args.idempotencyKey));db.close();
});

test('operator-confirmed V2 login can adopt an authoritative already-done result with audit',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-adoption-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_adopt',taskId:'task_adopt',planHash:'1'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-16',now:'2026-09-16T00:00:00Z'};
  reserveExecution(db,args);recordOutcome(db,{idempotencyKey:args.idempotencyKey,phase:'already_done',outcome:{mutationCount:0,evidence:{authoritative:true,source:'oauth_reward_log'}},now:'2026-09-16T00:00:02Z'});
  const proof={authoritative:true,stage:'already_done',taskId:args.taskId,accountKey:args.accountKey,origin:args.origin,businessDate:args.businessDate,observedAt:'2026-09-16T00:01:00Z',evidence:{authoritative:true,source:'oauth_reward_log'}};
  assert.equal(adoptOperatorConfirmedCheckin(db,{...args,proof,operatorConfirmed:true,now:'2026-09-16T00:01:01Z'}).adopted,true);assert.equal(getExecution(db,args.idempotencyKey).phase,'succeeded');assert.ok(getExecutionAdoption(db,args.idempotencyKey));db.close();
});
