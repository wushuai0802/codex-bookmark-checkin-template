import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterBindingForSite,createExecutionAdapter,executionAdapterDefinitions} from '../src/execution-adapter-registry.mjs';

test('execution registry exposes implemented and planned families explicitly',()=>{
  const defs=executionAdapterDefinitions(); assert.equal(defs.find(x=>x.id==='new-api.execute.v1').status,'implemented');
  assert.equal(defs.find(x=>x.id==='oauth-reward.execute.v1').status,'planned');
  assert.equal(adapterBindingForSite({origin:'https://fixture.example',familyId:'new-api-calendar.v1'}).adapterId,'new-api.execute.v1');
});

test('only implemented execution adapters can be constructed',()=>{
  assert.equal(createExecutionAdapter({adapterId:'new-api.execute.v1',origin:'https://fixture.example'}).mutating,true);
  assert.throws(()=>createExecutionAdapter({adapterId:'oauth-reward.execute.v1',origin:'https://fixture.example'}),/unavailable/);
});
