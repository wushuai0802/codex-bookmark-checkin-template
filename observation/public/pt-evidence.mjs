import {siteFaultCodes} from './checkin-contract.generated.mjs';

// Shared evidence predicates; these functions only read published observations.
export function currentBoundCompletion(site,businessDate,{passiveOnly=false}={}){
  const positive=site?.effective,proof=positive?.evidence??{};
  const passive=positive?.source==='execution-supplement'&&proof.readSafety==='reviewed_passive'&&positive?.submissionAttempted===false;
  const formal=positive?.submissionAttempted===true&&positive?.failureCode!=='submission_outcome_unknown';
  return positive?.fresh===true&&positive.authoritative===true&&['signed','already_signed'].includes(positive.status)&&!site.discrepancy&&
    ['execution-supplement','legacy-checkin'].includes(positive.source)&&
    proof.businessDate===businessDate&&proof.evidenceScope==='site_account_day'&&
    (passiveOnly?passive:passive||formal)&&
    /^[a-f0-9]{64}$/.test(proof.profileBinding??'')&&Number.isFinite(Date.parse(proof.confirmedAt))&&
    Boolean(site.accountRef)&&
    (site.observations??[]).some(item=>(item.failureCode==='submission_outcome_unknown'||
      item.submissionAttempted===true&&(!['signed','already_signed'].includes(item.status)||item.authoritative!==true))&&
      item.fresh&&item.evidence?.profileBinding===proof.profileBinding&&Date.parse(item.observedAt)<=Date.parse(proof.confirmedAt));
}

export function classifyPtEvidenceState(site) {
  const effective = site?.effective ?? {};
  const status = effective.fresh===true?effective.status:'unknown';
  const possiblyUnconfirmed=item=>item.failureCode==='submission_outcome_unknown'||
    item.submissionAttempted===true&&(!['signed','already_signed'].includes(item.status)||item.authoritative!==true);
  const submitted=effective.fresh===true&&possiblyUnconfirmed(effective)||
    site.observations?.some(item=>item.fresh&&possiblyUnconfirmed(item))||
    ['submission_outcome_unknown','unverified_prior_attempt'].includes(site?.recovery?.code);
  if (effective.fresh===true && ['signed', 'already_signed'].includes(status) && effective.authoritative === true && !site.discrepancy &&
      (!submitted||currentBoundCompletion(site,effective.evidence?.businessDate))) return 'confirmed';
  if(effective.fresh===true&&status==='not_available'&&effective.authoritative===true)
    return effective.evidence?.verification==='task_disabled'?'disabled':'unavailable';
  const moved=item=>[item?.failureCode,item?.underlyingFailureCode].some(code=>['site_migration','bookmark_origin_changed'].includes(code));
  if (effective.fresh===true&&(effective.siteCondition === 'site_maintenance' || effective.retryCause==='rate_limit' ||
      moved(effective)||site.observations?.some(item=>item.fresh&&moved(item))||
      siteFaultCodes.includes(effective.failureCode))) return 'external_blocked';
  if (submitted) return 'verification_pending';
  if(effective.fresh===true&&status==='not_signed'&&effective.authoritative===true&&!site.discrepancy)return 'not_signed_confirmed';
  if (!site?.inLegacyPlan && !site?.fallbackEnabled && !['signed','already_signed'].includes(status)) return 'monitor_only_unconfirmed';
  if ((site?.inLegacyPlan||site?.fallbackEnabled) && !['signed','already_signed'].includes(status)) return 'guarded_read_needed';
  return 'unconfirmed';
}

export function confirmedPtByTask(snapshot){
  if(snapshot?.ptStatus?.businessDate!==snapshot?.businessDate)return new Map();
  const counts=new Map();
  for(const task of snapshot?.tasks??[])if(!task.ptSupplementOnly)counts.set(task.origin,(counts.get(task.origin)??0)+1);
  const verified=new Map();
  for(const site of snapshot?.ptStatus?.sites??[]){
    const current=site?.effective,at=Date.parse(current?.observedAt??'');
    if(classifyPtEvidenceState(site)!=='confirmed'||!['signed','already_signed'].includes(current?.status)||current?.authoritative!==true||
       current?.evidence?.authoritative!==true||
       current?.fresh!==true||!Number.isFinite(at)||at>Date.parse(snapshot.generatedAt)+60_000||
       new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at))!==snapshot.businessDate)continue;
    if(!site.accountRef&&counts.get(site.origin)!==1)continue;
    verified.set(site.origin+'|'+(site.accountRef??'site-default'),current);
  }
  return verified;
}
