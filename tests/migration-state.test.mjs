import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promoteMigrationAfterVerifiedSubmission} from '../src/migration-state.mjs';

test('verified V2 submission atomically disables V1 fallback and activates ownership',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'migration-promote-'));fs.mkdirSync(path.join(root,'outputs'));
  const file=path.join(root,'outputs','migration-acct7.json');fs.writeFileSync(file,JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',v1Fallback:{enabled:true,owner:'legacy-checkin'},ownership:{current:'legacy-checkin',next:'v2-worker'},preconditions:{v1TaskMustBeDrained:true,firstMutationNotPerformed:true}}));
  const result=promoteMigrationAfterVerifiedSubmission({root,accountKey:'acct7',origin:'https://fixture.example',completedAt:'2026-09-16T00:05:00Z',stage:'succeeded',mutationCount:1});
  assert.equal(result.state,'active');const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.ownership.current,'v2-worker');assert.equal(saved.v1Fallback.enabled,false);assert.equal(saved.preconditions.firstMutationNotPerformed,false);assert.equal(saved.lastSuccessProvenance,'v2_automated_submission');
  assert.throws(()=>promoteMigrationAfterVerifiedSubmission({root,accountKey:'acct7',origin:'https://fixture.example',completedAt:'2026-09-16T00:05:00Z',stage:'already_done',mutationCount:0}),/verified V2 submission/);
});
