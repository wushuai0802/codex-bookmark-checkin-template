import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getExecution,openExecutionJournal,recordOutcome,recordPrepared,reserveExecution} from '../src/execution-journal.mjs';

test('execution journal reserves once and refuses a second owner',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_1',taskId:'task_1',planHash:'a'.repeat(64),accountKey:'acct7',origin:'https://fixture.example',businessDate:'2026-09-09'};
  assert.equal(reserveExecution(db,args).duplicate,false); assert.equal(reserveExecution(db,args).state,'reserved');
  recordPrepared(db,{idempotencyKey:'idem_1',taskId:'task_1'}); recordOutcome(db,{idempotencyKey:'idem_1',phase:'submission_unknown',outcome:{reason:'timeout'}});
  assert.equal(getExecution(db,'idem_1').phase,'submission_unknown'); assert.throws(()=>recordPrepared(db,{idempotencyKey:'idem_1'}),/not reserved/); db.close();
});

test('execution journal keeps intent and outcome fields bounded',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'execution-journal-')),db=openExecutionJournal(path.join(root,'state.sqlite'),path.join(root,'legacy'));
  const args={idempotencyKey:'idem_2',taskId:'task_2',planHash:'b'.repeat(64),accountKey:'acct8',origin:'https://fixture.example',businessDate:'2026-09-09'};
  reserveExecution(db,args); recordPrepared(db,{idempotencyKey:'idem_2',taskId:'task_2',mutationAllowed:true});
  recordOutcome(db,{idempotencyKey:'idem_2',phase:'blocked',outcome:{reason:'challenge_required'}});
  const row=getExecution(db,'idem_2'); assert.equal(row.phase,'blocked'); assert.match(row.intent_json,/task_2/); db.close();
});
