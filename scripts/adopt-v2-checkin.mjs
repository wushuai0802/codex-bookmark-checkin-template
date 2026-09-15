#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {adoptOperatorConfirmedCheckin,openExecutionJournal} from '../src/execution-journal.mjs';
import {promoteMigrationAfterVerifiedSubmission} from '../src/migration-state.mjs';
import {assertV1Idle,beginV2AccountHandoff,completeV2AccountHandoff,rollbackV2AccountHandoff} from '../src/v1-account-handoff.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
if(!process.argv.includes('--operator-confirmed'))throw Error('operator confirmation is required');
const root=path.resolve('.'),taskFile=arg('--task'),observationFile=arg('--observation');if(!taskFile||!observationFile)throw Error('provide --task and --observation');
const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8')),observation=JSON.parse(fs.readFileSync(path.resolve(observationFile),'utf8'));
if(task.executionEnabled!==false||observation.mode!=='canary_read_only'||observation.stage!=='already_done'||observation.mutationCount!==0||observation.evidence?.authoritative!==true)throw Error('observation is not authoritative already-done proof');
for(const key of ['taskId','accountKey','origin','businessDate'])if(String(observation[key])!==String(task[key]))throw Error(`observation ${key} mismatch`);
const runtime=loadRuntimeConfig(root);if(!runtime.legacyRoot)throw Error('legacyRoot is required');assertV1Idle(runtime.legacyRoot);
const now=new Date().toISOString();beginV2AccountHandoff({v1Root:runtime.legacyRoot,accountKey:task.accountKey,origin:task.origin,expiresAt:new Date(Date.now()+15*60_000).toISOString(),now});
let result;try{const db=openExecutionJournal(process.env.CHECKIN_EXECUTION_JOURNAL??path.join(root,'data','v2-execution.sqlite'),runtime.legacyRoot);try{result=adoptOperatorConfirmedCheckin(db,{idempotencyKey:idempotencyKey(task),taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,operatorConfirmed:true,proof:{authoritative:true,stage:'already_done',taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,observedAt:observation.completedAt,evidence:observation.evidence}});}finally{db.close();}completeV2AccountHandoff({v1Root:runtime.legacyRoot,accountKey:task.accountKey,now:result.completedAt});}catch(error){try{rollbackV2AccountHandoff({v1Root:runtime.legacyRoot,accountKey:task.accountKey});}catch{}throw error;}
const migration=promoteMigrationAfterVerifiedSubmission({root,accountKey:task.accountKey,origin:task.origin,completedAt:result.completedAt,stage:'succeeded',mutationCount:1,provenance:'operator_confirmed_v2_login'});
console.log(JSON.stringify({accountKey:task.accountKey,businessDate:task.businessDate,...result,migration},null,2));
