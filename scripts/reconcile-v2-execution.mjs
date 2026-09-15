#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {idempotencyKey} from '../src/candidate-protocol.mjs';
import {openExecutionJournal,reconcileUnknownExecution} from '../src/execution-journal.mjs';
import {promoteMigrationAfterVerifiedSubmission} from '../src/migration-state.mjs';
import {assertV1Idle,completeV2AccountHandoff} from '../src/v1-account-handoff.mjs';
import {loadRuntimeConfig} from '../src/runtime-config.mjs';

function arg(name){const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:null;}
const root=path.resolve('.'),taskFile=arg('--task'),observationFile=arg('--observation');if(!taskFile||!observationFile)throw Error('provide --task and --observation');
const task=JSON.parse(fs.readFileSync(path.resolve(taskFile),'utf8')),observation=JSON.parse(fs.readFileSync(path.resolve(observationFile),'utf8'));
if(task.executionEnabled!==false||observation.mode!=='canary_read_only'||observation.stage!=='already_done'||observation.mutationCount!==0||observation.evidence?.authoritative!==true)throw Error('observation is not authoritative completed proof');
for(const key of ['taskId','accountKey','origin','businessDate'])if(String(observation[key])!==String(task[key]))throw Error(`observation ${key} mismatch`);
const runtime=loadRuntimeConfig(root);if(!runtime.legacyRoot)throw Error('legacyRoot is required');assertV1Idle(runtime.legacyRoot);
const db=openExecutionJournal(process.env.CHECKIN_EXECUTION_JOURNAL??path.join(root,'data','v2-execution.sqlite'),runtime.legacyRoot);let result;
try{result=reconcileUnknownExecution(db,{idempotencyKey:idempotencyKey(task),taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,proof:{authoritative:true,stage:'already_done',taskId:task.taskId,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate,observedAt:observation.completedAt,evidence:observation.evidence}});}finally{db.close();}
completeV2AccountHandoff({v1Root:runtime.legacyRoot,accountKey:task.accountKey,now:result.completedAt});
const migration=promoteMigrationAfterVerifiedSubmission({root,accountKey:task.accountKey,origin:task.origin,completedAt:result.completedAt,stage:'succeeded',mutationCount:1,provenance:'v2_reconciled_after_unknown'});
const report={schemaVersion:1,mode:'canary_execute',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:'succeeded',phase:'succeeded',mutationCount:1,windowMode:'offscreen',profileBound:true,captchaSolverConfigured:false,reason:'reconciled_after_submission_unknown',evidence:result.evidence,completedAt:result.completedAt,persistenceError:null,handoffPending:false};
fs.writeFileSync(path.join(root,'outputs',`canary-result-${task.accountKey}-${task.businessDate}.json`),JSON.stringify(report,null,2),'utf8');
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'scripts','notify-canary-result.mjs'),path.join(root,'outputs',`canary-result-${task.accountKey}-${task.businessDate}.json`)],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('exit',()=>resolve());});
console.log(JSON.stringify({accountKey:task.accountKey,businessDate:task.businessDate,...result,migration},null,2));
