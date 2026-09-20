import test from 'node:test';
import assert from 'node:assert/strict';
import {observeAnyRouter} from '../src/anyrouter-readonly.mjs';

test('AnyRouter readonly adapter is self-contained and never submits',async()=>{
  const r=await observeAnyRouter({expectedId:'180558',request:async()=>({status:200,body:{success:true,data:{id:180558}}})});
  assert.equal(r.status,'unknown'); assert.equal(r.cause,'dynamic_route_contract_pending'); assert.equal(r.mutationCount,0);
});
