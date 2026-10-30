import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayError} from '../src/gateway-error.mjs';
test('gateway diagnostics allow only fixed codes and stages, never raw exception data',()=>{
  assert.deepEqual(gatewayError({code:'PT_CLEANUP_PENDING',gatewayStage:'pt_cleanup',message:'PRIVATE_FIXTURE_DETAIL'}),
    {code:'PT_CLEANUP_PENDING',stage:'pt_cleanup'});
  const result=gatewayError({code:'PRIVATE_FIXTURE_DETAIL',gatewayStage:'PRIVATE_FIXTURE_DETAIL',message:'PRIVATE_FIXTURE_DETAIL'});
  assert.deepEqual(result,{code:'GATEWAY_CONTROLLER_FAILED',stage:'controller'});
});
