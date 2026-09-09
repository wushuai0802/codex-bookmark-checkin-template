import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {runIsolatedBrowserTask} from './isolated-browser-worker.mjs';
import {createNewApiExecutionAdapter} from './new-api-execution-adapter.mjs';
import {idempotencyKey} from './candidate-protocol.mjs';
import {cancelReservation,openExecutionJournal,recordOutcome,recordPrepared,reserveExecution} from './execution-journal.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {assertV1Idle,beginV2AccountHandoff,completeV2AccountHandoff,quarantineV2AccountHandoff,readV2AccountHandoff,rollbackV2AccountHandoff} from './v1-account-handoff.mjs';
import {assertPlanHash,normalizeOrigin,taskIdentity} from './contracts.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';

function safeEvidence(result) {
  const evidence=result?.task?.lastEvent?.evidence;
  return evidence ? {source:String(evidence.source??'none').slice(0,64),authoritative:evidence.authoritative===true,summary:String(evidence.summary||result.task.lastEvent?.reason||'').slice(0,240)} : null;
}

function hasMutation(result) { return Number(result?.mutationCount??0)>0; }

function safeStoredEvidence(evidence) {
  if(!evidence||typeof evidence!=='object')return null;
  return {source:String(evidence.source??'none').slice(0,64),authoritative:evidence.authoritative===true,summary:String(evidence.summary??'').slice(0,240)};
}

function writeReport(root,task,report,enabled) {
  if(!enabled)return report;
  const output=path.join(root,'outputs',`canary-result-${task.accountKey}-${task.businessDate}.json`);
  try { fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2),'utf8');return {...report,output}; }
  catch { return {...report,persistenceError:report.persistenceError??'report_persist_failed',output:null}; }
}

function parseOutcome(record) {
  if(typeof record?.outcome_json!=='string')return null;
  try { const value=JSON.parse(record.outcome_json); return value&&typeof value==='object'?value:null; } catch { return null; }
}

export async function runCanary({task,execute=false,root=path.resolve('.'),legacyRoot=null,executablePath=null,launchPersistentContext=null,writeOutput=true,recordOutcomeFn=recordOutcome,executionLock=null}={}) {
  const runtime=loadRuntimeConfig(root);legacyRoot=legacyRoot??runtime.legacyRoot;executablePath=executablePath??runtime.chromeExecutable;
  if(!task||typeof task!=='object') throw Error('canary task is required');
  if(task.executionEnabled!==false) throw Error('canary task must start disabled');
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(String(task.accountKey??''))||!/^\d{4}-\d{2}-\d{2}$/.test(String(task.businessDate??''))) throw Error('canary task file identity is invalid');
  const normalizedOrigin=normalizeOrigin(task.origin);if(normalizedOrigin!==task.origin||!normalizedOrigin.startsWith('https://'))throw Error('canary task origin is invalid');
  assertPlanHash(task.planHash,'canary task planHash');
  if(!task.preconditions?.profileReady||!task.preconditions?.identityVerified) throw Error('canary preconditions are incomplete');
  const expectedTask=taskIdentity({businessDate:task.businessDate,logicalSiteKey:task.origin,accountKey:task.accountKey,actionType:'checkin',scheduleOccurrence:'daily'});
  if(task.taskId!==expectedTask.taskId||task.planUnitId!==expectedTask.planUnitId) throw Error('canary task identity does not match its account/date');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
  if(execute&&task.businessDate!==today) throw Error('execute is allowed only for today task');
  if(execute&&!legacyRoot)throw Error('legacyRoot is required for execution');
  if(!executablePath)throw Error('chromeExecutable is required');
  const ownershipState=task.ownershipState??'candidate';
  if(!['candidate','active'].includes(ownershipState))throw Error('canary ownership state is invalid');
  if(task.adapterId!=='new-api.execute.v1')throw Error('canary adapter is not implemented');
  if(ownershipState==='active'&&(task.executionOwner!=='v2-worker'||task.preconditions.v1MustBeStoppedBeforeMutation!==false))throw Error('active canary ownership metadata is invalid');
  if(ownershipState==='candidate'&&(task.executionOwner!=='legacy-checkin'||task.preconditions.v1MustBeStoppedBeforeMutation!==true))throw Error('candidate canary ownership metadata is invalid');
  if(execute&&executionLock&&(!executionLock.file||!executionLock.owner?.nonce||path.resolve(executionLock.file)!==path.resolve(root,'data','v2-run.lock')))throw Error('invalid V2 execution lock lease');
  if(execute) assertV1Idle(legacyRoot);
  let launcher=launchPersistentContext;
  if(!launcher){const req=createRequire(path.join(root,'package.json'));let chromium;try{({chromium}=req('playwright-core'));}catch{throw Error('playwright-core dependency is required');}launcher=(profile,options)=>chromium.launchPersistentContext(profile,options);}
  const adapter=createNewApiExecutionAdapter({origin:task.origin,rule:task.adapterRule??{}}),executionKey=idempotencyKey({taskId:task.taskId,businessDate:task.businessDate});
  let journal=null,ownedExecutionLock=false,handoffStarted=false,intentPrepared=false;
  if(execute) {
    if(!executionLock){executionLock=acquireExecutionLock(root);ownedExecutionLock=true;}
    try { journal=openExecutionJournal(process.env.CHECKIN_EXECUTION_JOURNAL??path.join(root,'data','v2-execution.sqlite'),legacyRoot); }
    catch(error) { if(ownedExecutionLock)releaseExecutionLock(executionLock); throw error; }
    let reservation;
    try { reservation=reserveExecution(journal,{idempotencyKey:executionKey,taskId:task.taskId,planHash:task.planHash,accountKey:task.accountKey,origin:task.origin,businessDate:task.businessDate}); }
    catch(error) { try { journal.close(); } finally { if(ownedExecutionLock)releaseExecutionLock(executionLock); } throw error; }
    if(reservation.duplicate){
      const phase=String(reservation.record?.phase??reservation.state),outcome=parseOutcome(reservation.record),completedAt=Number.isFinite(Date.parse(reservation.record?.updated_at))?new Date(reservation.record.updated_at).toISOString():null;
      let handoffPending=phase==='prepared'||phase==='submission_unknown';
      if(handoffPending&&ownershipState==='candidate'){try{quarantineV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,reason:phase});}catch{} }
      if(phase==='succeeded'){
        try { completeV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey}); handoffPending=false; }
        catch { handoffPending=true; }
      }
      if(ownershipState==='active'&&['succeeded','already_done','not_available'].includes(phase)){
        try { const handoff=readV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});if(!handoff||handoff.state!=='v2_owned'||handoff.origin!==task.origin||handoff.expiresAt!==null)handoffPending=true; }
        catch { handoffPending=true; }
      }
      const mutationCount=['succeeded','submission_unknown'].includes(phase)?1:0;
      const reportStage=handoffPending&&ownershipState==='active'?(mutationCount?'submission_unknown':'blocked'):phase;
      const report={schemaVersion:1,mode:'canary_execute',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:reportStage,phase:reportStage,mutationCount,duplicate:true,evidence:safeStoredEvidence(outcome?.evidence),completedAt,persistenceError:handoffPending?'handoff_pending':null,handoffPending};
      try { journal.close(); } finally { if(ownedExecutionLock)releaseExecutionLock(executionLock); }
      return writeReport(root,task,report,writeOutput);
    }
    try {
      if(ownershipState==='candidate') { beginV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,origin:task.origin,expiresAt:new Date(Date.now()+45*60_000).toISOString()}); handoffStarted=true; }
      else {
        const handoff=readV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});
        if(!handoff||handoff.state!=='v2_owned'||handoff.origin!==task.origin||handoff.expiresAt!==null)throw Error('active V2 handoff is missing or mismatched');
      }
    }
    catch(error) { try { cancelReservation(journal,executionKey); } finally { try { journal.close(); } finally { if(ownedExecutionLock)releaseExecutionLock(executionLock); } } throw error; }
  }
  let result;
  try {
    result=await runIsolatedBrowserTask({task,adapterDefinition:adapter,profileDir:task.profileDir,dedicatedRoot:root,executablePath,windowMode:'offscreen',allowMutation:execute,persistIntent:execute?async(intent)=>{recordPrepared(journal,intent);intentPrepared=true;quarantineV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,reason:'prepared'});}:null,launchPersistentContext:launcher});
    if(ownershipState==='active'&&['succeeded','already_done','not_available'].includes(result.stage)){
      try { const handoff=readV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});if(!handoff||handoff.state!=='v2_owned'||handoff.origin!==task.origin||handoff.expiresAt!==null)result={...result,task:{...result.task,phase:'blocked'},stage:'blocked',reportPhase:'blocked',persistenceError:'active_handoff_missing',handoffPending:true}; }
      catch { result={...result,task:{...result.task,phase:'blocked'},stage:'blocked',reportPhase:'blocked',persistenceError:'active_handoff_unreadable',handoffPending:true}; }
    }
    const phase=result.task.phase==='succeeded'?'succeeded':result.task.phase==='already_done'?'already_done':result.task.phase==='not_available'?'not_available':result.task.phase==='submission_unknown'?'submission_unknown':result.stage==='submit_rejected'?'submit_rejected':'blocked';
    if(journal){
      try { recordOutcomeFn(journal,{idempotencyKey:executionKey,phase,outcome:{stage:result.stage,mutationCount:result.mutationCount,evidence:safeEvidence(result),completedAt:result.worker?.completedAt??null}}); }
      catch(error) {
        if(!hasMutation(result))throw error;
        try { recordOutcomeFn(journal,{idempotencyKey:executionKey,phase:'submission_unknown',outcome:{stage:'submission_unknown',reason:'outcome_persist_failed',originalStage:result.stage,mutationCount:result.mutationCount}}); } catch {}
        result={...result,stage:'submission_unknown',reportPhase:'submission_unknown',persistenceError:'outcome_persist_failed',handoffPending:true};
      }
    }
    if(ownershipState==='candidate'&&handoffStarted&&result.stage==='submission_unknown'){try{quarantineV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,reason:'submission_unknown'});}catch{} }
    if(handoffStarted&&result.stage==='succeeded'&&result.mutationCount===1&&!result.persistenceError){
      try { completeV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey}); }
      catch(error) { result={...result,stage:'submission_unknown',reportPhase:'submission_unknown',handoffPending:true,persistenceError:'handoff_persist_failed'}; }
    } else if(handoffStarted&&!hasMutation(result)&&result.stage!=='submission_unknown')rollbackV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});
  } catch(error) {
    const mutationPossible=hasMutation(result)||(!result&&intentPrepared);
    if(journal){try{recordOutcomeFn(journal,{idempotencyKey:executionKey,phase:mutationPossible?'submission_unknown':'blocked',outcome:{reason:mutationPossible?'post_intent_worker_error':'worker_error',mutationCount:mutationPossible?1:0}});}catch{}}
    if(handoffStarted&&!mutationPossible){try{rollbackV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey});}catch{}}
    if(mutationPossible){
      if(ownershipState==='candidate'&&handoffStarted){try{quarantineV2AccountHandoff({v1Root:legacyRoot,accountKey:task.accountKey,reason:'post_intent_worker_error'});}catch{} }
      const completedAt=result?.worker?.completedAt??new Date().toISOString();
      result={task:result?.task??{phase:'submission_unknown',lastEvent:{reason:'post_intent_worker_error',evidence:null}},worker:result?.worker??{windowMode:'offscreen',profileBound:true,completedAt},...result,stage:'submission_unknown',reportPhase:'submission_unknown',mutationCount:Math.max(1,Number(result?.mutationCount??0)),persistenceError:'post_intent_worker_error',handoffPending:true};
    } else throw error;
  } finally { try { if(journal)journal.close(); } finally { if(ownedExecutionLock)releaseExecutionLock(executionLock); } }
  if(!execute&&result.mutationCount!==0)throw Error('read-only canary performed a mutation');
  const report={schemaVersion:1,mode:execute?'canary_execute':'canary_read_only',taskId:task.taskId,businessDate:task.businessDate,origin:task.origin,accountKey:task.accountKey,stage:result.stage,phase:result.reportPhase??result.task.phase,mutationCount:result.mutationCount,windowMode:result.worker.windowMode,profileBound:result.worker.profileBound,evidence:safeEvidence(result),completedAt:result.worker.completedAt,persistenceError:result.persistenceError??null,handoffPending:result.handoffPending===true};
  return writeReport(root,task,report,writeOutput);
}
