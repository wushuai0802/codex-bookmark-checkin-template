import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {guardPtSubmission,knownPtDialogOpener} from '../src/pt-submission-guard.mjs';
import {advanceDeferredRetry} from '../src/retry-policy.mjs';
import {checkHarvestPtBeforeWrite} from '../src/harvest-pt-gate.mjs';

test('gate closes after OCR preparation without submitting',async()=>{
  let submissions=0;
  const result=await guardPtSubmission(async before=>{before();submissions++;},()=>({status:'deferred',submissionAttempted:false}));
  assert.equal(submissions,0);assert.equal(result.status,'deferred');assert.equal(result.submissionAttempted,false);
});
test('OpenCD dialog opening is not counted as a CAPTCHA submission',async()=>{
  assert.equal(knownPtDialogOpener('https://open.cd',{text:'[签到]'}),true);
  assert.equal(knownPtDialogOpener('https://open.cd',{text:'提交'}),false);
  assert.equal(knownPtDialogOpener('https://other.example',{text:'签到'}),false);
  const result=await guardPtSubmission(async before=>{
    if(!knownPtDialogOpener('https://open.cd',{text:'签到'}))before();
    return {status:'interactive_challenge',reason:'OCR needs review'};
  },()=>null);
  assert.equal(result.status,'interactive_challenge');assert.notEqual(result.submissionAttempted,true);
});
test('post-submit failure and a late gate closure stay unknown, never retryable',async()=>{
  for(const fail of [()=>{throw Error('connection lost');},()=>({status:'interactive_challenge'})]){
    const result=await guardPtSubmission(async before=>{before();return fail();},()=>null);
    assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.retryable,false);
  }
  let checks=0;
  const result=await guardPtSubmission(async before=>{before();before();},()=>++checks===1?null:{status:'deferred',submissionAttempted:false});
  assert.equal(result.submissionAttempted,true);assert.equal(result.failureCode,'submission_outcome_unknown');
});
test('signed receipts survive submission bookkeeping unchanged',async()=>{
  const evidence={source:'pt_page',authoritative:true};
  const result=await guardPtSubmission(async before=>{before();return {status:'signed',evidence};},()=>null);
  assert.equal(result.status,'signed');assert.equal(result.evidence,evidence);assert.equal(result.submissionAttempted,true);
});
test('Harvest waiting does not consume site submission retry budget',()=>{
  const now=new Date('2026-09-30T02:00:00Z');
  const value={status:'deferred',retryCause:'harvest_waiting',submissionAttempted:false};
  assert.equal(advanceDeferredRetry(value,{...value,retrySequence:6,retrySequenceDate:'20260930'},{},now).retrySequence,0);
});
test('fallback-only PT gate accepts an opted-in binding but blocks ambiguous owners',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-fallback-gate-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'config'));
  const target={origin:'https://pt.example',accountKey:'site-default',ptSupplement:true,folderNames:['PT补签']};
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin:target.origin}]}));
  const planFile=path.join(root,'data/last-valid-bookmark-plan.json');fs.writeFileSync(planFile,JSON.stringify({targets:[]}));
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root,harvestPtGate:{enabled:true,catalogFile,sshTarget:'fixture',database:'/volume3/docker/harvest/db.sqlite'}}));
  const runtimeFile=path.join(root,'config/runtime.local.json');
  const now=new Date('2026-09-30T02:00:00Z');let calls=0;
  const probe=()=>{calls++;return {schemaVersion:1,source:'harvest',businessDate:'2026-09-30',generatedAt:now.toISOString(),
    taskCompletion:{resultId:3,status:'completed',startedAt:'2026-09-30T01:00:00Z',completedAt:'2026-09-30T01:30:00Z'},sites:[]};};
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}).status,'deferred');assert.equal(calls,0);
  fs.writeFileSync(runtimeFile,JSON.stringify({executionEngine:'v1',legacyRoot:root,ptFallbackOnlyEnabled:true}));
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}),null);assert.equal(calls,1);
  fs.writeFileSync(planFile,JSON.stringify({targets:[target,{...target,accountKey:'other'}]}));
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}).status,'deferred');assert.equal(calls,1);
});
test('a two-factor gate after possible submission retains its cause without authorizing replay',async()=>{
  const result=await guardPtSubmission(async before=>{before();return {status:'needs_attention',failureCode:'two_factor_required'};},()=>null);
  assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.underlyingFailureCode,'two_factor_required');
  assert.equal(result.submissionAttempted,true);assert.equal(result.retryable,false);
});
