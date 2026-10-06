import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {runPtSite} from './pt-site-execution.mjs';
import {recordPtVerification} from './pt-verification.mjs';
import {boundMonitorCatalog} from './monitor-catalog.mjs';
import {loadEffectiveConfig} from './effective-config.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {buildSnapshot,writeSnapshot} from './bridge.mjs';
import {createLedgerRecord,appendLedgerRecord} from './shadow-ledger.mjs';
import {commitDashboardGeneration} from './dashboard-generation.mjs';
import {loadPtRecoveryDiagnostics} from './pt-reconciliation.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const readOptional=file=>fs.existsSync(file)?read(file):null;

const identityKey=(origin,accountKey='site-default')=>accountKey==='site-default'
  ? origin
  : `${origin}#account=${encodeURIComponent(accountKey)}`;

function previousFor(state,origin,accountKey){
  const key=identityKey(origin,accountKey),direct=state.sites?.[key];
  if(direct)return direct;
  return accountKey==='site-default'?state.sites?.[origin]:null;
}

function safeErrorCode(error){
  const code=String(error?.code??'').trim();
  if(code==='PT_READONLY_UNSAFE')return {errorStage:'preflight',errorCode:'readonly_capability_unavailable'};
  if(code==='PT_PREFLIGHT')return {errorStage:'preflight',errorCode:'preflight_failed'};
  if(code==='PT_ACCOUNT_MISMATCH')return {errorStage:'binding',errorCode:'account_binding_mismatch'};
  if(code==='PT_PROFILE_MISMATCH')return {errorStage:'binding',errorCode:'profile_binding_mismatch'};
  if(code==='PT_CATALOG')return {errorStage:'preflight',errorCode:'catalog_changed'};
  if(/already active|正在运行|正在启动|占用/i.test(error?.message??''))
    return {errorStage:'lock',errorCode:'runner_busy'};
  if(/timed out|timeout|超时/i.test(error?.message??''))
    return {errorStage:'readback',errorCode:'readback_timeout'};
  if(/profile|binding|account|账号|账户/i.test(error?.message??''))
    return {errorStage:'binding',errorCode:'profile_binding_mismatch'};
  return {errorStage:'readback',errorCode:'readback_unavailable'};
}

function writeAudit(root,businessDate,entry){
  const file=path.join(root,'data',`pt-evidence-repair-audit-${businessDate}.jsonl`);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.appendFileSync(file,`${JSON.stringify(entry)}\n`,{encoding:'utf8',mode:0o600});
}

export function writeEvidenceDirtyMarker(root,businessDate,{results=[],rebuild=null,now=new Date()}={}){
  const file=path.join(root,'outputs',`pt-evidence-repair-dirty-${businessDate}.json`);
  const value={schemaVersion:1,source:'pt-evidence-repair',businessDate,
    generatedAt:now.toISOString(),needsDashboardSync:true,resultCount:results.length,
    verifiedCount:results.filter(item=>['verified','existing_receipt'].includes(item.outcome)).length,
    rebuildPending:rebuild?.rebuilt!==true};
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.${process.pid}.tmp`;
  try{fs.writeFileSync(temporary,`${JSON.stringify(value)}\n`,{encoding:'utf8',mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return path.basename(file);
}

function extractHarvestReport(snapshot,businessDate){
  const sites=[];
  for(const site of snapshot?.ptStatus?.sites??[]){
    for(const observation of site.observations??[]){
      if(observation.source!=='harvest')continue;
      sites.push({origin:site.origin,displayName:site.displayName,accountRef:site.accountRef,
        source:'harvest',status:observation.status,observedAt:observation.observedAt,evidence:observation.evidence});
    }
  }
  return sites.length?{schemaVersion:1,source:'harvest',businessDate,generatedAt:snapshot.generatedAt,sites}:undefined;
}

/**
 * Rebuild the redacted observation generation after a passive evidence worker
 * finishes. This only reads the existing V1 report and same-day passive
 * receipts; it never launches a browser or submits a check-in.
 */
export function rebuildDashboardAfterEvidence({root,catalogFile,now=new Date()}={}){
  const runtime=loadRuntimeConfig(root),legacyRoot=runtime.legacyRoot;
  if(!legacyRoot)throw Error('legacy root unavailable for evidence dashboard rebuild');
  const day=dayAt(now),snapshotFile=path.join(root,'outputs','shadow-beta-snapshot.json');
  const ledgerFile=path.join(root,'outputs','shadow-ledger.jsonl');
  let lease;
  try{lease=acquireExecutionLock(root,{name:'v2-run.lock'});}
  catch(error){
    if(/already active|正在运行|正在启动|占用/i.test(error.message))
      return {rebuilt:false,reason:'runner_busy',errorStage:'lock',errorCode:'runner_busy',businessDate:day};
    throw error;
  }
  try{
  const previous=read(snapshotFile);
  if(previous.businessDate!==day)return {rebuilt:false,reason:'business_day_changed',businessDate:previous.businessDate};
  const fallback=readOptional(path.join(root,'outputs',`pt-fallback-results-${day}.json`));
  const catalog=readOptional(catalogFile);
  const health=readOptional(path.join(legacyRoot,'health.json'));
  const snapshot=buildSnapshot({legacyRoot,generatedAt:now.toISOString(),healthReport:health,
    ptStatusReport:extractHarvestReport(previous,day),ptFallbackReport:fallback,
    monitorCatalog:catalog,ptFallbackOnlyEnabled:runtime.ptFallbackOnlyEnabled,
    ptRecoveryReport:loadPtRecoveryDiagnostics(root,day)});
  if(snapshot.businessDate!==day)
    return {rebuilt:false,reason:'legacy_report_not_same_day',businessDate:snapshot.businessDate};
  const record=createLedgerRecord(snapshot,{previousSnapshot:previous,recordedAt:now.toISOString()});
  appendLedgerRecord(ledgerFile,record,{legacyRoot});
  writeSnapshot(snapshot,snapshotFile,legacyRoot);
  commitDashboardGeneration({snapshot,snapshotFile,ledgerFile});
  return {rebuilt:true,businessDate:day,snapshotId:snapshot.snapshotId,generatedAt:snapshot.generatedAt};
  }finally{releaseExecutionLock(lease);}
}

function candidateRecords(snapshot,catalog,state,now=new Date()){
  const today=dayAt(now);
  if(snapshot?.businessDate!==today)return [];
  const receipts=new Map((snapshot.receipts??[]).map(r=>[r.taskId,r]));
  const origins=new Set((catalog.sites??[]).map(s=>s.origin));
  const unique=new Map();
  for(const task of snapshot.tasks??[]){
    const origin=task.origin,accountKey=task.accountKey??'site-default';
    const readbackReview=task.observedStatus==='needs_attention'&&task.failureCode==='submission_outcome_unknown'&&task.submissionAttempted===true;
    const positiveWithoutEvidence=['signed','already_signed'].includes(task.observedStatus);
    if(!origins.has(origin)||(!positiveWithoutEvidence&&!readbackReview)||receipts.get(task.taskId)?.evidence?.authoritative===true)continue;
    const key=identityKey(origin,accountKey);
    if(!unique.has(key))unique.set(key,{origin,accountKey,taskId:task.taskId});
  }
  const due=[];
  for(const item of unique.values()){
    const previous=previousFor(state,item.origin,item.accountKey);
    if(previous&&previous.businessDate===today){
      const attempts=Number(previous.attempts??0);
      const next=Date.parse(previous.nextAttemptAt??'');
      if(attempts>=2||(Number.isFinite(next)&&next>now.getTime()))continue;
    }
    due.push({...item,previous});
  }
  // Oldest checked item first; never let one site at the front of the
  // bookmark plan consume every bounded worker slot.
  return due.sort((a,b)=>{
    const at=Date.parse(a.previous?.checkedAt??'');
    const bt=Date.parse(b.previous?.checkedAt??'');
    if(Number.isFinite(at)!==Number.isFinite(bt))return Number.isFinite(at)?1:-1;
    if(Number.isFinite(at)&&at!==bt)return at-bt;
    return identityKey(a.origin,a.accountKey).localeCompare(identityKey(b.origin,b.accountKey));
  });
}

export function ptEvidenceCandidates(snapshot,catalog,state,now=new Date()){
  return candidateRecords(snapshot,catalog,state,now).map(item=>item.origin)
    .filter((origin,index,all)=>all.indexOf(origin)===index);
}

export function refreshEvidenceCatalog(root,catalogFile,now=new Date()){
  const runtime=read(path.join(root,'config/runtime.local.json')),config=loadEffectiveConfig(runtime.legacyRoot);
  const previous=read(catalogFile);
  const catalog=boundMonitorCatalog(config.bookmarksPath,previous.scope,now);
  const file=path.join(root,'data/pt-evidence-catalog.json');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.'+process.pid+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(catalog),{mode:0o600});fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return file;
}

export async function repairPtEvidence({root,catalogFile,maxSites=1,clock=()=>new Date(),runSite=runPtSite,record=recordPtVerification,refreshCatalog=refreshEvidenceCatalog,rebuild=null}={}){
  if(!Number.isInteger(maxSites)||maxSites<1||maxSites>4)throw Error('Evidence repair site limit must be 1..4');
  const lease=acquireExecutionLock(root,{name:'pt-evidence-repair.lock'});
  try {
    const snapshot=read(path.join(root,'outputs/shadow-beta-snapshot.json'));
    if(snapshot.businessDate!==dayAt(clock()))return {businessDate:snapshot.businessDate,results:[]};
    let currentCatalog=refreshCatalog(root,catalogFile,clock()),catalog=read(currentCatalog);
    const stateFile=path.join(root,'data/pt-evidence-repair.json');
    const state=fs.existsSync(stateFile)?read(stateFile):{schemaVersion:1,sites:{}};
    const now=clock(),candidates=candidateRecords(snapshot,catalog,state,now).slice(0,maxSites),results=[];
    for(const candidate of candidates){
      const origin=candidate.origin,accountKey=candidate.accountKey;
      if(dayAt(clock())!==snapshot.businessDate)break;
      currentCatalog=refreshCatalog(root,catalogFile,clock());
      const hash=crypto.createHash('sha256').update(fs.readFileSync(currentCatalog)).digest('hex');
      const old=previousFor(state,origin,accountKey),attempts=old?.businessDate===snapshot.businessDate?old.attempts+1:1;
      let outcome='evidence_unavailable',errorInfo={errorStage:'readback',errorCode:'authoritative_readback_missing'},auditStatus='inconclusive';
      const startedAt=clock();
      try{
        // The passive V1 helper currently owns one bookmarked account per PT
        // origin. Never let it silently read another account's profile.
        if(accountKey!=='site-default'){const error=Error('passive account binding is not supported');error.code='PT_ACCOUNT_MISMATCH';throw error;}
        const result=await runSite({root,origin,accountKey,catalogFile:currentCatalog,catalogHash:hash,readOnly:true});
        if(dayAt(clock())!==snapshot.businessDate)break;
        if(result?.accountKey&&result.accountKey!==accountKey){const error=Error('passive account mismatch');error.code='PT_ACCOUNT_MISMATCH';throw error;}
        // A diagnostic cannot erase the already reported completion. Only a
        // current positive readback is published; other results stay in this audit.
        if(['signed','already_signed'].includes(result.status)&&result.evidence?.authoritative===true){
          const saved=record(root,result,{now:clock()});outcome=saved.recorded?'verified':'existing_receipt';auditStatus='verified';errorInfo={errorStage:null,errorCode:null};
        }else{
          errorInfo={errorStage:'readback',errorCode:'authoritative_readback_missing'};
        }
      }catch(error){
        errorInfo=safeErrorCode(error);
        if(errorInfo.errorCode==='runner_busy'){
          outcome='busy';auditStatus='deferred';
        }else{
          outcome=errorInfo.errorStage==='preflight'?'capability_unavailable':'readback_unavailable';
          auditStatus='inconclusive';
        }
      }
      const checkedAt=clock(),nextDelay=outcome==='busy'?5*60_000:2*3600000;
      const stateKey=identityKey(origin,accountKey),recordedAttempts=outcome==='busy'?Number(old?.attempts??0):attempts;
      const entry={businessDate:snapshot.businessDate,accountKey,attempts:['verified','existing_receipt'].includes(outcome)?2:recordedAttempts,
        outcome,status:auditStatus,errorStage:errorInfo.errorStage,errorCode:errorInfo.errorCode,checkedAt:checkedAt.toISOString(),nextAttemptAt:new Date(checkedAt.getTime()+nextDelay).toISOString()};
      state.sites[stateKey]=entry;
      const audit={schemaVersion:1,businessDate:snapshot.businessDate,origin,accountKey,attempt:entry.attempts,
        startedAt:startedAt.toISOString(),finishedAt:checkedAt.toISOString(),status:auditStatus,outcome,readOnly:true,submissionAttempted:false,
        errorStage:errorInfo.errorStage,errorCode:errorInfo.errorCode};
      writeAudit(root,snapshot.businessDate,audit);
      results.push({origin,accountKey,outcome,status:auditStatus,errorStage:errorInfo.errorStage,errorCode:errorInfo.errorCode});
      fs.mkdirSync(path.dirname(stateFile),{recursive:true});
      const temporary=stateFile+'.'+process.pid+'.tmp';
      try{fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temporary,stateFile);}
      finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    }
    let rebuildResult=null;
    if(results.length&&typeof rebuild==='function'){
      try{rebuildResult=await rebuild({businessDate:snapshot.businessDate,now:clock(),results});}
      catch(error){rebuildResult={rebuilt:false,reason:'dashboard_rebuild_failed',errorStage:'publication',errorCode:'dashboard_rebuild_failed'};}
    }
    // Do not create a new publication trigger when this pass had no candidate.
    // An existing marker is deliberately preserved so a failed prior publish
    // can still be retried by the scheduler.
    const markerPath=path.join(root,'outputs',`pt-evidence-repair-dirty-${snapshot.businessDate}.json`);
    const dirtyMarker=results.length
      ? writeEvidenceDirtyMarker(root,snapshot.businessDate,{results,rebuild:rebuildResult,now:clock()})
      : (fs.existsSync(markerPath)?path.basename(markerPath):null);
    return {businessDate:snapshot.businessDate,results,dirtyMarker,...(rebuildResult?{rebuild:rebuildResult}:{})};
  }finally{releaseExecutionLock(lease);}
}
