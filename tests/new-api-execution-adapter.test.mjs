import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createNewApiExecutionAdapter} from '../src/new-api-execution-adapter.mjs';

function fakePage(responses) {
  const calls=[];
  return {calls, page:{evaluate:async (_fn,args)=>{calls.push(args); return responses.shift();}}};
}

test('New API execution adapter submits once and verifies dated status', async () => {
  const fake=fakePage([
    {status:200,storageIds:['7'],body:{success:true,data:{id:7,username:'reader'}}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},
    {status:200,body:{success:true,message:'签到成功，获得 $25'}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-09',user_id:7,quota_awarded:25}]}}}},
    {status:200,storageIds:['7'],body:{success:true,data:{id:7,username:'reader'}}}
  ]);
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example',rule:{rewardAmount:25}});
  const identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
  const before=await adapter.methods.read_status({identity,businessDate:'2026-09-09',context:fake});
  const submitted=await adapter.methods.submit_once({identity,context:fake});
  const after=await adapter.methods.verify({identity,businessDate:'2026-09-09',context:fake});
  assert.equal(identity.userId,'7'); assert.equal(before.state,'not_signed'); assert.equal(submitted.state,'accepted');
  assert.equal(after.state,'confirmed'); assert.equal(adapter.mutating,true); assert.equal(fake.calls.length,5); assert.equal(fake.calls[2].path,'/api/user/checkin');
});

test('New API execution adapter rejects a mismatched identity before submit', async () => {
  const fake=fakePage([{status:200,body:{success:true,data:{id:8}}}]);
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'});
  assert.equal(await adapter.methods.identity({expectedIdentity:'7',context:fake}),null);
  assert.equal(fake.calls.length,1);
});

test('New API adapter marks a transport failure unknown instead of safe to replay',async()=>{
  const page={evaluate:async()=>{throw Error('network timeout')}};
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'});
  const result=await adapter.methods.submit_once({identity:{userId:'7'},context:{page}});
  assert.equal(result.state,'unknown'); assert.equal(result.actionMayHaveHappened,true);
});

test('New API adapter only accepts a real non-negative quota award',async()=>{
  const invalid=[false,'',[],{},' 25','01','1e2',-1,'-1'];
  for(const quota_awarded of invalid){
    const fake=fakePage([{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-09',user_id:7,quota_awarded}]}}}}]);
    const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'}),identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
    const result=await adapter.methods.read_status({identity,businessDate:'2026-09-09',context:fake});
    assert.equal(result.state,'unknown',String(quota_awarded));
  }
  for(const quota_awarded of [0,25,0.5,'0','25.5']){
    const fake=fakePage([{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-09',user_id:7,quota_awarded}]}}}}]);
    const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'}),identity=await adapter.methods.identity({expectedIdentity:'7',context:fake});
    const result=await adapter.methods.read_status({identity,businessDate:'2026-09-09',context:fake});
    assert.equal(result.state,'already_done',String(quota_awarded));
  }
});

test('New API adapter bounds requests and rejects cross-origin responses',async()=>{
  const source=fs.readFileSync(new URL('../src/new-api-execution-adapter.mjs',import.meta.url),'utf8');
  assert.match(source,/AbortController/);assert.match(source,/REQUEST_TIMEOUT_MS=15_000/);assert.match(source,/redirect:'error'/);
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'});
  const status=await adapter.methods.read_status({identity:{userId:'7'},businessDate:'2026-09-09',context:fakePage([{status:200,url:'https://other.example/api/user/checkin',body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}}])});
  const submit=await adapter.methods.submit_once({identity:{userId:'7'},context:fakePage([{status:200,url:'https://other.example/api/user/checkin',body:{success:true}}])});
  assert.equal(status.reason,'cross_origin_redirect');assert.equal(submit.state,'rejected');assert.equal(submit.actionMayHaveHappened,false);
});

test('ambiguous 2xx and 5xx submit responses are quarantined as possibly applied',async()=>{
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'});
  for(const response of [
    {status:201,body:{success:false,message:'验证码校验中'}},
    {status:200,body:{}},
    {status:204,body:null},
    {status:502,body:{success:false}}
  ]){
    const result=await adapter.methods.submit_once({identity:{userId:'7'},context:fakePage([response])});
    assert.equal(result.state,'unknown',JSON.stringify(response));assert.equal(result.actionMayHaveHappened,true,JSON.stringify(response));
  }
});

test('verify retries bounded calendar lag and then rechecks the same identity',async()=>{
  const adapter=createNewApiExecutionAdapter({origin:'https://fixture.example'}),fake=fakePage([
    {status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},
    {status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:'2026-09-09',user_id:7,quota_awarded:25}]}}}},
    {status:200,storageIds:['7'],body:{success:true,data:{id:7}}}
  ]);
  const result=await adapter.methods.verify({identity:{userId:'7'},businessDate:'2026-09-09',context:fake});
  assert.equal(result.state,'confirmed');assert.equal(fake.calls.length,4);
});
