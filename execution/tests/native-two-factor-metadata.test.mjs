import assert from 'node:assert/strict';
import test from 'node:test';
import {safeNativeTwoFactorRecovery,nativeUnconfirmedSubmission,nativePreflightFailure} from '../src/native-preflight-result.mjs';

test('vault unlock failures retain submitted uncertainty and expose one specific local action',()=>{
  const recovery={attempted:false,accepted:false,reason:'provider_vault_locked',code:'PRIVATE_CODE'};
  const result=nativeUnconfirmedSubmission({status:'needs_attention',failureCode:'submission_outcome_unknown',
    underlyingFailureCode:'two_factor_required',submissionAttempted:true,nativeTwoFactorRecovery:recovery});
  assert.equal(result.submissionAttempted,true);assert.equal(result.failureCode,'submission_outcome_unknown');
  assert.equal(result.underlyingFailureCode,'two_factor_required');assert.match(result.reason,/Bitwarden/);
  assert.deepEqual(result.nativeTwoFactorRecovery,{attempted:false,accepted:false,reason:'provider_vault_locked'});
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_CODE/);
  assert.match(nativePreflightFailure({failureCode:'two_factor_required',nativeTwoFactorRecovery:recovery}).reason,/Bitwarden/);
});

test('metadata projection rejects secret-bearing reasons and non-boolean claims',()=>{
  for(const value of [{attempted:'true',accepted:false,reason:'provider_vault_locked'},
    {attempted:false,accepted:false,reason:'private_password'},
    {attempted:false,accepted:true,reason:'PRIVATE_SEED'}])assert.equal(safeNativeTwoFactorRecovery(value),null);
  const value=safeNativeTwoFactorRecovery({attempted:true,accepted:true,reason:'authentication_accepted',session:'PRIVATE_SESSION'});
  assert.deepEqual(value,{attempted:true,accepted:true,reason:'authentication_accepted'});
});
