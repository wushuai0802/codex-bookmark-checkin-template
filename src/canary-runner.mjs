import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runIsolatedBrowserTask} from './isolated-browser-worker.mjs';
import {createNewApiExecutionAdapter} from './new-api-execution-adapter.mjs';
import {idempotencyKey} from './candidate-protocol.mjs';
import {openExecutionJournal,recordOutcome,recordPrepared,reserveExecution} from './execution-journal.mjs';
import {beginV2AccountHandoff,completeV2AccountHandoff,rollbackV2AccountHandoff} from './v1-account-handoff.mjs';
import {taskIdentity} from './contracts.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';

function readJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file),'utf8')); }

function assertV1Idle(legacyRoot) {
  if(fs.existsSync(path.join(legacyRoot,'tmp','run.lock'))) throw Error('V1 runner is active; canary is refused');
  for(const file of [path.join(legacyRoot,'data','scheduler-state.json'),path.join(legacyRoot,'data','scheduler-heartbeat.json')]) if(fs.existsSync(file)) {
    try { const value=readJson(file); if(['running','running_checkin'].includes(String(value.phase))) throw Error('V1 scheduler is active'); }
    catch(error) { if(error.message==='V1 scheduler is active') throw error; }
  }
}

function safeEvidence(result) {
  const evidence=result?.task?.lastEvent?.evidence;
  return evidence ? {source:String(evidence.source??'none').slice(0,64),authoritative:evidence.authoritative===true,summary:String(evidence.summary??result.task.lastEvent?.reason??'').slice(0,240)} : null;
}

export async function runCanary({task,execute=false,root=path.resolve('.'),legacyRoot=null,executablePath=null,launchPersistentContext=null,writeOutput=true}={}) {
  const runtime=loadRuntimeConfig(root);legacyRoot=legacyRoot??runtime.legacyRoot;executablePath=executablePath??runtime.chromeExecutable;
  if(!task||typeof task!=='object') throw Error('canary task is required');
  if(task.executionEnabled!==false) throw Error('canary task must start disabled');
  if(!task.preconditions?.profileReady||!task.preconditions?.identityVerified) throw Error('canary preconditions are incomplete');
  const expectedTask=taskIdentity({businessDate:task.businessDate,logicalSiteKey:task.origin,accountKey:task.accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
  if(task.taskId!==expectedTask.taskId||task.planUnitId!==expectedTask.planUnitId) throw Error('canary task identity does not match its account/date');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  if(execute&&task.businessDate!==today) throw Error('execute is allowed only for today task');
  if(execute&&!legacyRoot)throw Error('legacyRoot is required for execution');
  if(!executablePath)throw Error('chromeExecutable is required');
  if(execute) assertV1Idle(legacyRoot);
  let launcher=launchPersistentContext;
  if(!launcher){const req=createRequire(path.join(root,'package.json'));let chromium;try{({chromium}=req('playwright-core'));}catch{throw Error('playwright-core dependency is required');}launcher=(profile,options)=>chromium.launchPersistentContext(profile,options);}
  const adapter=createNewApiExecutionAdapter({origin:task.origin,rule:task.adapterRule??{}}),executionKey=idempotencyKey({taskId:task.taskId,businessDate:task.businessDate});
  let journal=null,handoffStarted=false;
  if(execute) {
    journal=openExecutionJournal(process.env.CHECKIN_EXECUTION_JOURNAL??path.join(root,'data','v2-execution.sqlite'),legacyRoot);
    const reservation=reserveExecution(journal,{idempotencyKey:executionKey,taskId:task.taskId,planHash:task.planHash,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate});
    if(reservation.duplicate){const phase=String(reservation.record?.phase??reservation.state);journal.close();return {schemaVersion:1,mode:'canary_execute',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:phase,phase,mutationCount:phase==='succeeded'?1:0,duplicate:true};}
    beginV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,origin:task.origin,expiresAt:new Date(Date.now()+45*60_000).toISOString()}); handoffStarted=true;
  }
  let result;
  try {
    result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:task.profileDir,dedicatedRoot:root,executablePath,windowMode:'offscreen',allowMutation:execute,persistIntent:execute?async(intent)=>recordPrepared(journal,intent):null,launchPersistentContext:launcher});
    if(journal){const phase=result.task.phase==='succeeded'?'succeeded':result.task.phase==='already_done'?'already_done':result.task.phase==='not_available'?'not_available':result.task.phase==='submission_unknown'?'submission_unknown':result.stage==='submit_rejected'?'submit_rejected':'blocked';recordOutcome(journal,{idempotencyKey:executionKey,phase,outcome:{stage:result.stage,mutationCount:result.mutationCount}});}
    if(handoffStarted&&result.stage==='succeeded'&&result.mutationCount===1)completeV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});
    else if(handoffStarted&&result.stage!=='submission_unknown')rollbackV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});
  } catch(error) {
    if(journal){try{recordOutcome(journal,{idempotencyKey:executionKey,phase:'blocked',outcome:{reason:'worker_error'}});}catch{}}
    if(handoffStarted){try{rollbackV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});}catch{}}
    throw error;
  } finally { if(journal)journal.close(); }
  if(!execute&&result.mutationCount!==0)throw Error('read-only canary performed a mutation');
  const report={schemaVersion:1,mode:execute?'canary_execute':'canary_read_only',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:result.stage,phase:result.task.phase,mutationCount:result.mutationCount,windowMode:result.worker.windowMode,profileBound:result.worker.profileBound,evidence:safeEvidence(result),completedAt:result.worker.completedAt};
  if(writeOutput){const output=path.join(root,'outputs',`canary-result-${task.accountKey}-${task.businessDate}.json`);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');report.output=output;}
  return report;
}
