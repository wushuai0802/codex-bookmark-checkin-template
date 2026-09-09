import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runCanary} from '../src/canary-runner.mjs';
import {taskIdentity} from '../src/contracts.mjs';

test('canary runner source enforces explicit execute and V1 drain gates',()=>{
  const source=fs.readFileSync(new URL('../src/canary-runner.mjs',import.meta.url),'utf8');
  assert.match(source,/task\.executionEnabled!==false/);
  assert.match(source,/execute&&task\.businessDate/);
  assert.match(source,/windowMode:'offscreen'/);
  assert.match(source,/beginV2AccountHandoff/);
  assert.match(source,/completeV2AccountHandoff/);
  assert.match(source,/rollbackV2AccountHandoff/);
  assert.match(source,/allowMutation:execute/);
  assert.match(source,/v2-execution\.sqlite/);
});

function fixture(root,day,responses){
  const page={goto:async()=>({status:()=>200}),evaluate:async()=>responses.shift()};
  const identity=taskIdentity({businessDate:day,logicalSiteKey:'https://fixture.example',accountKey:'acct7'});
  return {task:{executionEnabled:false,preconditions:{profileReady:true,identityVerified:true},taskId:identity.taskId,planUnitId:identity.planUnitId,planHash:'a'.repeat(64),businessDate:day,origin:'https://fixture.example',accountKey:'acct7',accountId:'7',profileDir:path.join(root,'profiles','acct7'),adapterRule:{signInPath:'/api/user/checkin'}},executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}})};
}

test('read-only canary stops at not_signed without a submit',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-read-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}}]);
  const result=await runCanary({...input,root,legacyRoot:path.join(root,'legacy'),execute:false,writeOutput:false});assert.equal(result.stage,'not_signed');assert.equal(result.mutationCount,0);
});

test('execute canary persists intent and completes one-account V1 handoff',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-write-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},{status:200,body:{success:true,message:'签到成功'}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}}]);
  const legacyRoot=path.join(root,'legacy'),result=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false});
  assert.equal(result.stage,'succeeded');assert.equal(result.mutationCount,1);const handoff=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),'utf8'));assert.equal(handoff.accounts[0].state,'v2_owned');
});
