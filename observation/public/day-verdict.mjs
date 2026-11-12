import {siteFaultCodes,externalRetryCauses} from './checkin-contract.generated.mjs';
import {confirmedPtByTask} from './pt-evidence.mjs';
import {harvestOverdue} from './harvest-overdue.mjs';
import {conditionLabels} from './checkin-contract.generated.mjs';

export const shanghaiDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const signed=value=>['signed','already_signed'].includes(value);
const conflicts=value=>[value?.condition,value?.failureCode,value?.evidence?.verification].some(code=>
  ['identity_conflict','account_mismatch','identity_mismatch'].includes(code));

// Input tasks are the existing authorizedWorkload projection. This read-only
// view neither creates execution candidates nor alters reports or retry state.
export function dayVerdict(snapshot={}, {now=new Date()}={}){
  const time=new Date(now).getTime(),businessDate=shanghaiDay(time);
  const dated=value=>Number.isFinite(Date.parse(value??''))&&Date.parse(value)<=time+60_000&&shanghaiDay(value)===businessDate;
  const current=snapshot.businessDate===businessDate;
  const receipts=new Map((snapshot.receipts??[]).map(receipt=>[receipt.taskId,receipt]));
  const confirmed=confirmedPtByTask(snapshot),seen=new Set();
  const counts={done:0,verifying:0,actionNeeded:0,external:0,paused:0,noFeature:0},items=[];
  for(const task of snapshot.tasks??[]){
    if(typeof task.taskId!=='string'||seen.has(task.taskId))continue;
    seen.add(task.taskId);
    const receipt=receipts.get(task.taskId),evidence=receipt?.evidence??task.evidence??{};
    const status=receipt?.status??task.observedStatus??task.status;
    const observedAt=receipt?.observedAt??task.observedAt;
    const codes=[task.condition,task.failureCode,task.underlyingFailureCode,task.siteCondition,task.retryCause];
    const pt=confirmed.get(task.origin+'|'+(task.accountRef??'site-default'));
    const sites=(snapshot.ptStatus?.businessDate===businessDate?snapshot.ptStatus.sites??[]:[])
      .filter(site=>site.origin===task.origin&&(!site.accountRef||site.accountRef===task.accountRef));
    const site=sites.length===1?sites[0]:null,effective=site?.effective;
    const freshSite=effective?.fresh===true&&dated(effective.observedAt);
    const conflicting=conflicts(task)||conflicts(receipt)||site?.discrepancy===true||
      Boolean(receipt?.accountRef&&receipt.accountRef!==task.accountRef);
    const fresh=current&&dated(observedAt);
    const newerNegative=freshSite&&effective.status==='not_signed'&&effective.authoritative===true&&
      Date.parse(effective.observedAt)>=Date.parse(observedAt??'');
    const manual=task.retryable===false||task.retryExhaustedForDay===true||task.loginRecoveryExhausted===true||task.retryableLoginRecovery===false;
    const retryAt=Date.parse(task.nextEligibleAt??'');
    const retrying=task.retryable!==false&&!manual&&(task.retryable===true||
      Number.isFinite(retryAt)&&shanghaiDay(retryAt)===businessDate);
    const requiresHuman=task.manualVerificationRequired===true||['login_required','interactive_challenge'].includes(status)||
      codes.some(code=>['login_required','two_factor_required','login_recovery_failed','login_recovery_exhausted',
        'native_security_verification_required','manual_verification_required'].includes(code));
    const unknown=codes.includes('submission_outcome_unknown')||task.submissionAttempted===true&&!signed(status);
    const externalCode=codes.some(code=>siteFaultCodes.includes(code)||code!=='harvest_waiting'&&externalRetryCauses.includes(code)||
      ['site_maintenance','site_migration','bookmark_origin_changed','entitlement_expired'].includes(code));
    const unavailable=evidence.verification==='feature_unavailable'||
      status==='not_available'&&evidence.authoritative===true&&evidence.verification==='verified';
    const harvest=site?.harvestObservation,lastReceiptDay=harvest?.lastReceiptDay;
    const receiptDayTime=/^\d{4}-\d{2}-\d{2}$/.test(lastReceiptDay??'')?Date.parse(lastReceiptDay+'T00:00:00Z'):NaN;
    const missingDays=Number.isFinite(receiptDayTime)&&new Date(receiptDayTime).toISOString().slice(0,10)===lastReceiptDay
      ?(Date.parse(businessDate+'T00:00:00Z')-receiptDayTime)/86400000:NaN;
    const todayHarvestReceipt=[effective,...(site?.observations??[])].some(item=>item?.source==='harvest'&&
      item.authoritative===true&&item.fresh===true&&dated(item.observedAt));
    let category='verifying';
    let reasonCode=null;
    const overdue=harvestOverdue(site,snapshot.ptStatus,time);
    if(task.disabledByConfig===true||task.availabilityKind==='task_disabled'||task.condition==='task_disabled'||evidence.verification==='task_disabled')category='paused';
    else if(task.availabilityKind==='feature_disabled'||task.condition==='feature_disabled'||
      unavailable&&task.availabilityKind!=='temporary_unavailable'&&!externalCode)category='noFeature';
    else if(current&&!conflicting&&((pt&&pt.evidence?.businessDate===businessDate&&dated(pt.evidence.confirmedAt??pt.observedAt)&&dated(pt.observedAt))||
      fresh&&!newerNegative&&signed(status)&&evidence.authoritative===true&&evidence.verification!=='unverified_source'&&
      Boolean(evidence.source)&&!['none','health_cache','configuration'].includes(evidence.source)&&
      (!evidence.businessDate||evidence.businessDate===businessDate)&&(!evidence.confirmedAt||dated(evidence.confirmedAt))))category='done';
    else if(current&&(freshSite&&(site.evidenceState==='external_blocked'||effective.siteCondition==='site_maintenance'||
      siteFaultCodes.includes(effective.failureCode)||['site_migration','bookmark_origin_changed'].includes(effective.failureCode))||
      fresh&&(externalCode||
        task.availabilityKind==='temporary_unavailable')))category='external';
    else if(current&&site?.harvestManaged===true&&site.disabledByConfig!==true&&harvest?.checkinEnabled===true&&harvest.businessDate===businessDate&&
      harvest.taskCompletion?.status==='completed'&&missingDays>=2&&site.capabilities?.read===false&&!todayHarvestReceipt){
      category='actionNeeded';reasonCode='harvest_stalled';
    }
    else if(current&&overdue&&!overdue.canTakeOver){category='actionNeeded';reasonCode=overdue.reasonCode;}
    else if(fresh&&!retrying&&(requiresHuman&&(manual||task.manualVerificationRequired===true||['interactive_challenge'].includes(status)||codes.includes('two_factor_required'))||
      manual&&!unknown&&!codes.includes('harvest_waiting')&&!signed(status)&&['needs_attention','deferred','login_required','failed','error','no_action','managed_challenge_timeout'].includes(status)))category='actionNeeded';
    counts[category]++;items.push({taskId:task.taskId,class:category,...(reasonCode&&reasonCode!=='harvest_stalled'?{
      reasonCode,summary:conditionLabels[reasonCode]}:reasonCode?{reasonCode,lastReceiptDay,missingDays,
      summary:`Harvest 已 ${missingDays} 天没有处理这个站点，最后一次回执在 ${lastReceiptDay.slice(5)}，可能是站点已关闭或登录失效，请核对`}:{})});
  }
  return {businessDate,total:counts.done+counts.verifying+counts.actionNeeded,counts,items,
    settled:counts.verifying===0&&counts.actionNeeded===0};
}
