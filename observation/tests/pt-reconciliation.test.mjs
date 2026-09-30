import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reconcilePtAttempt,listPtAttempts} from '../src/pt-reconciliation.mjs';
import {pendingHarvestFallbackAttempts} from '../src/harvest-fallback.mjs';
test('passive reconciliation keeps original unknown attempt and unblocks only subsequent days',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-reconcile-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'outputs'));
  const origin='https://pt.example',businessDate='2026-09-29',attemptId='fixture-attempt',profileBinding='a'.repeat(64);
  const attempt={attemptId,origin,businessDate,accountKey:'site-default',profileBinding,startedAt:'2026-09-29T01:00:00Z',state:'outcome_unknown'};
  const file=path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,businessDate,attempts:[attempt]}));
  const next={origin,accountKey:'site-default',businessDate:'2026-09-30'};
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate:next.businessDate,eligible:[next]}).length,0);
  const receipt={origin,accountKey:'site-default',profileBinding,businessDate,observedAt:'2026-09-29T02:00:00Z',status:'already_signed',
    operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:'2026-09-29T02:00:00Z'}};
  const args={root,businessDate,attemptId,receipt,now:new Date('2026-09-30T02:00:00Z')};
  for(const invalid of [{...receipt,profileBinding:'b'.repeat(64)},{...receipt,submissionAttempted:true},
    {...receipt,observedAt:'2026-09-30T02:00:00Z'},{...receipt,accountKey:'second'}])
    assert.throws(()=>reconcilePtAttempt({...args,receipt:invalid}),/does not prove/);
  assert.equal(reconcilePtAttempt(args).kind,'confirmed_external');reconcilePtAttempt(args);
  const state=JSON.parse(fs.readFileSync(file,'utf8'));assert.deepEqual(state.attempts,[attempt]);assert.equal(state.reconciliations.length,1);
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate:next.businessDate,eligible:[next]}).length,1);
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate,eligible:[{...next,businessDate}]}).length,0);
});

test('legacy manual closure requires explicit review and cannot label unknown work signed',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-manual-close-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'outputs'));
  const businessDate='2026-09-29',origin='https://pt.example';
  const attempt={origin,startedAt:'2026-09-29T01:00:00Z',state:'outcome_unknown'};
  const file=path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json');
  fs.writeFileSync(file,JSON.stringify({schemaVersion:1,businessDate,attempts:[attempt]}));
  const attemptId=listPtAttempts(root,businessDate)[0].attemptId;
  const args={root,businessDate,attemptId,kind:'closed_manual',now:new Date('2026-09-30T02:00:00Z')};
  assert.throws(()=>reconcilePtAttempt(args),/explicit operator/);
  assert.throws(()=>reconcilePtAttempt({...args,kind:'confirmed_not_submitted'}),/not proven/);
  const result=reconcilePtAttempt({...args,acknowledgement:'reviewed-this-attempt-no-same-day-replay',note:'Operator reviewed this exact historical attempt.'});
  assert.equal(result.status,'unknown');assert.equal(result.kind,'closed_manual');
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).attempts,[attempt]);
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate,eligible:[{origin,accountKey:'site-default',businessDate}]}).length,0);
  assert.equal(pendingHarvestFallbackAttempts(root,{businessDate:'2026-09-30',eligible:[{origin,accountKey:'site-default',businessDate:'2026-09-30'}]}).length,1);
});

test('non-submission closure accepts an executor refusal, never an unknown submitted result',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-not-submitted-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'outputs'));
  const businessDate='2026-09-29',attemptId='fixture-refusal';
  const attempt={attemptId,origin:'https://pt.example',state:'completed',submissionState:'not_submitted',outcome:{submissionAttempted:false}};
  fs.writeFileSync(path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json'),JSON.stringify({businessDate,attempts:[attempt]}));
  assert.equal(reconcilePtAttempt({root,businessDate,attemptId,kind:'confirmed_not_submitted'}).status,'unknown');
});
