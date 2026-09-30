import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {loadRuntimeConfig} from './runtime-config.mjs';
import {runLegacyEngine} from './legacy-engine.mjs';
import {runPtSite,projectPtSiteResult} from './pt-site-execution.mjs';
import {siteIdentityIndex} from './site-identity-index.mjs';
import {ptAttemptReconciled} from './pt-reconciliation.mjs';
import {currentPassivePtResult,recordPtVerification} from './pt-verification.mjs';

const dayAt=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);
const originOf=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}};
const terminal=new Set(['signed','already_signed']);
const failures=new Set(['failed','not_signed']);

function confirmedSupplement(report,origin,businessDate,now){
  const site=report?.sites?.find(item=>originOf(item?.origin)===origin);
  const at=Date.parse(site?.observedAt??'');
  return Boolean(site&&terminal.has(site.status)&&site.evidence?.authoritative===true&&
    ['pt_page','page_text','api','usage_log'].includes(site.evidence?.source)&&
    Number.isFinite(at)&&at<=now.getTime()+60_000&&dayAt(new Date(at))===businessDate);
}

export function planHarvestFallback({harvest,catalog,plan,latest,fallbackReport=null,config={},now=new Date(),fallbackOnlyEnabled=false}={}) {
  const businessDate=dayAt(now),eligible=[],blocked=[];let observedSuccess=0;
  if(harvest?.source!=='harvest'||harvest.businessDate!==businessDate||!Array.isArray(harvest.sites)||
     !Number.isFinite(Date.parse(harvest.generatedAt))||Date.parse(harvest.generatedAt)>now.getTime()+60_000||
     now.getTime()-Date.parse(harvest.generatedAt)>30*60_000)throw Error('Harvest report is stale or invalid');
  if(!Array.isArray(catalog?.sites)||!Array.isArray(plan?.targets)||!Array.isArray(latest?.results))throw Error('execution plan or catalog missing');
  if(fallbackReport&&(fallbackReport.source!=='execution-supplement'||fallbackReport.businessDate!==businessDate||
     !Array.isArray(fallbackReport.sites)))throw Error('PT supplement report has the wrong source or date');
  const currentV1=latest.runState==='final'&&latest.isComplete===true&&String(latest.runId??'').startsWith(businessDate.replaceAll('-','')+'-');
  const doneAt=Date.parse(harvest.taskCompletion?.completedAt),startedAt=Date.parse(harvest.taskCompletion?.startedAt);
  const harvestCompleted=harvest.taskCompletion?.status==='completed'&&Number.isInteger(harvest.taskCompletion.resultId)&&
    Number.isFinite(startedAt)&&Number.isFinite(doneAt)&&startedAt<=doneAt&&doneAt<=now.getTime()+60_000&&
    dayAt(new Date(startedAt))===businessDate&&dayAt(new Date(doneAt))===businessDate;
  const catalogByOrigin=new Map();
  for(const site of catalog.sites){
    const origin=originOf(site?.origin);
    if(!origin||catalogByOrigin.has(origin))throw Error('PT catalog has an invalid or duplicate origin');
    catalogByOrigin.set(origin,site);
  }
  const catalogOrigins=new Set(catalogByOrigin.keys());
  const siteIndex=siteIdentityIndex({catalog,planTargets:plan.targets});
  const registered=plan.targets.filter(target=>siteIndex.get(originOf(target.origin))?.kind==='pt');
  const observations=new Map(),assessments=[];
  const block=(origin,reason)=>{blocked.push({origin,reason});assessments.push({origin,state:'blocked',reason});};
  for(const site of harvest.sites){
    const origin=originOf(site?.origin);
    if(!origin||observations.has(origin)){block(origin??null,'invalid_or_duplicate_origin');continue;}
    observations.set(origin,site);
  }
  for(const target of registered){
    const origin=originOf(target.origin);
    if(origin&&!observations.has(origin))observations.set(origin,{origin,status:'unknown',missingFromHarvest:true});
  }
  for(const origin of catalogOrigins){
    if(!observations.has(origin))observations.set(origin,{origin,status:'unknown',missingFromHarvest:true});
  }
  for(const [origin,site] of observations){
    if(confirmedSupplement(fallbackReport,origin,businessDate,now)){
      assessments.push({origin,state:'confirmed_by_executor_supplement'});continue;
    }
    const confirmedAt=Date.parse(site.observedAt);
    const confirmed=terminal.has(site.status)&&site.evidence?.authoritative===true&&Number.isFinite(confirmedAt)&&dayAt(new Date(confirmedAt))===businessDate;
    if(confirmed){observedSuccess++;assessments.push({origin,state:'confirmed_by_harvest'});continue;}
    const status=terminal.has(site.status)?'unknown':site.status;
    if(!failures.has(status)&&status!=='unknown')continue;
    if(!harvestCompleted){block(origin,'harvest_task_not_complete');continue;}
    const at=status==='unknown'?doneAt:Date.parse(site.observedAt);
    if(!Number.isFinite(at)||at>now.getTime()+60_000||dayAt(new Date(at))!==businessDate||
       now.getTime()-at>26*3600_000){block(origin,'stale_failure');continue;}
    if(!catalogOrigins.has(origin)&&!registered.some(target=>originOf(target.origin)===origin)){
      block(origin,'outside_confirmed_bookmark_scope');continue;
    }
    if(!currentV1){block(origin,'v1_day_not_ready');continue;}
    const targets=registered.filter(t=>originOf(t.origin)===origin);
    if(targets.length>1){block(origin,'ambiguous_legacy_account');continue;}
    const target=targets[0],accountKey=target?.accountKey??'site-default';
    if(!target&&!fallbackOnlyEnabled){block(origin,'fallback_only_not_enabled');continue;}
    if((config.disabledCheckinOrigins??[]).includes(origin)||(config.disabledAccountKeys??[]).includes(accountKey)||
       (config.excludedOrigins??[]).includes(origin)){
      block(origin,'disabled_by_v1_configuration');continue;
    }
    let entryUrl=null;
    if(!target){
      entryUrl=catalogByOrigin.get(origin)?.entryUrl;
      try {
        const url=new URL(entryUrl);
        if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.search||url.hash||entryUrl.length>255)throw Error('invalid entry');
      } catch {block(origin,'fallback_entry_missing_or_unsafe');continue;}
    }
    const prior=latest.results.find(r=>r.origin===origin&&(r.accountKey??'site-default')===accountKey);
    if(prior&&terminal.has(prior.status)){assessments.push({origin,state:'confirmed_by_executor'});continue;}
    if(prior?.status==='not_available'){
      block(origin,'v1_feature_or_task_unavailable');continue;
    }
    if(prior?.failureCode==='submission_outcome_unknown'){
      block(origin,'submission_outcome_unknown');continue;
    }
    eligible.push({origin,accountKey,businessDate,kind:target?'registered':'fallback_only',...(entryUrl?{entryUrl}:{}),observedAt:new Date(at).toISOString(),
      trigger:site.missingFromHarvest?(target?'registered_pt_status_unobserved':'monitored_pt_status_unobserved'):
        status==='unknown'?'harvest_task_done_status_unknown':'harvest_explicit_failure'});
    assessments.push({origin,state:'executor_recheck_queued'});
  }
  return {schemaVersion:1,businessDate,source:'harvest',observedSuccess,registeredCount:registered.length,
    fallbackOnlyCount:[...catalogOrigins].filter(origin=>!registered.some(target=>originOf(target.origin)===origin)).length,
    assessments,eligible,blocked};
}

function writeAtomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.tmp`;fs.writeFileSync(temporary,JSON.stringify(value,null,2),{encoding:'utf8',mode:0o600});fs.renameSync(temporary,file);}

function readAttemptState(root,businessDate){
  const file=path.join(root,'outputs',`harvest-fallback-attempts-${businessDate}.json`);
  const state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):
    {schemaVersion:1,businessDate,attempts:[]};
  if(state.businessDate!==businessDate||!Array.isArray(state.attempts))throw Error('Harvest fallback audit is invalid');
  return {file,state};
}

const recoveryIdentity=candidate=>`${candidate.origin}#account=${encodeURIComponent(candidate.accountKey)}`;
const retryableWithoutSubmission=(item,candidate,recoveredAtByAccount,now)=>item.origin===candidate.origin&&
  (item.accountKey??'site-default')===candidate.accountKey&&
  item.state==='completed'&&item.v1Status==='login_required'&&
  item.submissionState==='not_submitted'&&item.recoveryEligible===true&&
  item.businessDate===candidate.businessDate&&
  Number.isFinite(Date.parse(recoveredAtByAccount?.[recoveryIdentity(candidate)]))&&
  Date.parse(recoveredAtByAccount[recoveryIdentity(candidate)])>Date.parse(item.finishedAt??item.startedAt)&&
  Date.parse(recoveredAtByAccount[recoveryIdentity(candidate)])<=now.getTime()&&
  now.getTime()-Date.parse(recoveredAtByAccount[recoveryIdentity(candidate)])<=30*60_000&&
  now.getTime()-Date.parse(item.finishedAt??item.startedAt)>=60_000&&
  dayAt(new Date(recoveredAtByAccount[recoveryIdentity(candidate)]))===candidate.businessDate;
const alreadyAttempted=(state,candidate,recoveredAtByAccount={},now=new Date())=>{
  const attempts=state.attempts.filter(item=>item.origin===candidate.origin&&
    (item.accountKey??'site-default')===candidate.accountKey);
  // A recovery signal wakes a bounded read-only recheck. It does not prove login.
  if(attempts.filter(item=>!['deferred_busy','deferred_preflight'].includes(item.state)).length>=3)return true;
  return attempts.some(item=>item.origin===candidate.origin&&
  (item.accountKey??'site-default')===candidate.accountKey&&
  (['deferred_busy','deferred_preflight'].includes(item.state)?
    Date.parse(item.nextEligibleAt??'')>now.getTime():
    !retryableWithoutSubmission(item,candidate,recoveredAtByAccount,now)));
};

function unresolvedEarlierAttempt(root,candidate){
  const directory=path.join(root,'outputs');
  if(!fs.existsSync(directory))return false;
  for(const name of fs.readdirSync(directory)){
    const match=/^harvest-fallback-attempts-([0-9]{4}-[0-9]{2}-[0-9]{2})[.]json$/.exec(name);
    if(!match||match[1]>=candidate.businessDate)continue;
    const {state}=readAttemptState(root,match[1]);
    if(state.attempts.some((item,index)=>item.origin===candidate.origin&&
      (item.accountKey??'site-default')===candidate.accountKey&&
      !ptAttemptReconciled(state,item,index)&&
      (['in_progress','outcome_unknown','completed_cross_day'].includes(item.state)||
       item.outcome?.submissionOutcomeUnknown===true||item.outcome?.failureCode==='submission_outcome_unknown')))return true;
  }
  return false;
}

function passiveVerificationDue(state,candidate,readOnlyOrigins,now){
  if(candidate.kind!=='fallback_only'||!readOnlyOrigins.includes(candidate.origin))return false;
  const probes=(state.verifications??[]).filter(v=>v.origin===candidate.origin&&(v.accountKey??'site-default')===candidate.accountKey);
  return probes.length<3&&probes.every(v=>now.getTime()-Date.parse(v.startedAt)>=30*60_000);
}

export function pendingHarvestFallbackAttempts(root,preview,{recoveredAtByAccount={},readOnlyOrigins=[],now=new Date()}={}){
  const {state}=readAttemptState(root,preview.businessDate);
  return preview.eligible.filter(candidate=>candidate.kind==='fallback_only'&&readOnlyOrigins.includes(candidate.origin)
    ?passiveVerificationDue(state,candidate,readOnlyOrigins,now)
    :!alreadyAttempted(state,candidate,recoveredAtByAccount,now)&&!unresolvedEarlierAttempt(root,candidate));
}

function claimWorker(root) {
  return acquireExecutionLock(root,{name:'harvest-fallback.lock'});
}

export async function runHarvestFallback({root=path.resolve('.'),harvest,catalog,plan,latest,fallbackReport=null,config={},now=new Date(),execute=false,
  catalogFile=null,catalogHash=null,fallbackOnlyEnabled=false,runEngine=runLegacyEngine,runSite=runPtSite,
  clock=()=>new Date(),refreshHarvest=null,recoveredAtByAccount={},readOnlyOrigins=[]}={}) {
  const preview=planHarvestFallback({harvest,catalog,plan,latest,fallbackReport,config,now,fallbackOnlyEnabled});
  if(!execute)return {...preview,mode:'preview'};
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('Harvest fallback requires the V1 execution engine');
  const integration=JSON.parse(fs.readFileSync(path.join(runtime.legacyRoot,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||path.resolve(integration.v2ProjectRoot)!==path.resolve(root))throw Error('Harvest fallback engine bindings disagree');
  if(preview.eligible.some(item=>item.kind==='fallback_only')&&(!catalogFile||!/^[a-f0-9]{64}$/i.test(catalogHash??'')))throw Error('PT fallback needs the bound bookmark catalog');
  if(!preview.eligible.length)return {...preview,mode:'executed',outcomes:[]};
  const workerLock=claimWorker(root);
  try{
  const {file:stateFile,state}=readAttemptState(root,preview.businessDate);
  const outcomes=[];
  const statusFile=path.join(root,'outputs',`pt-fallback-results-${preview.businessDate}.json`);
  for(const candidate of preview.eligible){
    const candidateNow=clock();
    if(dayAt(candidateNow)!==preview.businessDate){outcomes.push({origin:candidate.origin,state:'business_day_changed'});break;}
    const attempted=alreadyAttempted(state,candidate,recoveredAtByAccount,candidateNow);
    const historicalUnknown=unresolvedEarlierAttempt(root,candidate);
    const canVerify=passiveVerificationDue(state,candidate,readOnlyOrigins,candidateNow);
    if(candidate.kind==='fallback_only'&&readOnlyOrigins.includes(candidate.origin)&&!canVerify){
      outcomes.push({origin:candidate.origin,state:'passive_verification_cooldown'});continue;
    }
    if(attempted&&!canVerify){outcomes.push({origin:candidate.origin,state:'already_attempted'});continue;}
    if(historicalUnknown&&!canVerify){outcomes.push({origin:candidate.origin,state:'prior_outcome_unknown'});continue;}
    let currentSupplement=null;
    if(fs.existsSync(statusFile)){
      currentSupplement=JSON.parse(fs.readFileSync(statusFile,'utf8'));
      if(currentSupplement.source!=='execution-supplement'||currentSupplement.businessDate!==preview.businessDate||
        !Array.isArray(currentSupplement.sites))throw Error('PT status audit is invalid');
    }
    if(confirmedSupplement(currentSupplement,candidate.origin,preview.businessDate,clock())){
      outcomes.push({origin:candidate.origin,state:'already_confirmed'});continue;
    }
    if(refreshHarvest){
      let live;
      try{
        live=await refreshHarvest();
        const livePreview=planHarvestFallback({harvest:live,catalog,plan,latest,
          fallbackReport:currentSupplement,config,now:clock(),fallbackOnlyEnabled});
        if(live.taskCompletion?.resultId!==harvest.taskCompletion?.resultId||
           live.taskCompletion?.completedAt!==harvest.taskCompletion?.completedAt){
          outcomes.push({origin:candidate.origin,state:'harvest_task_changed'});
          break;
        }
        if(!livePreview.eligible.some(item=>item.origin===candidate.origin&&
          item.accountKey===candidate.accountKey&&item.kind===candidate.kind)){
          outcomes.push({origin:candidate.origin,state:'harvest_status_changed'});
          continue;
        }
      }catch{
        outcomes.push({origin:candidate.origin,state:'harvest_refresh_unavailable'});
        break;
      }
    }
    let recoveryEvidence=null;
    if(canVerify){
      const verification={origin:candidate.origin,accountKey:candidate.accountKey,startedAt:clock().toISOString(),state:'in_progress'};
      state.verifications??=[];state.verifications.push(verification);writeAtomic(stateFile,state);
      try{
        const checked=currentPassivePtResult(await runSite({root,origin:candidate.origin,catalogFile,catalogHash,readOnly:true}),clock());
        if(checked.accountKey!==candidate.accountKey)throw Error('passive account mismatch');
        verification.outcome=checked;verification.state='completed';verification.finishedAt=clock().toISOString();
        recordPtVerification(root,checked,{now:clock(),lockHeld:true});writeAtomic(stateFile,state);
        if(['signed','already_signed'].includes(checked.status)){
          outcomes.push({origin:candidate.origin,state:'confirmed_by_passive_read',v1Status:checked.status});continue;
        }
        if(checked.status!=='not_signed'||checked.evidence?.authoritative!==true||
          checked.evidence.statusSignal!=='nexus_daily_header_unsigned'){
          outcomes.push({origin:candidate.origin,state:'passive_result_unverified',v1Status:checked.status});continue;
        }
        // This does not close or relabel historical uncertainty. A fresh, bound
        // daily-state observation permits only this day's guarded attempt.
        recoveryEvidence=checked;
        if(state.attempts.filter(a=>a.origin===candidate.origin&&!['deferred_busy','deferred_preflight'].includes(a.state)).length>=3){
          outcomes.push({origin:candidate.origin,state:'daily_attempt_limit'});continue;
        }
      }catch{
        verification.state='unverified';verification.finishedAt=clock().toISOString();writeAtomic(stateFile,state);
        outcomes.push({origin:candidate.origin,state:'passive_verification_unavailable'});continue;
      }
    }
    if(canVerify&&dayAt(clock())!==preview.businessDate){outcomes.push({origin:candidate.origin,state:'business_day_changed'});break;}
    // Persist before executing. No uncertain attempt is retried without a new
    // authoritative read, followed by another read inside the executor lock.
    const attempt={attemptId:crypto.randomUUID(),origin:candidate.origin,accountKey:candidate.accountKey,businessDate:preview.businessDate,
      observedAt:candidate.observedAt,startedAt:candidateNow.toISOString(),state:'in_progress'};
    if(recoveryEvidence)attempt.recoveryEvidence=recoveryEvidence;
    if(Number.isFinite(Date.parse(recoveredAtByAccount[recoveryIdentity(candidate)])))
      attempt.recoveredAt=recoveredAtByAccount[recoveryIdentity(candidate)];
    state.attempts.push(attempt);writeAtomic(stateFile,state);
    try{
      if(candidate.kind==='fallback_only'){
        const result=projectPtSiteResult(await runSite({root,origin:candidate.origin,catalogFile,catalogHash,
          verifyBeforeSubmit:Boolean(recoveryEvidence)}),candidate.origin);
        const receivedAt=clock();
        // Keep the redacted receipt before later validation or publication.
        attempt.outcome=result;
        attempt.finishedAt=receivedAt.toISOString();
        attempt.resultObservedAt=result.observedAt;
        attempt.resultBusinessDate=dayAt(new Date(result.observedAt));
        attempt.v1Status=result.status;
        if(result.retryCause==='harvest_waiting'&&result.submissionAttempted===false){
          attempt.state='deferred_preflight';attempt.submissionState='not_submitted';
          attempt.nextEligibleAt=result.nextEligibleAt??new Date(receivedAt.getTime()+30*60_000).toISOString();
        }
        writeAtomic(stateFile,state);
        if(Date.parse(result.observedAt)>receivedAt.getTime()+60_000||
           Date.parse(result.observedAt)<Date.parse(attempt.startedAt)-60_000)
          throw Error('PT site result timestamp is stale or in the future');
        if(attempt.resultBusinessDate!==preview.businessDate||dayAt(receivedAt)!==preview.businessDate){
          attempt.state='completed_cross_day';
          attempt.reason='Receipt preserved; read-only reconciliation required after business-day change';
          writeAtomic(stateFile,state);
          outcomes.push({origin:candidate.origin,state:attempt.state,v1Status:attempt.v1Status});
          break;
        }
        let report={schemaVersion:1,source:'execution-supplement',businessDate:preview.businessDate,generatedAt:now.toISOString(),sites:[]};
        if(fs.existsSync(statusFile)){
          report=JSON.parse(fs.readFileSync(statusFile,'utf8'));
          if(report.source!=='execution-supplement'||report.businessDate!==preview.businessDate||!Array.isArray(report.sites))throw Error('PT status audit is invalid');
        }
        report.generatedAt=receivedAt.toISOString();
        report.sites=report.sites.filter(site=>site.origin!==candidate.origin);
        report.sites.push(result);writeAtomic(statusFile,report);
        attempt.v1Status=result.status;
        if(result.status==='login_required'&&result.submissionAttempted===false){
          attempt.submissionState='not_submitted';
          attempt.recoveryEligible=true;
        }
      }else{
        const report=await runEngine({root,mode:'execute',origins:[candidate.origin],accountKeys:[candidate.accountKey],notify:false});
        attempt.finishedAt=clock().toISOString();
        attempt.runId=report.runId??null;
        const result=report.results?.find(r=>r.origin===candidate.origin&&(r.accountKey??'site-default')===candidate.accountKey);
        attempt.outcome=result?{origin:candidate.origin,accountKey:candidate.accountKey,
          status:result.status,submissionAttempted:result.submissionAttempted??null,
          failureCode:result.failureCode??null,evidence:result.evidence??null}:null;
        writeAtomic(stateFile,state);
        attempt.v1Status=result?.status??'unknown';
        if(result?.retryCause==='harvest_waiting'&&result.submissionAttempted===false){
          attempt.state='deferred_preflight';attempt.submissionState='not_submitted';
          attempt.nextEligibleAt=result.nextEligibleAt??new Date(Date.parse(attempt.finishedAt)+30*60_000).toISOString();
        }
        if(dayAt(new Date(attempt.finishedAt))!==preview.businessDate){
          attempt.state='completed_cross_day';
          attempt.reason='Engine report preserved; read-only reconciliation required after business-day change';
          writeAtomic(stateFile,state);
          outcomes.push({origin:candidate.origin,state:attempt.state,v1Status:attempt.v1Status});
          break;
        }
        if(result?.status==='login_required'&&result.submissionAttempted===false){
          attempt.submissionState='not_submitted';
          attempt.recoveryEligible=true;
        }
      }
      attempt.finishedAt??=clock().toISOString();
      if(attempt.state==='in_progress')attempt.state='completed';
    }catch(error){
      attempt.finishedAt??=clock().toISOString();
      attempt.state=error.code==='PT_PREFLIGHT'?'deferred_preflight':error.message==='V2 runner is already active'?'deferred_busy':'outcome_unknown';
      attempt.reason=String(error.message).slice(0,120);
    }
    writeAtomic(stateFile,state);
    outcomes.push({origin:candidate.origin,state:attempt.state,v1Status:attempt.v1Status??null});
  }
  return {...preview,mode:'executed',outcomes};
  }finally{releaseExecutionLock(workerLock);}
}

export function loadHarvestFallbackInputs({root,reportFile,catalogFile}={}) {
  const legacyRoot=loadRuntimeConfig(root).legacyRoot;
  if(!legacyRoot)throw Error('legacy root is required');
  const day=dayAt(new Date());
  const supplementFile=path.join(root,'outputs',`pt-fallback-results-${day}.json`);
  return {harvest:JSON.parse(fs.readFileSync(reportFile,'utf8')),
    catalog:JSON.parse(fs.readFileSync(catalogFile,'utf8')),
    plan:JSON.parse(fs.readFileSync(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'),'utf8')),
    config:JSON.parse(fs.readFileSync(path.join(legacyRoot,'config/config.json'),'utf8')),
    latest:JSON.parse(fs.readFileSync(path.join(legacyRoot,'logs/latest.json'),'utf8')),
    fallbackReport:fs.existsSync(supplementFile)?JSON.parse(fs.readFileSync(supplementFile,'utf8')):null};
}
