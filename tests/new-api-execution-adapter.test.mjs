import test from 'node:test';
import assert from 'node:assert/strict';
import {createNewApiExecutionAdapter} from '../src/new-api-execution-adapter.mjs';

function fakePage(responses) {
  const calls=[];
  return {calls, page:{evaluate:async (_fn,args)=>{calls.push(args); return responses.shift();}}};
}

test('New API execution adapter submits once and verifies dated status', async () => {
  const fake=fakePage([
    {status:200,body:{success:true,data:{id:7,username:'reader'}}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},
    {status:200,body:{success:true,message:'签到成功，获得 $25'}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-09',user_id:7,quota_awarded:25}]}}}}
  ]);
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example',rule:{rewardAmount:25}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  const before=await adapter.methods.read_status({identity,businessDate:'2026-09-09',context:fake});
  const submitted=await adapter.methods.submit_once({identity,context:fake});
  const after=await adapter.methods.verify({identity,businessDate:'2026-09-09',context:fake});
  assert.equal(identity.userId,'7'); assert.equal(before.state,'not_signed'); assert.equal(submitted.state,'accepted');
  assert.equal(after.state,'confirmed'); assert.equal(adapter.mutating,true); assert.equal(fake.calls.length,4);
});

test('New API execution adapter rejects a mismatched identity before submit', async () => {
  const fake=fakePage([{status:200,body:{success:true,data:{id:8}}}]);
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'});
  assert.equal(await adapter.methods.identity({expectedIdentity:'7',context:fake}),null);
  assert.equal(fake.calls.length,1);
});
