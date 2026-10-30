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
import {ptCapabilities} from './pt-capabilities.mjs';
import {canonicalPtOrigin,harvestSiteAssignment,harvestTaskCompleted,harvestTaskFailed} from './pt-coordination.generated.mjs';
import {withCurrentPtCatalog} from './pt-catalog.mjs';

const dayAt=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);
const originOf=value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&u.pathname==='/'&&!u.search&&!u.hash?canonicalPtOrigin(u.origin):null;}catch{return null;}};
const terminal=new Set(['signed','already_signed']);
const failures=new Set(['failed','not_signed']);

export function resolvedFallbackReadConfig(catalog,config,readPolicy){
  const policies={...(config.ptReadOnlyPolicies??{})};
  for(const site of catalog?.sites??[]){
    try{
      const policy=readPolicy(site.origin);
      if(policy.reviewed===true&&policy.mode==='safe_history_page')policies[site.origin]=policy;
    }catch{/* Preserve explicit private denials and unsupported capabilities. */}
  }
  return {...config,ptReadOnlyPolicies:policies};
}

export function reviewedFallbackReadOrigins(catalog,readPolicy){
  return (catalog?.sites??[]).filter(site=>{
    try{
      const policy=readPolicy(site.origin);
      return policy.reviewed===true&&policy.mode==='safe_history_page'&&
        ptCapabilities(site.origin,policy).guardedSubmit;
    }catch{return false;}
  }).map(site=>site.origin);
}

function verifiedGuardedRecovery(checked,candidate,now,{readOnlyOrigins}){
  const evidence=checked?.evidence,at=Date.parse(evidence?.confirmedAt??'');
  const signal=evidence?.statusSignal;
  return candidate.guardedSubmit===true&&
    checked.origin===candidate.origin&&checked.accountKey===candidate.accountKey&&
    checked.status==='not_signed'&&checked.submissionAttempted===false&&
    checked.operationMode==='safe_history_page'&&checked.readSafety==='reviewed_passive'&&
    /^[a-f0-9]{64}$/.test(checked.profileBinding??'')&&
    evidence?.authoritative===true&&evidence.evidenceScope==='site_account_day'&&
    checked.businessDate===candidate.businessDate&&evidence.businessDate===candidate.businessDate&&
    Number.isFinite(at)&&at<=now.getTime()&&now.getTime()-at<=5*60_000&&
     ((candidate.origin==='https://open.cd'&&signal==='open_cd_daily_unsigned')||
      (candidate.kind==='registered_review'&&signal==='nexus_daily_header_unsigned')||
      (candidate.kind==='fallback_only'&&readOnlyOrigins.includes(candidate.origin)&&
        (signal==='nexus_daily_header_unsigned'||['https://www.hddolby.com','https://www.uhddolby.com'].includes(candidate.origin)&&
          signal==='hddolby_account_header_unsigned'&&evidence.pagePath==='/log.php'&&now.getTime()-at<=30_000)));
}

function reviewedNativeExecutor(candidate,config){
  const policy=config.ptReadOnlyPolicies?.[candidate.origin];
  return candidate.kind==='registered_review'&&candidate.accountKey==='site-default'&&policy?.reviewed===true&&
    policy.mode==='safe_history_page'&&policy.url===candidate.origin+'/index.php'&&
    ((policy.nativeIsolatedChrome===true&&policy.nativeMainChrome!==true)||
     (policy.nativeMainChrome===true&&policy.nativeIsolatedChrome!==true));
}

function recoverableUnsubmittedProfileGuard(attempt,candidate,checked,now,options){
  const prior=attempt.recoveryEvidence,result=attempt.outcome;
  const started=Date.parse(attempt.startedAt??''),finished=Date.parse(attempt.finishedAt??'');
  const priorAt=Date.parse(prior?.evidence?.confirmedAt??''),currentAt=Date.parse(checked?.evidence?.confirmedAt??'');
  const resultAt=Date.parse(result?.observedAt??''),priorObserved=Date.parse(prior?.observedAt??'');
  // This exception repairs only the former generic-profile pre-read. It never
  // forgives an unknown write or a mismatch returned by the native executor.
  return reviewedNativeExecutor(candidate,options.config??{})&&attempt.nativeRegisteredEngine!==true&&attempt.state==='completed'&&
    /^[a-f0-9-]{36}$/.test(attempt.attemptId??'')&&
    attempt.origin===candidate.origin&&attempt.accountKey===candidate.accountKey&&attempt.businessDate===candidate.businessDate&&
    result?.origin===candidate.origin&&result.accountKey===candidate.accountKey&&result.businessDate===candidate.businessDate&&
    result.status==='needs_attention'&&result.failureCode==='authoritative_status_unavailable'&&
    result.submissionAttempted===false&&result.submissionOutcomeUnknown!==true&&
    /^[a-f0-9]{64}$/.test(result.profileBinding??'')&&result.profileBinding!==prior?.profileBinding&&
    Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started&&dayAt(new Date(started))===candidate.businessDate&&
    dayAt(new Date(finished))===candidate.businessDate&&Number.isFinite(resultAt)&&resultAt>=started-60_000&&resultAt<=finished+60_000&&
    Number.isFinite(priorObserved)&&Math.abs(priorObserved-priorAt)<=60_000&&
    verifiedGuardedRecovery(prior,candidate,new Date(started),options)&&
    verifiedGuardedRecovery(checked,candidate,now,options)&&checked.profileBinding===prior.profileBinding&&
    priorAt<=started&&currentAt>finished;
}

function interruptedBoundAttemptBeforeProof(attempt,candidate,checked,now,options){
  // A killed observer can leave only its pre-dispatch proof. Recover through
  // a new bound unsigned read, never by treating a missing receipt as failure.
  // The worker must be gone; the engine and browser leases are still required.
  if(!['in_progress','outcome_unknown'].includes(attempt.state)||attempt.outcome!==undefined||
     !/^[a-f0-9-]{36}$/.test(attempt.attemptId??'')||
     attempt.origin!==candidate.origin||attempt.accountKey!==candidate.accountKey||
     attempt.businessDate!==candidate.businessDate||!Number.isSafeInteger(attempt.workerPid)||attempt.workerPid<=0)return false;
  try{process.kill(attempt.workerPid,0);return false;}catch(error){if(error.code!=='ESRCH')return false;}
  const started=Date.parse(attempt.startedAt),finished=Date.parse(attempt.finishedAt??attempt.startedAt);
  const proofAt=Date.parse(checked.evidence?.confirmedAt??'');
  const previous=attempt.recoveryEvidence;
  const boundPrevious=previous&&checked.profileBinding===previous.profileBinding&&
    verifiedGuardedRecovery(previous,candidate,new Date(started),options);
  // An explicit one-site operator request may introduce a newly reviewed
  // reader after an old observer died before obtaining its first proof. This
  // authorizes the current bound account only; it does not close the old audit.
  const newManualReader=options.manualRecovery===true&&previous===undefined;
  return Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started&&
    dayAt(new Date(started))===candidate.businessDate&&dayAt(new Date(finished))===candidate.businessDate&&
    proofAt>finished&&(boundPrevious||newManualReader)&&
    verifiedGuardedRecovery(checked,candidate,now,options);
}

function confirmedSupplement(report,origin,businessDate,now){
  const site=report?.sites?.find(item=>originOf(item?.origin)===origin);
  const at=Date.parse(site?.observedAt??'');
  if(!site||!terminal.has(site.status)||site.evidence?.authoritative!==true||
    !['pt_page','page_text','api','usage_log'].includes(site.evidence?.source)||
    !Number.isFinite(at)||at>now.getTime()+60_000||dayAt(new Date(at))!==businessDate)return false;
  // A supplement is allowed to suppress a duplicate only when it is either
  // an explicit reviewed passive PT receipt (legacy reports may omit the
  // optional binding fields), or it carries the complete current account/day
  // binding.  A bare page-text success from a write attempt is not enough to
  // close the attempt: it must remain eligible for the normal bounded audit.
  const exactBinding=typeof site.accountKey==='string'&&/^[A-Za-z0-9._-]{1,80}$/.test(site.accountKey)&&
    /^[a-f0-9]{64}$/.test(site.profileBinding??'')&&site.businessDate===businessDate&&
    site.evidence?.businessDate===businessDate&&site.evidence?.evidenceScope==='site_account_day';
  const legacyPassive=site.evidence?.source==='pt_page';
  return exactBinding||legacyPassive;
}

export function planHarvestFallback({harvest,catalog,plan,latest,fallbackReport=null,config={},now=new Date(),fallbackOnlyEnabled=false,readOnlyOrigins=[]}={}) {
  const businessDate=dayAt(now),eligible=[],blocked=[];let observedSuccess=0;
  const reviewedOrigins=new Set(readOnlyOrigins.map(originOf).filter(Boolean));
  if(harvest?.source!=='harvest'||harvest.businessDate!==businessDate||!Array.isArray(harvest.sites)||
     !Number.isFinite(Date.parse(harvest.generatedAt))||Date.parse(harvest.generatedAt)>now.getTime()+60_000||
     now.getTime()-Date.parse(harvest.generatedAt)>30*60_000)throw Error('Harvest report is stale or invalid');
  if(!Array.isArray(catalog?.sites)||!Array.isArray(plan?.targets)||!Array.isArray(latest?.results))throw Error('execution plan or catalog missing');
  if(fallbackReport&&(fallbackReport.source!=='execution-supplement'||fallbackReport.businessDate!==businessDate||
     !Array.isArray(fallbackReport.sites)))throw Error('PT supplement report has the wrong source or date');
  const currentV1=latest.runState==='final'&&latest.isComplete===true&&String(latest.runId??'').startsWith(businessDate.replaceAll('-','')+'-');
  const harvestCompleted=harvestTaskCompleted(harvest,businessDate,now);
  const harvestFailed=harvestTaskFailed(harvest,businessDate,now);
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
    const assignment=harvestSiteAssignment(harvest,origin);
    if(assignment.owner==='ambiguous'){
      if(!blocked.some(item=>item.origin===origin))block(origin,'harvest_assignment_unverified');
      continue;
    }
    const targets=registered.filter(t=>originOf(t.origin)===origin);
    if(assignment.owner==='unknown'){
      if(!blocked.some(item=>item.origin===origin))block(origin,'harvest_assignment_unverified');
      continue;
    }
    const confirmedAt=Date.parse(site.observedAt);
    const confirmed=terminal.has(site.status)&&site.evidence?.authoritative===true&&Number.isFinite(confirmedAt)&&dayAt(new Date(confirmedAt))===businessDate;
    if(confirmed){observedSuccess++;assessments.push({origin,state:'confirmed_by_harvest'});continue;}
    const status=terminal.has(site.status)?'unknown':String(site.status??'unknown').trim().toLowerCase()||'unknown';
    const externalCondition=site.siteCondition==='site_maintenance'||
      ['site_maintenance','maintenance','tls_certificate_invalid','tls_handshake_failed','unreachable','external','error'].includes(status)||
      ['site_maintenance','tls_certificate_invalid','tls_handshake_failed','site_server_error','upstream_unavailable'].includes(String(site.failureCode??''));
    if(externalCondition){
      blocked.push({origin,reason:'external_condition',external:true});
      assessments.push({origin,state:'external_condition',reason:'external_condition'});
      continue;
    }
    const unconfirmedStatuses=new Set([...failures,'unknown','pending','running','queued','started','progress','retry','in_progress']);
    if(!unconfirmedStatuses.has(status))continue;
    const registeredTarget=targets.length===1;
    // A monitored fallback-only origin still waits for Harvest's completed or
    // failed task because it has no registered V1 execution owner. A precise
    // registered PT target is released immediately from any non-terminal
    // Harvest state, including a pending or missing site record.
    // A catalog-only site with a reviewed passive reader can be released from
    // Harvest's pending gate. It must still prove the current bound account is
    // unsigned before the execution layer is allowed to submit. Without that
    // capability the mature fallback remains gated until Harvest finishes.
    if(!registeredTarget&&assignment.owner==='harvest'&&!harvestCompleted&&!harvestFailed&&
       !reviewedOrigins.has(origin)){
      // Keep catalog-only observations out of the Harvest waiting queue. A
      // private fallback opt-in without a reviewed passive reader remains a
      // safe capability block; a site outside that opt-in is monitor-only.
      block(origin,fallbackOnlyEnabled?'fallback_only_reader_unreviewed':'monitor_only_unconfirmed');
      continue;
    }
    const observedAt=Date.parse(site.observedAt);
    const at=['unknown','pending','running','queued','started','progress','retry','in_progress'].includes(status)||!Number.isFinite(observedAt)
      ?now.getTime():observedAt;
    if(!Number.isFinite(at)||at>now.getTime()+60_000||dayAt(new Date(at))!==businessDate||
       now.getTime()-at>26*3600_000){block(origin,'stale_failure');continue;}
    if(!catalogOrigins.has(origin)&&!registered.some(target=>originOf(target.origin)===origin)){
      block(origin,'outside_confirmed_bookmark_scope');continue;
    }
    if(!currentV1){block(origin,'v1_day_not_ready');continue;}
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
    const supplement=fallbackReport?.sites?.find(item=>originOf(item.origin)===origin&&
      (item.accountKey??'site-default')===accountKey&&Number.isFinite(Date.parse(item.observedAt))&&
      dayAt(new Date(item.observedAt))===businessDate&&Date.parse(item.observedAt)<=now.getTime()+60_000);
    if([prior,supplement].some(item=>[item?.failureCode,item?.underlyingFailureCode]
      .some(code=>['site_migration','bookmark_origin_changed'].includes(code)))){
      blocked.push({origin,reason:'external_condition',external:true});
      assessments.push({origin,state:'external_condition',reason:'external_condition'});continue;
    }
    if(target&&prior?.failureCode==='submission_outcome_unknown'&&prior.submissionAttempted===true){
      // A registered PT whose write result is unknown must not be submitted
      // again by Harvest fallback. Queue a bounded passive review instead;
      // the review may only produce a readback receipt or a structured
      // inconclusive diagnostic.
      eligible.push({origin,accountKey,businessDate,kind:'registered_review',readOnlyReview:true,guardedSubmit:true,
        observedAt:new Date(at).toISOString(),trigger:'submission_unknown_readonly_review'});
      assessments.push({origin,state:'readonly_recheck_queued',reason:'submission_outcome_unknown'});
      continue;
    }
    if(prior?.failureCode==='submission_outcome_unknown'){
      // Without an explicit non-submission fact, retain the original
      // quarantine rather than treating a malformed result as retryable.
      block(origin,'submission_outcome_unknown');continue;
    }
    const guardedPassive=target?true:reviewedOrigins.has(origin);
    eligible.push({origin,accountKey,businessDate,kind:target?'registered_review':'fallback_only',
      ...(target?{guardedSubmit:true}:guardedPassive?{guardedSubmit:true,readOnlyReview:true}:{}),
      ...(entryUrl?{entryUrl}:{}),observedAt:new Date(at).toISOString(),
      trigger:target?(harvestFailed?'harvest_task_failed':'harvest_status_unconfirmed'):
        (harvestFailed?'harvest_task_failed':site.missingFromHarvest?'monitored_pt_status_unobserved':
          status==='unknown'?'harvest_task_done_status_unknown':'harvest_explicit_failure')});
    assessments.push({origin,state:'executor_recheck_queued'});
  }
  for(const candidate of eligible){
    const values=(fallbackReport?.sites??[]).filter(item=>originOf(item.origin)===candidate.origin&&
      (item.accountKey??'site-default')===candidate.accountKey);
    if(candidate.guardedSubmit!==true||values.length!==1)continue;
    const value=values[0],proof=value.evidence,at=Date.parse(proof?.confirmedAt??''),observed=Date.parse(value.observedAt??'');
    // A recent bound negative is a signal to renew the passive check, never
    // permission to submit from an old proof. The executor still reads again.
    if(fallbackReport.source==='execution-supplement'&&fallbackReport.businessDate===businessDate&&
       value.status==='not_signed'&&value.submissionAttempted===false&&value.operationMode==='safe_history_page'&&
       value.readSafety==='reviewed_passive'&&value.businessDate===businessDate&&proof?.authoritative===true&&
       proof.businessDate===businessDate&&proof.evidenceScope==='site_account_day'&&
       /^[a-f0-9]{64}$/.test(value.profileBinding??'')&&Number.isFinite(at)&&Number.isFinite(observed)&&
       Math.abs(at-observed)<=60_000&&at<=now.getTime()&&now.getTime()-at<=60*60_000&&dayAt(new Date(at))===businessDate)
      candidate.unsignedWakeup={confirmedAt:new Date(at).toISOString(),profileBinding:value.profileBinding};
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
const harvestWaitAttempt=item=>['completed','deferred_preflight'].includes(item?.state)&&item?.submissionState==='not_submitted'&&
  (item?.v1Status==='deferred'||item?.outcome?.retryCause==='harvest_waiting'||item?.outcome?.failureCode==='harvest_waiting');
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
  if(attempts.some(item=>harvestWaitAttempt(item)&&item.harvestWakeup!==true&&
    (!item.nextEligibleAt||Date.parse(item.nextEligibleAt)<=now.getTime())))return false;
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

function unsignedWakeupDue(state,candidate,now){
  const signal=candidate.unsignedWakeup,at=Date.parse(signal?.confirmedAt??'');
  if(candidate.guardedSubmit!==true||!/^[a-f0-9]{64}$/.test(signal?.profileBinding??'')||
     !Number.isFinite(at)||at>now.getTime()||now.getTime()-at>60*60_000||dayAt(new Date(at))!==candidate.businessDate)return false;
  const probes=(state.verifications??[]).filter(item=>item.origin===candidate.origin&&(item.accountKey??'site-default')===candidate.accountKey);
  const deferred=item=>['deferred_busy','deferred_preflight'].includes(item.state);
  const reads=probes.filter(item=>!deferred(item));
  return reads.filter(item=>item.unsignedWakeup).length<2&&probes.filter(deferred).length<24&&
    !reads.some(item=>item.state==='in_progress'||item.unsignedWakeup?.confirmedAt===signal.confirmedAt||
      item.outcome?.evidence?.confirmedAt===signal.confirmedAt)&&
    probes.filter(item=>deferred(item)&&item.unsignedWakeup?.confirmedAt===signal.confirmedAt).every(item=>
      Number.isFinite(Date.parse(item.nextEligibleAt))&&Date.parse(item.nextEligibleAt)<=now.getTime());
}

function passiveVerificationDue(state,candidate,readOnlyOrigins,now){
  const reviewOnly=candidate.readOnlyReview===true||candidate.guardedSubmit===true||
    (candidate.kind==='fallback_only'&&readOnlyOrigins.includes(candidate.origin));
  if(!reviewOnly)return false;
  if(unsignedWakeupDue(state,candidate,now))return true;
  const probes=(state.verifications??[]).filter(v=>v.origin===candidate.origin&&(v.accountKey??'site-default')===candidate.accountKey);
  const deferred=probe=>['deferred_busy','deferred_preflight'].includes(probe.state);
  // A previous Harvest gate may have recorded a no-submission wait after the
  // normal passive-review budget was exhausted. Once its cooldown is over,
  // permit exactly one policy-wakeup read so it can be evaluated under the
  // current guarded fallback path.
  const wakePending=state.attempts?.some(item=>item.origin===candidate.origin&&
    (item.accountKey??'site-default')===candidate.accountKey&&harvestWaitAttempt(item)&&
    item.harvestWakeup!==true&&(!item.nextEligibleAt||Date.parse(item.nextEligibleAt)<=now.getTime()));
  if(wakePending)return true;
  if(probes.filter(p=>!deferred(p)).length>=3||probes.filter(deferred).length>=24)return false;
  return probes.every(probe=>deferred(probe)
    ?Number.isFinite(Date.parse(probe.nextEligibleAt))&&Date.parse(probe.nextEligibleAt)<=now.getTime()
    :now.getTime()-Date.parse(probe.startedAt)>=30*60_000);
}

export function pendingHarvestFallbackAttempts(root,preview,{recoveredAtByAccount={},readOnlyOrigins=[],now=new Date()}={}){
  const {state}=readAttemptState(root,preview.businessDate);
  const normalizedReadOnlyOrigins=[...new Set(readOnlyOrigins.map(originOf).filter(Boolean))];
  return preview.eligible.filter(candidate=>candidate.readOnlyReview===true||
    (candidate.kind==='fallback_only'&&normalizedReadOnlyOrigins.includes(candidate.origin))
    ?passiveVerificationDue(state,candidate,normalizedReadOnlyOrigins,now)
    :!alreadyAttempted(state,candidate,recoveredAtByAccount,now)&&!unresolvedEarlierAttempt(root,candidate));
}

function claimWorker(root) {
  return acquireExecutionLock(root,{name:'harvest-fallback.lock'});
}

export async function runHarvestFallback({root=path.resolve('.'),harvest,catalog,plan,latest,fallbackReport=null,config={},now=new Date(),execute=false,
  catalogFile=null,catalogHash=null,fallbackOnlyEnabled=false,runEngine=runLegacyEngine,runSite=runPtSite,
  clock=()=>new Date(),refreshHarvest=null,recoveredAtByAccount={},readOnlyOrigins=[],onlyOrigins=null,manualRecoveryId=null,
  deadline=null,minimumSiteBudgetMs=70_000,siteDeadline=deadline,signal}={}) {
  if(deadline!==null&&!Number.isFinite(deadline)||siteDeadline!==null&&!Number.isFinite(siteDeadline)||
     !Number.isFinite(minimumSiteBudgetMs)||minimumSiteBudgetMs<=0)
    throw Error('Invalid PT batch budget');
  const normalizedReadOnlyOrigins=[...new Set(readOnlyOrigins.map(originOf).filter(Boolean))];
  if(manualRecoveryId!==null&&(!execute||!Array.isArray(onlyOrigins)||onlyOrigins.length!==1||
    !/^(?:op_[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(manualRecoveryId)))
    throw Error('Manual recovery requires one explicit bound request');
  let preview=planHarvestFallback({harvest,catalog,plan,latest,fallbackReport,config,now,fallbackOnlyEnabled,
    readOnlyOrigins:normalizedReadOnlyOrigins});
  if(onlyOrigins){
    const selected=Array.isArray(onlyOrigins)&&onlyOrigins.length===1?originOf(onlyOrigins[0]):null;
    if(!selected||!catalog.sites.some(s=>originOf(s.origin)===selected))throw Error('invalid selected PT scope');
    preview={...preview,eligible:preview.eligible.filter(c=>c.origin===selected),blocked:preview.blocked.filter(c=>c.origin===selected)};
  }
  if(!execute)return {...preview,mode:'preview'};
  const runtime=loadRuntimeConfig(root);
  if(runtime.executionEngine!=='v1'||!runtime.legacyRoot)throw Error('Harvest fallback requires the V1 execution engine');
  const integration=JSON.parse(fs.readFileSync(path.join(runtime.legacyRoot,'data/v2-integration.json'),'utf8'));
  if(integration.executionEngine!=='v1'||path.resolve(integration.v2ProjectRoot)!==path.resolve(root))throw Error('Harvest fallback engine bindings disagree');
  if(preview.eligible.some(item=>item.kind==='fallback_only')&&(!catalogFile||!/^[a-f0-9]{64}$/i.test(catalogHash??'')))throw Error('PT fallback needs the bound bookmark catalog');
  if(!preview.eligible.length)return {...preview,mode:'executed',outcomes:[]};
  const workerLock=claimWorker(root);
  try{
  if(runSite===runPtSite){
    const scopedRunSite=runSite;
    runSite=request=>withCurrentPtCatalog({root,catalogFile:request.catalogFile,origin:request.origin,now:clock()},
      current=>scopedRunSite({...request,catalogFile:current.catalogFile,catalogHash:current.catalogHash}));
  }
  const {file:stateFile,state}=readAttemptState(root,preview.businessDate);
  const outcomes=[];
  const originalRunSite=runSite;
  if(signal)runSite=request=>originalRunSite({...request,signal});
  const budgetAvailable=()=>{
    if(signal?.aborted)return false;
    if(deadline===null&&siteDeadline===null)return true;
    const at=clock().getTime();
    return (deadline===null||at<deadline)&&(siteDeadline===null||siteDeadline-at>=minimumSiteBudgetMs);
  };
  const deferBudget=candidate=>{
    const entry={origin:candidate.origin,accountKey:candidate.accountKey,state:'deferred_budget',
      recordedAt:clock().toISOString(),submissionAttempted:false};
    state.deferrals=(state.deferrals??[]).filter(item=>item.origin!==candidate.origin||item.accountKey!==candidate.accountKey);
    state.deferrals.push(entry);writeAtomic(stateFile,state);outcomes.push(entry);
  };
  const statusFile=path.join(root,'outputs',`pt-fallback-results-${preview.businessDate}.json`);
  for(const candidate of preview.eligible){
    const candidateNow=clock();
    if(dayAt(candidateNow)!==preview.businessDate){outcomes.push({origin:candidate.origin,state:'business_day_changed'});break;}
    const attempted=alreadyAttempted(state,candidate,recoveredAtByAccount,candidateNow);
    const historicalUnknown=unresolvedEarlierAttempt(root,candidate);
    let currentSupplement=null;
    if(fs.existsSync(statusFile)){
      currentSupplement=JSON.parse(fs.readFileSync(statusFile,'utf8'));
      if(currentSupplement.source!=='execution-supplement'||currentSupplement.businessDate!==preview.businessDate||
        !Array.isArray(currentSupplement.sites))throw Error('PT status audit is invalid');
    }
    // A same-day authoritative executor supplement closes this candidate
    // before passive cooldown/attempt guards are evaluated. Otherwise a
    // successful fallback is incorrectly reported as a new cooldown on the
    // next scheduler pass and the dashboard keeps it pending.
    if(confirmedSupplement(currentSupplement,candidate.origin,preview.businessDate,candidateNow)){
      outcomes.push({origin:candidate.origin,state:'already_confirmed'});continue;
    }
    const manualRecovery=manualRecoveryId!==null&&candidate.guardedSubmit===true&&normalizedReadOnlyOrigins.includes(candidate.origin);
    if(manualRecoveryId!==null&&!manualRecovery){outcomes.push({origin:candidate.origin,state:'manual_recovery_reader_unavailable'});continue;}
    if(manualRecovery&&state.attempts.some(a=>a.manualRecoveryId===manualRecoveryId)){
      outcomes.push({origin:candidate.origin,state:'manual_recovery_already_attempted'});continue;
    }
    const canVerify=manualRecovery||passiveVerificationDue(state,candidate,normalizedReadOnlyOrigins,candidateNow);
    const readOnlyReview=candidate.readOnlyReview===true;
    if((readOnlyReview||candidate.guardedSubmit===true||
      (candidate.kind==='fallback_only'&&normalizedReadOnlyOrigins.includes(candidate.origin)))&&!canVerify){
      outcomes.push({origin:candidate.origin,state:'passive_verification_cooldown'});continue;
    }
    if(attempted&&!canVerify){outcomes.push({origin:candidate.origin,state:'already_attempted'});continue;}
    if(historicalUnknown&&!canVerify){outcomes.push({origin:candidate.origin,state:'prior_outcome_unknown'});continue;}
    if(!budgetAvailable()){deferBudget(candidate);continue;}
    if(refreshHarvest){
      let live;
      try{
        live=await refreshHarvest();
        const livePreview=planHarvestFallback({harvest:live,catalog,plan,latest,
          fallbackReport:currentSupplement,config,now:clock(),fallbackOnlyEnabled,
          readOnlyOrigins:normalizedReadOnlyOrigins});
        const previousOwner=harvestSiteAssignment(harvest,candidate.origin).owner;
        const currentOwner=harvestSiteAssignment(live,candidate.origin).owner;
        if(currentOwner!==previousOwner){outcomes.push({origin:candidate.origin,state:'harvest_assignment_changed'});continue;}
        if(currentOwner!=='execution'&&!candidate.guardedSubmit&&(live.taskCompletion?.resultId!==harvest.taskCompletion?.resultId||
           Date.parse(live.taskCompletion?.completedAt)!==Date.parse(harvest.taskCompletion?.completedAt))){
          outcomes.push({origin:candidate.origin,state:'harvest_task_changed'});
          break;
        }
        if(!livePreview.eligible.some(item=>item.origin===candidate.origin&&
          item.accountKey===candidate.accountKey&&item.kind===candidate.kind)){
          outcomes.push({origin:candidate.origin,state:'harvest_status_changed'});
          continue;
        }
      }catch{
        if(candidate.guardedSubmit===true)continue;
        outcomes.push({origin:candidate.origin,state:'harvest_refresh_unavailable'});
        break;
      }
    }
    if(!budgetAvailable()){deferBudget(candidate);continue;}
    let recoveryEvidence=null,authenticationRecovery=false;
    if(canVerify){
      const verification={origin:candidate.origin,accountKey:candidate.accountKey,startedAt:clock().toISOString(),state:'in_progress'};
      if(unsignedWakeupDue(state,candidate,clock()))verification.unsignedWakeup=candidate.unsignedWakeup;
      if(manualRecovery)verification.manualRecoveryId=manualRecoveryId;
      state.verifications??=[];state.verifications.push(verification);writeAtomic(stateFile,state);
      try{
        let checked=currentPassivePtResult(await runSite({root,origin:candidate.origin,catalogFile,catalogHash,readOnly:true}),clock());
        if(checked.accountKey!==candidate.accountKey)throw Error('passive account mismatch');
        if(verification.unsignedWakeup&&checked.profileBinding!==verification.unsignedWakeup.profileBinding)throw Error('passive wakeup profile mismatch');
        const loginOpt=config.siteTwoFactorRecovery?.[candidate.origin];
        authenticationRecovery=candidate.kind==='fallback_only'&&candidate.origin==='https://www.uhddolby.com'&&
          checked.status==='login_required'&&checked.submissionAttempted===false&&loginOpt?.enabled===true&&loginOpt.reviewed===true&&
          loginOpt.provider==='bitwarden'&&loginOpt.adapterId==='hddolby-nexus-stepup-v1'&&loginOpt.allowPasswordLogin===true;
        if(authenticationRecovery){
          const binding=checked.profileBinding;
          verification.authenticationRecovery=true;writeAtomic(stateFile,state);
          checked=currentPassivePtResult(await runSite({root,origin:candidate.origin,catalogFile,catalogHash,loginRecoveryOnly:true}),clock());
          if(checked.accountKey!==candidate.accountKey||checked.profileBinding!==binding)throw Error('authentication binding changed');
        }
        verification.outcome=checked;verification.state='completed';verification.finishedAt=clock().toISOString();
        recordPtVerification(root,checked,{now:clock(),lockHeld:true,attemptState:state});writeAtomic(stateFile,state);
        if(['signed','already_signed'].includes(checked.status)){
          outcomes.push({origin:candidate.origin,state:'confirmed_by_passive_read',v1Status:checked.status});continue;
        }
        const guardedRecovery=candidate.guardedSubmit===true&&verifiedGuardedRecovery(checked,candidate,clock(),{readOnlyOrigins:normalizedReadOnlyOrigins});
        if(readOnlyReview&&!guardedRecovery){
          // An inconclusive or non-opted-in registered review never falls
          // through to execution. A fresh bound unsigned proof may hand off
          // once to V1, which must claim and recheck it under its own lease.
          outcomes.push({origin:candidate.origin,state:'passive_result_unverified',v1Status:checked.status,
            ...(checked.failureCode?{failureCode:checked.failureCode}:{}),readOnly:true});continue;
        }
        if(checked.status!=='not_signed'||checked.evidence?.authoritative!==true||!guardedRecovery){
          outcomes.push({origin:candidate.origin,state:'passive_result_unverified',v1Status:checked.status});continue;
        }
        // This does not close or relabel historical uncertainty. A fresh, bound
        // daily-state observation permits only this day's guarded attempt.
        recoveryEvidence=checked;
        const dailyAttempts=state.attempts.filter(a=>a.origin===candidate.origin&&
          (a.accountKey??'site-default')===candidate.accountKey&&!['deferred_busy','deferred_preflight'].includes(a.state));
        const options={readOnlyOrigins:normalizedReadOnlyOrigins,config,manualRecovery};
        if(dailyAttempts.length>=3&&!manualRecovery){
          outcomes.push({origin:candidate.origin,state:'daily_guard_recovery_limit'});continue;
        }
        const boundAttemptBeforeProof=attempt=>(candidate.origin==='https://www.uhddolby.com'||manualRecovery)&&
          attempt.accountKey===candidate.accountKey&&attempt.outcome?.profileBinding===checked.profileBinding&&
          Number.isFinite(Date.parse(attempt.finishedAt??''))&&Date.parse(attempt.finishedAt)<Date.parse(checked.evidence.confirmedAt);
        if(dailyAttempts.some(a=>!recoverableUnsubmittedProfileGuard(a,candidate,checked,clock(),options)&&
          !interruptedBoundAttemptBeforeProof(a,candidate,checked,clock(),options)&&!boundAttemptBeforeProof(a))){
          outcomes.push({origin:candidate.origin,state:'daily_attempt_limit'});continue;
        }
      }catch(error){
        const at=clock();
        if(['catalog_stale','catalog_hash_changed','registration_invalid','execution_plan_missing','execution_plan_changed',
          'bookmark_source_changed','site_scope_changed','scope_unavailable'].includes(error.preflightReason))verification.preflightReason=error.preflightReason;
        verification.state=error.code==='PT_PREFLIGHT'?'deferred_preflight':
          error.message==='V2 runner is already active'?'deferred_busy':'unverified';
        verification.finishedAt=at.toISOString();
        if(verification.state!=='unverified'){
          verification.submissionAttempted=false;
          verification.nextEligibleAt=new Date(at.getTime()+(verification.state==='deferred_busy'?5:15)*60_000).toISOString();
        }
        writeAtomic(stateFile,state);
        outcomes.push({origin:candidate.origin,state:verification.state==='unverified'?'passive_verification_unavailable':verification.state});continue;
      }
    }
    if(canVerify&&dayAt(clock())!==preview.businessDate){outcomes.push({origin:candidate.origin,state:'business_day_changed'});break;}
    if(!budgetAvailable()){deferBudget(candidate);continue;}
    // Persist before executing. No uncertain attempt is retried without a new
    // authoritative read, followed by another read inside the executor lock.
    const harvestWaitingAttempt=state.attempts.find(item=>item.origin===candidate.origin&&
      (item.accountKey??'site-default')===candidate.accountKey&&harvestWaitAttempt(item)&&item.harvestWakeup!==true&&
      (!item.nextEligibleAt||Date.parse(item.nextEligibleAt)<=candidateNow.getTime()));
    const harvestWakeup=Boolean(harvestWaitingAttempt);
    if(harvestWaitingAttempt){
      harvestWaitingAttempt.harvestWakeup=true;
      harvestWaitingAttempt.harvestWakeupAt=candidateNow.toISOString();
      writeAtomic(stateFile,state);
    }
    const attempt={attemptId:crypto.randomUUID(),origin:candidate.origin,accountKey:candidate.accountKey,businessDate:preview.businessDate,
       observedAt:candidate.observedAt,startedAt:clock().toISOString(),state:'in_progress',
       workerPid:workerLock.owner.pid,workerNonce:workerLock.owner.nonce};
    if(harvestWakeup)attempt.harvestWakeup=true;
    if(recoveryEvidence)attempt.recoveryEvidence=recoveryEvidence;
    if(authenticationRecovery)attempt.authenticationRecovery=true;
    if(manualRecovery)attempt.manualRecoveryId=manualRecoveryId;
    if(Number.isFinite(Date.parse(recoveredAtByAccount[recoveryIdentity(candidate)])))
      attempt.recoveredAt=recoveredAtByAccount[recoveryIdentity(candidate)];
    state.attempts.push(attempt);writeAtomic(stateFile,state);
    // Persist uncertainty before waiting for cooperative cleanup. Even a hard
    // kill after the grace period must never leave a replayable "not submitted".
    const onCancel=()=>{
      attempt.state='outcome_unknown';attempt.finishedAt=clock().toISOString();
      attempt.reason='PT batch cancellation requested';
      try{writeAtomic(stateFile,state);}catch{/* The durable in_progress record still prohibits blind replay. */}
    };
    signal?.addEventListener('abort',onCancel,{once:true});
    if(signal?.aborted)onCancel();
    try{
      if(candidate.guardedSubmit===true||candidate.kind==='fallback_only'){
        let rawResult;
        const nativeRegistered=Boolean(recoveryEvidence)&&reviewedNativeExecutor(candidate,config);
        if(nativeRegistered){
          // Registered native PTs must reuse their mature original execution
          // profile. The generic supplement owns a different browser profile.
          attempt.nativeRegisteredEngine=true;writeAtomic(stateFile,state);
          // The mature native path owns exactly one site-default account.
          // Legacy raw receipts may omit its default accountKey, so the PS
          // preflight cannot safely filter that field. Origin selection still
          // requires the exact current plan; validate the returned account below.
          const report=await runEngine({root,mode:'execute',origins:[candidate.origin],accountKeys:[],
            notify:false,fallbackRecheck:true});
          attempt.runId=report.runId??null;
          const matches=report.results?.filter(r=>r.origin===candidate.origin&&
            (r.accountKey??'site-default')===candidate.accountKey)??[];
          if(matches.length!==1)throw Error('Native PT engine result has no unique bound account');
          rawResult={...matches[0],origin:candidate.origin,accountKey:candidate.accountKey,
            observedAt:report.observedAt??report.sourceFinishedAt,businessDate:report.businessDate};
        }else{
          rawResult=await runSite({root,origin:candidate.origin,catalogFile,catalogHash,
            verifyBeforeSubmit:Boolean(recoveryEvidence),fallbackAttemptId:attempt.attemptId});
        }
        const result=projectPtSiteResult(rawResult,candidate.origin);
        const receivedAt=clock();
        // Keep the redacted receipt before later validation or publication.
        attempt.outcome=result;
        attempt.finishedAt=receivedAt.toISOString();
        attempt.resultObservedAt=result.observedAt;
        attempt.resultBusinessDate=dayAt(new Date(result.observedAt));
        attempt.v1Status=result.status;
        if(nativeRegistered&&result.profileBinding!==recoveryEvidence.profileBinding){
          writeAtomic(stateFile,state);
          throw Error('Native PT engine result profile disagrees with the passive account binding');
        }
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
        const report=await runEngine({root,mode:'execute',origins:[candidate.origin],accountKeys:[candidate.accountKey],notify:false,fallbackRecheck:true});
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
      attempt.state=signal?.aborted?'outcome_unknown':error.code==='PT_PREFLIGHT'?'deferred_preflight':error.message==='V2 runner is already active'?'deferred_busy':'outcome_unknown';
      attempt.reason=String(error.message).slice(0,120);
    }finally{
      signal?.removeEventListener('abort',onCancel);
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
