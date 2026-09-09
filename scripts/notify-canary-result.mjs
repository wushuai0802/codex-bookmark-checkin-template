#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {createDelivery,deliverNotification} from '../src/notification-delivery.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

const run=promisify(execFile);
const resultFile=process.argv[2];
if(!resultFile) throw Error('provide canary result file');
const result=JSON.parse(fs.readFileSync(path.resolve(resultFile),'utf8'));
const legacyRoot=loadRuntimeConfig(path.resolve('.')).legacyRoot;
if(!legacyRoot)throw Error('legacyRoot is required');
const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config','config.json'),'utf8')).notification;
if(config?.mode!=='command'||!config.executable) throw Error('notification command unavailable');
const readonly=result.mode==='canary_read_only',signed=result.stage==='succeeded',completed=signed||result.stage==='already_done';
const summary=`V2 ${readonly?'只读验收':'Canary执行'}：${result.accountKey}；状态 ${result.stage}；提交次数 ${result.mutationCount}；${readonly?'保留 V1 执行权':'执行结果等待迁移验收'}。`;
const receipt={taskId:result.taskId,businessDate:result.businessDate,idempotencyKey:idempotencyKey(result),status:signed?'signed':result.stage==='already_done'?'already_signed':'needs_attention',observedAt:result.completedAt,evidence:{source:'v2_canary',summary,redacted:true}};
const item=createDelivery(receipt),file=path.join('outputs',`notification-${item.dedupeKey}.json`);
const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):item;
fs.writeFileSync(file,JSON.stringify(existing,null,2),'utf8');
const delivered=await deliverNotification(existing,{send:async()=>{
  await run(config.executable,['checkin-report','--task-id','fabric_v2_canary','--name','V2 Canary 验收','--source','browser-fabric-v2','--status',signed?'success':result.stage==='already_done'?'already_done':'needs_attention','--event-key',item.dedupeKey,'--summary',summary,'--occurred-at',result.completedAt],{windowsHide:true,timeout:60000,maxBuffer:65536});
}});
fs.writeFileSync(file,JSON.stringify(delivered,null,2),'utf8');
console.log(JSON.stringify({state:delivered.state,attempts:delivered.attempts,outboxId:delivered.outboxId},null,2));
if(delivered.state!=='delivered') process.exitCode=2;
