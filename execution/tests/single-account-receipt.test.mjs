import test from 'node:test';
import assert from 'node:assert/strict';
import {resultForPlanTarget,resultIdentity,compatiblePriorResult} from '../src/result-identity.mjs';
import {completedNativeRecovery} from '../src/native-preflight-receipt.mjs';

test('a bound native completion replaces an origin-only failure when a daily resume is assembled',()=>{
  const target={origin:'https://pt.example',profileBinding:'a'.repeat(64)};
  const prior={origin:target.origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true};
  const receipt={origin:target.origin,accountKey:'site-default',profileBinding:target.profileBinding,status:'signed',submissionAttempted:false,
    evidence:{source:'page_text',authoritative:true,confirmedAt:'2026-10-11T05:00:00Z',businessDate:'2026-10-11'}};
  const recovered=completedNativeRecovery(target,prior,new Map([[target.origin,receipt]]));
  const current=resultForPlanTarget(target,recovered);
  const merged=new Map([[resultIdentity(current),current]]).get(resultIdentity(target))??compatiblePriorResult(target,[prior]);
  assert.equal(merged.status,'signed');assert.equal(merged.profileBinding,target.profileBinding);
  assert.equal(merged.evidence,receipt.evidence);assert.equal(merged.accountKey,undefined);
  assert.equal(resultIdentity(current),resultIdentity(target));
});

test('plan receipt normalization preserves named and supplemental account identities and mismatches',()=>{
  const origin='https://pt.example';
  for(const [target,result] of [
    [{origin},{origin,accountKey:'secondary',status:'signed'}],
    [{origin,accountKey:'primary'},{origin,accountKey:'site-default',status:'signed'}],
    [{origin,accountKey:'site-default'},{origin,accountKey:'site-default',status:'signed'}],
  ])assert.equal(resultForPlanTarget(target,result),result);
  assert.equal(compatiblePriorResult({origin,accountKey:'primary',accountId:'1'},
    [{origin,accountKey:'primary',accountId:'2',status:'signed'}]),null);
});
