import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {ptFailureMessages,ptRetryCauses,ptResultStatuses} from './checkin-contract.generated.mjs';
import {projectPtNativeDiagnostic} from './pt-native-diagnostic.generated.mjs';
import {beginPtWorker,cleanupPtWorker,ptWorkerScope,reconcilePtWorker,ptCleanupPendingError} from './pt-worker-lifecycle.mjs';

const statuses=new Set(ptResultStatuses);
const diagnosticCodes=new Set(Object.keys(ptFailureMessages));
export function projectPtDiagnostic(value={}){
  return {...(diagnosticCodes.has(value.failureCode)?{failureCode:value.failureCode}:{}),
    ...(diagnosticCodes.has(value.underlyingFailureCode)?{underlyingFailureCode:value.underlyingFailureCode}:{}),
    ...(ptRetryCauses.includes(value.retryCause)?{retryCause:value.retryCause}:{}),
    ...(projectPtNativeDiagnostic(value.nativeFlow)?{nativeFlow:projectPtNativeDiagnostic(value.nativeFlow)}:{}),
    ...(value.siteCondition==='site_maintenance'?{siteCondition:'site_maintenance'}:{})};
}
const sources=new Set(['api','page_text','usage_log','pt_page','none']);
const modes=new Set(['legacy_checkin','formal_visit_checkin','safe_status_endpoint','safe_history_page','unknown']);
const safety=new Set(['reviewed_passive','attendance_page_risk','unknown']);
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

export function projectPtSiteResult(value,origin){
  if(value?.origin!==origin||!statuses.has(value.status)||!Number.isFinite(Date.parse(value.observedAt)))throw Error('invalid PT site result');
  const evidence=value.evidence??{};
  const observed=Date.parse(value.observedAt),confirmed=Date.parse(evidence.confirmedAt??'');
  const dated=(!evidence.confirmedAt||(Number.isFinite(confirmed)&&confirmed<=observed+60_000&&
    dayAt(confirmed)===dayAt(observed)))&&(!evidence.businessDate||evidence.businessDate===dayAt(observed));
  const authoritative=evidence.authoritative===true&&dated&&sources.has(evidence.source)&&evidence.source!=='none'&&value.submissionOutcomeUnknown!==true;
  const status=value.submissionOutcomeUnknown===true?'needs_attention':
    ['signed','already_signed','not_signed','not_available'].includes(value.status)&&!authoritative?'unknown':value.status;
  return {origin,status,observedAt:new Date(value.observedAt).toISOString(),
    ...projectPtDiagnostic(value),
    ...(value.retryCause==='harvest_waiting'&&value.submissionAttempted===false?{retryCause:'harvest_waiting',
      ...(Number.isFinite(Date.parse(value.nextEligibleAt))?{nextEligibleAt:new Date(value.nextEligibleAt).toISOString()}:{})}:{}),
    ...(modes.has(value.operationMode)?{operationMode:value.operationMode}:{}),
    ...(safety.has(value.readSafety)?{readSafety:value.readSafety}:{}),
    ...(/^[a-f0-9]{64}$/.test(value.profileBinding??'')?{profileBinding:value.profileBinding}:{}),
    ...(/^[A-Za-z0-9._-]{1,80}$/.test(value.accountKey??'')?{accountKey:value.accountKey}:{}),
    ...(value.businessDate===dayAt(observed)?{businessDate:value.businessDate}:{}),
    ...(Number.isFinite(Date.parse(value.startedAt))?{startedAt:new Date(value.startedAt).toISOString()}:{}),
    evidence:{source:sources.has(evidence.source)?evidence.source:'none',authoritative,
      ...(Number.isFinite(confirmed)?{confirmedAt:new Date(confirmed).toISOString()}:{}),
      ...(evidence.businessDate===dayAt(observed)?{businessDate:evidence.businessDate}:{}),
      ...(/^[a-z0-9_]{1,80}$/.test(evidence.statusSignal??'')?{statusSignal:evidence.statusSignal}:{}),
      ...(evidence.evidenceScope==='site_account_day'?{evidenceScope:evidence.evidenceScope}:{}),
      ...(['/index.php','/','/userdetails.php','/log.php'].includes(evidence.pagePath)?{pagePath:evidence.pagePath}:{}),
      summary:typeof evidence.summary==='string'?evidence.summary.slice(0,160):''},
    ...(value.submissionOutcomeUnknown===true?{submissionOutcomeUnknown:true}:{}),
    ...(value.submissionAttempted===true?{submissionAttempted:true}:{}),
    ...(value.submissionAttempted===false?{submissionAttempted:false}:{})};
}

export async function spawnPtSiteChild({legacyRoot,origin,catalogFile,catalogHash,root,lease,readOnly=false,verifyBeforeSubmit=false,loginRecoveryOnly=false,fallbackAttemptId,spawnChild=spawn,timeoutMs=600_000,
  resolveScope=ptWorkerScope,cleanup=cleanupPtWorker,cleanupWaitMs=5000,cleanupTimeoutMs=25_000}){
  const script=path.join(legacyRoot,'scripts/Run-PtSupplement.mjs');
  if(!fs.existsSync(script))throw Error('PT site execution helper is missing');
  const ownerId=crypto.randomUUID(),scope=await resolveScope({legacyRoot,origin,readOnly});
  if(!/^[a-f0-9]{64}$/.test(scope.profileBinding??'')){
    const error=Error('PT worker Profile scope unavailable');error.code='PT_PREFLIGHT';error.preflightReason='scope_unavailable';throw error;
  }
  const command=[script,origin,catalogFile,catalogHash,readOnly?'--read-only':loginRecoveryOnly?'--recover-login-only':verifyBeforeSubmit?'--verify-before-submit':'--execute',
    '--worker-owner='+ownerId];
  if(fallbackAttemptId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fallbackAttemptId))throw Error('invalid PT fallback attempt');
  const childEnv={...process.env,CHECKIN_V2_ENGINE_ROOT:root,CHECKIN_V2_ENGINE_LEASE:lease.owner.nonce,
    CHECKIN_PT_CHILD_OWNER:ownerId,CHECKIN_PT_EXPECTED_PROFILE_BINDING:scope.profileBinding,
    ...(verifyBeforeSubmit?{CHECKIN_PT_FALLBACK_RECHECK:'1'}:{})};
  delete childEnv.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
  if(!readOnly&&fallbackAttemptId!==undefined)childEnv.CHECKIN_PT_FALLBACK_ATTEMPT_ID=fallbackAttemptId;
  const lifecycle=beginPtWorker(root,{ownerId,origin,legacyRoot,...scope,startedAt:new Date().toISOString(),state:'running'});
  const output=await new Promise((resolve,reject)=>{
    let child,stdout='',stderr='',settled=false,terminating=false,closed=false,timer;
    const finish=async(error,value,cleared=true)=>{if(settled)return;settled=true;clearTimeout(timer);
      if(cleared)try{await lifecycle.finish();}catch{error=ptCleanupPendingError();}error?reject(error):resolve(value);};
    try{child=spawnChild(process.execPath,command,{cwd:legacyRoot,windowsHide:true,shell:false,
      stdio:['ignore','pipe','pipe'],env:childEnv});}
    catch(error){finish(error);return;}
    const terminate=async error=>{
      if(terminating||settled)return;terminating=true;clearTimeout(timer);
      let complete=false;
      try{complete=await lifecycle.cleanup(cleanup,cleanupTimeoutMs);}catch{}
      if(complete&&!closed){
        try{child.kill();}catch{}
        let waitTimer;await Promise.race([new Promise(resolve=>child.once('close',resolve)),new Promise(resolve=>{waitTimer=setTimeout(resolve,cleanupWaitMs);})]);
        clearTimeout(waitTimer);
      }
      if(!complete||!closed){finish(ptCleanupPendingError(),undefined,false);return;}
      finish(error);
    };
    timer=setTimeout(()=>void terminate(Error('PT site execution timed out')),timeoutMs);
    const append=(current,chunk)=>{
      if(current.length+chunk.length>64_000){void terminate(Error('PT site output exceeded limit'));return current;}
      return current+chunk;
    };
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk.toString('utf8'));});
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk.toString('utf8'));});
    child.once('error',error=>{if(!child.pid)finish(error);else void terminate(error);});
    child.once('close',(code,signal)=>{closed=true;if(terminating||settled)return;
      if(code===3){finish(Error('V2 runner is already active'));return;}if(code===4){
      const e=Error('PT preflight prevented browser submission');e.code='PT_PREFLIGHT';
      try{const diagnostic=JSON.parse(stderr.trim().split(/\r?\n/).at(-1));
        if(diagnostic.error==='PT_PREFLIGHT'&&['catalog_stale','catalog_hash_changed','registration_invalid','execution_plan_missing',
          'execution_plan_changed','bookmark_source_changed','site_scope_changed','scope_unavailable'].includes(diagnostic.reason))
          e.preflightReason=diagnostic.reason;
      }catch{/* Never propagate a child's raw stderr or private page text. */}
      finish(e);return;
    }if(signal||code!==0){void terminate(Error('PT site execution failed'));return;}void finish(null,stdout);});
    try{lifecycle.started(child.pid);}catch(error){void terminate(error);}
  });
  const line=output.trim().split(/\r?\n/).at(-1);
  return projectPtSiteResult(JSON.parse(line),origin);
}

export async function runPtSite({root=path.resolve('.'),origin,catalogFile,catalogHash,
  readOnly=false,verifyBeforeSubmit=false,loginRecoveryOnly=false,fallbackAttemptId,acquire=acquireExecutionLock,release=releaseExecutionLock,execute=spawnPtSiteChild}={}){
  if(loginRecoveryOnly&&(readOnly||origin!=='https://www.uhddolby.com'))throw Error('Invalid login-only recovery target');
  if(fallbackAttemptId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fallbackAttemptId)){
    const error=Error('PT fallback attempt is invalid');error.code='PT_PREFLIGHT';throw error;
  }
  const absoluteCatalog=path.resolve(root,catalogFile??'');
  const actualHash=fs.existsSync(absoluteCatalog)?crypto.createHash('sha256').update(fs.readFileSync(absoluteCatalog)).digest('hex'):null;
  if(!/^[a-f0-9]{64}$/i.test(catalogHash??'')||actualHash!==catalogHash.toLowerCase()){
    const error=Error('PT catalog missing or changed before execution');error.code='PT_PREFLIGHT';throw error;
  }
  const runtime=loadRuntimeConfig(root);
  if(!readOnly&&!runtime.ptFallbackOnlyEnabled){const error=Error('PT fallback is not enabled in private runtime configuration');error.code='PT_PREFLIGHT';throw error;}
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('PT site fallback requires the execution layer');
  const integration=JSON.parse(fs.readFileSync(path.join(runtime.legacyRoot,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||path.resolve(integration.v2ProjectRoot).toLowerCase()!==path.resolve(root).toLowerCase())throw Error('PT site gateway binding mismatch');
  const lease=acquire(root);
  try {
    await reconcilePtWorker(root,{legacyRoot:runtime.legacyRoot});
    const value=await execute({legacyRoot:runtime.legacyRoot,origin,catalogFile:absoluteCatalog,catalogHash,root,lease,readOnly,verifyBeforeSubmit:verifyBeforeSubmit||loginRecoveryOnly,
      ...(loginRecoveryOnly?{loginRecoveryOnly:true}:{}),
      ...(fallbackAttemptId!==undefined?{fallbackAttemptId}:{})});
    return projectPtSiteResult(value,origin);
  } finally {release(lease);}
}
