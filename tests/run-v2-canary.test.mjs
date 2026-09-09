import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runCanary} from '../src/canary-runner.mjs';
import {taskIdentity} from '../src/contracts.mjs';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {getExecution,openExecutionJournal,recordOutcome} from '../src/execution-journal.mjs';

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
  assert.match(source,/assertPlanHash\(task\.planHash/);
});

test('manual canary entrypoint invokes the shared notification outbox',()=>{
  const source=fs.readFileSync(new URL('../scripts/run-v2-canary.mjs',import.meta.url),'utf8');
  assert.match(source,/notify-canary-result\.mjs/);assert.match(source,/report\.output/);
});

function fixture(root,day,responses){
  const page={goto:async()=>({status:()=>200}),evaluate:async()=>responses.shift()};
  const identity=taskIdentity({businessDate:day,logicalSiteKey:'https://fixture.example',accountKey:'acct7'});
  return {task:{executionEnabled:false,preconditions:{profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:true},taskId:identity.taskId,planUnitId:identity.planUnitId,planHash:'a'.repeat(64),businessDate:day,origin:'https://fixture.example',accountKey:'acct7',accountId:'7',profileDir:path.join(root,'data','v2-profiles','acct7','chrome-user-data'),adapterId:'new-api.execute.v1',executionOwner:'legacy-checkin',adapterRule:{signInPath:'/api/user/checkin'}},executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}})};
}

test('read-only canary stops at not_signed without a submit',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-read-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}}]);
  const result=await runCanary({...input,root,legacyRoot:path.join(root,'legacy'),execute:false,writeOutput:false});assert.equal(result.stage,'not_signed');assert.equal(result.mutationCount,0);
});

test('canary refuses a missing or all-zero plan hash before opening a browser',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-plan-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  for(const value of [undefined,'0'.repeat(64)]){
    const input=fixture(root,day,[]); input.task.planHash=value;
    await assert.rejects(()=>runCanary({...input,root,legacyRoot:path.join(root,'legacy'),execute:false,writeOutput:false}),/non-zero SHA-256 hash/);
  }
});

test('execute canary persists intent and completes one-account V1 handoff',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-write-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},{status:200,body:{success:true,message:'签到成功'}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}},{status:200,storageIds:['7'],body:{success:true,data:{id:7}}}]);
  const legacyRoot=path.join(root,'legacy'),result=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false});
  assert.equal(result.stage,'succeeded');assert.equal(result.mutationCount,1);const handoff=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),'utf8'));assert.equal(handoff.accounts[0].state,'v2_owned');
});

test('post-mutation outcome persistence failure is quarantined and keeps V1 handoff paused',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-unknown-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},{status:200,body:{success:true,message:'签到成功'}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}},{status:200,storageIds:['7'],body:{success:true,data:{id:7}}}]);
  const legacyRoot=path.join(root,'legacy');let calls=0;
  const journalFile=path.join(root,'data','v2-execution.sqlite');
  const result=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false,recordOutcomeFn:(db,args)=>{calls++;if(calls===1)throw Error('simulated persistence outage');return recordOutcome(db,args);}});
  assert.equal(result.stage,'submission_unknown');assert.equal(result.phase,'submission_unknown');assert.equal(result.mutationCount,1);assert.equal(result.handoffPending,true);
  const handoff=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),'utf8'));assert.equal(handoff.accounts[0].state,'pending_v2');assert.equal(handoff.accounts[0].expiresAt,null);assert.equal(handoff.accounts[0].quarantine.state,'submission_unknown');
  const db=openExecutionJournal(journalFile,legacyRoot);const key=idempotencyKey({taskId:input.task.taskId,businessDate:day});assert.equal(getExecution(db,key).phase,'submission_unknown');db.close();
});

test('browser failure after a durable intent is quarantined without restoring V1 ownership',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-browser-close-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},{status:200,body:{success:true,message:'签到成功'}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}},{status:200,storageIds:['7'],body:{success:true,data:{id:7}}}]);
  const launch=input.launchPersistentContext;input.launchPersistentContext=async()=>{const context=await launch();return {...context,close:async()=>{throw Error('simulated browser close failure');}};};
  const legacyRoot=path.join(root,'legacy'),result=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false});
  assert.equal(result.stage,'submission_unknown');assert.equal(result.mutationCount,1);assert.equal(result.handoffPending,true);
  const handoff=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),'utf8'));assert.equal(handoff.accounts[0].state,'pending_v2');
});

test('duplicate canary result returns the recorded completion time and does not open a browser',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-duplicate-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:false,records:[]}}}},{status:200,body:{success:true,message:'签到成功'}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}},{status:200,storageIds:['7'],body:{success:true,data:{id:7}}}]);
  const legacyRoot=path.join(root,'legacy');const first=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false});
  const handoffFile=path.join(legacyRoot,'data','v2-account-handoff.json'),handoff=JSON.parse(fs.readFileSync(handoffFile,'utf8'));handoff.accounts[0].state='pending_v2';delete handoff.accounts[0].completedAt;fs.writeFileSync(handoffFile,JSON.stringify(handoff));
  const duplicate=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false,launchPersistentContext:async()=>{throw Error('duplicate must not launch browser');}});
  assert.equal(first.stage,'succeeded');assert.equal(duplicate.duplicate,true);assert.equal(duplicate.stage,'succeeded');assert.equal(duplicate.mutationCount,1);assert.equal(typeof duplicate.completedAt,'string');
  assert.equal(duplicate.handoffPending,false);assert.equal(JSON.parse(fs.readFileSync(handoffFile,'utf8')).accounts[0].state,'v2_owned');
});

test('active V2 ownership is preserved when the next day is already signed',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-active-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),legacyRoot=path.join(root,'legacy');
  fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});fs.writeFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),JSON.stringify({schemaVersion:1,accounts:[{accountKey:'acct7',origin:'https://fixture.example',state:'v2_owned',expiresAt:null}]}));
  const input=fixture(root,day,[{status:200,storageIds:['7'],body:{success:true,data:{id:7}}},{status:200,body:{success:true,data:{stats:{checked_in_today:true,records:[{checkin_date:day,user_id:7,quota_awarded:1}]}}}},{status:200,storageIds:['7'],body:{success:true,data:{id:7}}}]);input.task.ownershipState='active';input.task.executionOwner='v2-worker';input.task.preconditions={profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:false,firstMutationNotPerformed:false};
  const result=await runCanary({...input,root,legacyRoot,execute:true,writeOutput:false});assert.equal(result.stage,'already_done');assert.equal(result.mutationCount,0);assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),'utf8')).accounts[0].state,'v2_owned');
});

test('active V2 execution refuses a missing ownership marker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-active-missing-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),legacyRoot=path.join(root,'legacy');
  const input=fixture(root,day,[]);input.task.ownershipState='active';input.task.executionOwner='v2-worker';input.task.preconditions={profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:false,firstMutationNotPerformed:false};
  await assert.rejects(()=>runCanary({...input,root,legacyRoot,execute:true,writeOutput:false}),/active V2 handoff is missing/);
});

test('active V2 execution refuses an expiring ownership marker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-active-expiry-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),legacyRoot=path.join(root,'legacy');fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
  fs.writeFileSync(path.join(legacyRoot,'data','v2-account-handoff.json'),JSON.stringify({schemaVersion:1,accounts:[{accountKey:'acct7',origin:'https://fixture.example',state:'v2_owned',expiresAt:'2026-09-10T00:00:00.000Z'}]}));
  const input=fixture(root,day,[]);input.task.ownershipState='active';input.task.executionOwner='v2-worker';input.task.preconditions={profileReady:true,identityVerified:true,v1MustBeStoppedBeforeMutation:false,firstMutationNotPerformed:false};
  await assert.rejects(()=>runCanary({...input,root,legacyRoot,execute:true,writeOutput:false}),/active V2 handoff is missing/);
});

test('Canary releases its global lock when the execution journal cannot open',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'canary-lock-release-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date()),legacyRoot=path.join(root,'legacy'),badJournal=path.join(root,'data','journal-directory');
  fs.mkdirSync(badJournal,{recursive:true});const input=fixture(root,day,[]),previous=process.env.CHECKIN_EXECUTION_JOURNAL;process.env.CHECKIN_EXECUTION_JOURNAL=badJournal;
  try { await assert.rejects(()=>runCanary({...input,root,legacyRoot,execute:true,writeOutput:false}));assert.equal(fs.existsSync(path.join(root,'data','v2-run.lock')),false); }
  finally { if(previous===undefined)delete process.env.CHECKIN_EXECUTION_JOURNAL;else process.env.CHECKIN_EXECUTION_JOURNAL=previous; }
});
