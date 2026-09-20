#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {openExecutionJournal,recoverExecutionForRetry} from '../src/execution-journal.mjs';
import {loadRuntimeConfig,assertStandaloneV2Enabled} from '../src/runtime-config.mjs';

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
const root=path.resolve('.'),taskFile=arg('--task'),observationFile=arg('--observation'),nonMutating=process.argv.includes('--non-mutating-rejection'),reason=arg('--reason')??'verified_not_signed_after_fix';
assertStandaloneV2Enabled(root);
if(!taskFile||Boolean(observationFile)===nonMutating)throw Error('provide --task and exactly one recovery proof mode');
const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8'));if(task.executionEnabled!==false)throw Error('task must start disabled');
let proof;
if(observationFile){
  const observation=JSON.parse(fs.readFileSync(path.resolve(observationFile),'utf8'));
  if(observation.mode!=='canary_read_only'||observation.stage!=='not_signed'||observation.mutationCount!==0||observation.evidence?.authoritative!==true)throw Error('observation is not authoritative not-signed proof');
  for(const key of ['taskId','accountKey','origin','businessDate'])if(String(observation[key])!==String(task[key]))throw Error(`observation ${key} mismatch`);
  proof={authoritative:true,stage:'not_signed',kind:'authoritative_not_signed',source:observation.evidence.source,taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,observedAt:observation.completedAt,reason};
}else proof={authoritative:true,stage:'not_signed',kind:'durable_non_mutating_failure',source:'execution_journal',taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,observedAt:new Date().toISOString(),reason};
const runtime=loadRuntimeConfig(root);if(!runtime.legacyRoot)throw Error('legacyRoot is required');
const db=openExecutionJournal(process.env.CHECKIN_EXECUTION_JOURNAL??path.join(root,'data','v2-execution.sqlite'),runtime.legacyRoot);
try{
  const result=recoverExecutionForRetry(db,{idempotencyKey:idempotencyKey(task),taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,proof});
  console.log(JSON.stringify({accountKey:task.accountKey,businessDate:task.businessDate,...result},null,2));
}finally{db.close();}
