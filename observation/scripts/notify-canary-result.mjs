#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {createDelivery,deliverNotification} from '../src/notification-delivery.mjs';
import {loadRuntimeConfig,assertStandaloneV2Enabled} from '../src/runtime-config.mjs';

assertStandaloneV2Enabled(path.resolve('.'));

const run=promisify(execFile);
const resultFile=process.argv[2];
if(!resultFile) throw Error('provide canary result file');
const result=JSON.parse(fs.readFileSync(path.resolve(resultFile),'utf8'));
const readonly=result.mode==='canary_read_only',signed=result.stage==='succeeded',completed=signed||result.stage==='already_done';
const summary=readonly
  ? `V2只读验收：${result.accountKey}；状态 ${result.stage}；未执行提交，V1仍负责签到。`
  : signed
    ? result.reason==='operator_confirmed_v2_login'
      ? `V2接管成功：${result.accountKey}；用户已在V2专用profile完成登录，权威日志确认今日签到，未重复提交。`
      : result.reason==='reconciled_after_submission_unknown'
        ? `V2接管成功：${result.accountKey}；此前提交结果未知，后续权威回读确认今日签到，未重复提交。`
        : `V2签到成功并完成接管：${result.accountKey}；提交次数 ${result.mutationCount}，权威回读已确认。`
    : result.stage==='already_done'
      ? `V2已确认今日签到：${result.accountKey}；未重复提交。`
      : `V2签到未完成：${result.accountKey}；状态 ${result.stage}；原因 ${String(result.reason??'unknown').slice(0,120)}。`;
const receipt={taskId:result.taskId,businessDate:result.businessDate,idempotencyKey:idempotencyKey(result),status:signed?'signed':result.stage==='already_done'?'already_signed':'needs_attention',observedAt:result.completedAt,evidence:{source:'v2_canary',summary,redacted:true}};
const item=createDelivery(receipt),file=path.join('outputs',`notification-${item.dedupeKey}.json`);
fs.mkdirSync(path.dirname(file),{recursive:true});
const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):item;
fs.writeFileSync(file,JSON.stringify(existing,null,2),'utf8');
const delivered=await deliverNotification(existing,{send:async()=>{
  const legacyRoot=loadRuntimeConfig(path.resolve('.')).legacyRoot;
  if(!legacyRoot)throw Error('legacyRoot is required');
  const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8')).notification;
  if(config?.mode!=='command'||!config.executable)throw Error('notification command unavailable');
  await run(config.executable,['checkin-report','--task-id','fabric_v2_canary','--name','V2 Canary 验收','--source','browser-fabric-v2','--status',signed?'success':result.stage==='already_done'?'already_done':'needs_attention','--event-key',item.dedupeKey,'--summary',summary,'--occurred-at',result.completedAt],{windowsHide:true,timeout:60000,maxBuffer:65536});
}});
fs.writeFileSync(file,JSON.stringify(delivered,null,2),'utf8');
console.log(JSON.stringify({state:delivered.state,attempts:delivered.attempts,outboxId:delivered.outboxId},null,2));
if(delivered.state!=='delivered') process.exitCode=2;
