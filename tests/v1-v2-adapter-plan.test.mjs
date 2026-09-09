import test from 'node:test';
import assert from 'node:assert/strict';
import {buildV2AdapterPlan} from '../src/v1-v2-adapter-plan.mjs';
import {createNewApiReadonlyAdapter} from '../src/new-api-readonly-adapter.mjs';

test('V1 family catalog maps to one explicit V2 adapter without enabling canary', () => {
  const plan = buildV2AdapterPlan({v1Catalog:{mode:'catalog_only',sites:[
    {origin:'https://api.example',familyId:'new-api-calendar.v1',requiredEvidence:['calendar']},
    {origin:'https://pt.example',familyId:'native-pt.v1',requiredEvidence:['page']}
  ]}});
 assert.equal(plan.sites[0].adapterId,'readonly.new-api.v1');
 assert.equal(plan.sites[0].executionAdapterId,'new-api.execute.v1');
 assert.equal(plan.sites[0].executionStatus,'implemented');
  assert.equal(plan.sites[1].adapterId,'pt-native-readonly.v1');
  assert.ok(plan.sites.every(site => site.canaryReady === false));
});

test('New API adapter performs only identity and dated status GETs', async () => {
  const calls=[];
  const adapter=createNewApiReadonlyAdapter({origin:'https://fixture.example'});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:{request:async(path,options)=>{calls.push([path,options.method]);return {status:200,body:{success:true,data:{id:7,username:'reader',access_token:'secret'}}};}}});
  assert.equal(identity.userId,'7');
  const status=await adapter.methods.read_status({identity,businessDate:'2026-09-09',context:{request:async(path,options)=>{calls.push([path,options.method]);return {status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}};}}});
  assert.equal(status.state,'not_signed'); assert.equal(adapter.mutating,false); assert.deepEqual(calls.map(x=>x[1]),['GET','GET']);
});
