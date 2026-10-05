import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {ptFailureMessages,ptRetryCauses,ptResultStatuses} from './checkin-contract.generated.mjs';

const statuses=new Set(ptResultStatuses);
const diagnosticCodes=new Set(Object.keys(ptFailureMessages));
export function projectPtDiagnostic(value={}){
  return {...(diagnosticCodes.has(value.failureCode)?{failureCode:value.failureCode}:{}),
    ...(diagnosticCodes.has(value.underlyingFailureCode)?{underlyingFailureCode:value.underlyingFailureCode}:{}),
    ...(ptRetryCauses.includes(value.retryCause)?{retryCause:value.retryCause}:{}),
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

export async function spawnPtSiteChild({legacyRoot,origin,catalogFile,catalogHash,root,lease,readOnly=false,verifyBeforeSubmit=false,spawnChild=spawn,timeoutMs=600_000}){
  const script=path.join(legacyRoot,'scripts/Run-PtSupplement.mjs');
  if(!fs.existsSync(script))throw Error('PT site execution helper is missing');
  const command=[script,origin,catalogFile,catalogHash,...(readOnly?['--read-only']:verifyBeforeSubmit?['--verify-before-submit']:[])];
  const output=await new Promise((resolve,reject)=>{
    const child=spawnChild(process.execPath,command,{cwd:legacyRoot,windowsHide:true,shell:false,
      stdio:['ignore','pipe','pipe'],env:{...process.env,CHECKIN_V2_ENGINE_ROOT:root,CHECKIN_V2_ENGINE_LEASE:lease.owner.nonce}});
    let stdout='',stderr='';
    const timer=setTimeout(()=>{child.kill();reject(Error('PT site execution timed out'));},timeoutMs);
    const append=(current,chunk)=>{
      if(current.length+chunk.length>64_000){child.kill();reject(Error('PT site output exceeded limit'));return current;}
      return current+chunk;
    };
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk.toString('utf8'));});
    child.stderr.on('data',chunk=>{stderr=append(stderr,chunk.toString('utf8'));});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{clearTimeout(timer);if(code===3){reject(Error('V2 runner is already active'));return;}if(code===4){const e=Error('PT preflight prevented browser submission');e.code='PT_PREFLIGHT';reject(e);return;}if(signal||code!==0){reject(Error('PT site execution failed'));return;}resolve(stdout);});
  });
  const line=output.trim().split(/\r?\n/).at(-1);
  return projectPtSiteResult(JSON.parse(line),origin);
}

export async function runPtSite({root=path.resolve('.'),origin,catalogFile,catalogHash,
  readOnly=false,verifyBeforeSubmit=false,acquire=acquireExecutionLock,release=releaseExecutionLock,execute=spawnPtSiteChild}={}){
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
    const value=await execute({legacyRoot:runtime.legacyRoot,origin,catalogFile:absoluteCatalog,catalogHash,root,lease,readOnly,verifyBeforeSubmit});
    return projectPtSiteResult(value,origin);
  } finally {release(lease);}
}
