import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildCanaryTask} from '../src/canary-task.mjs';
import {runCanary} from '../src/canary-runner.mjs';
import {taskIdentity} from '../src/contracts.mjs';

test('canary dispatches a non-New-API adapter through the shared runner',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-agent-')),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.writeFileSync(path.join(root,'config','runtime.local.json'),'{"executionEngine":"v2"}');
  const profileDir=path.join(root,'data','v2-profiles','agentrouter-700001','agentrouter.org-profile');fs.mkdirSync(profileDir,{recursive:true});
  const created=Math.floor((Date.parse(`${day}T02:00:00+08:00`))/1000);
  const responses=[
    {status:200,storageIds:['700001'],body:{success:true,data:{id:700001,username:'linuxdo_700001'}}},
    {status:200,body:{success:true,data:{items:[{type:4,user_id:700001,created_at:created,content:'每日签到成功，增加额度 ＄25.000000 额度'}]}}}
  ];
  const page={url:()=> 'https://agentrouter.org',goto:async()=>({status:()=>200}),evaluate:async()=>responses.shift()};
  const identity=taskIdentity({businessDate:day,logicalSiteKey:'https://agentrouter.org',accountKey:'agentrouter-700001',actionType:'checkin',scheduleOccurrence:'daily'});
  const task=buildCanaryTask({profile:{...{accountKey:'agentrouter-700001',origin:'https://agentrouter.org',state:'ready',identity:'700001',expectedIdentity:'700001',profileDir},},businessDate:day,planHash:'a'.repeat(64),adapterId:'oauth-reward.execute.v1',adapterRule:{logType:4,rewardAmount:25},ownershipState:'candidate'});
  assert.equal(task.taskId,identity.taskId);
  const result=await runCanary({task,root,legacyRoot:path.join(root,'legacy'),execute:false,writeOutput:false,executablePath:path.join(root,'chrome.exe'),launchPersistentContext:async()=>({pages:()=>[page],close:async()=>{}})});
  assert.equal(result.stage,'already_done');
  assert.equal(result.mutationCount,0);
  assert.equal(result.evidence.authoritative,true);
});
