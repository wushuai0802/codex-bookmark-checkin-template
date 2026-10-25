import crypto from 'node:crypto';
import {cancelledTask,ptStatusCondition} from '../public/dashboard-model.mjs';
import {siteFaultCodes} from './checkin-contract.generated.mjs';

/** Presentation only: regular account tasks plus authorized, site-only PT work. */
export function authorizedWorkload({tasks=[],ptStatus,businessDate,counts={}}={}){
  const result=tasks.map(task=>({...task})),regularOrigins=new Set(tasks.map(task=>task.origin));
  const supplemental=new Map();
  if(ptStatus&&/^\d{4}-\d{2}-\d{2}$/.test(businessDate??'')&&ptStatus.businessDate===businessDate)for(const site of ptStatus.sites??[]){
    if(site.inLegacyPlan||regularOrigins.has(site.origin)){
      if(site.discrepancy)for(const task of result.filter(task=>task.origin===site.origin&&(!site.accountRef||task.accountRef===site.accountRef)&&!cancelledTask(task))){
        task.executionObservedStatus=task.observedStatus;task.observedStatus='needs_attention';task.condition='identity_conflict';
        task.evidence={...task.evidence,authoritative:false,verification:'identity_conflict',summary:'当前 PT 权威观察存在冲突，先只读复核'};
      }
      continue;
    }
    if(!site.fallbackEnabled&&!site.disabledByConfig)continue;
    const values=supplemental.get(site.origin)??[];values.push(site);supplemental.set(site.origin,values);
  }
  for(const [origin,sites] of supplemental){
    const site=sites[0],effective=site.effective??{},disabled=site.disabledByConfig===true;
    const ambiguous=sites.length!==1||site.discrepancy===true,fresh=effective.fresh===true&&!ambiguous;
    const rawStatus=fresh?effective.status:'unknown',notSigned=rawStatus==='not_signed';
    const status=disabled?'not_available':notSigned?'needs_attention':rawStatus;
    const condition=disabled?'task_disabled':ambiguous?'identity_conflict':
      fresh?(siteFaultCodes.includes(effective.failureCode)?'upstream_unavailable':notSigned?'not_signed':ptStatusCondition(site)):undefined;
    const evidence=disabled?{source:'configuration',rawSource:'configuration',verification:'task_disabled',authoritative:true,
      summary:'已按配置暂停签到',redacted:true,businessDate}:
      {...(effective.evidence??{}),authoritative:fresh&&effective.authoritative===true&&effective.evidence?.authoritative===true,
        rawSource:effective.evidence?.source??'none',verification:ambiguous?'identity_conflict':
          fresh&&effective.authoritative===true?'verified':effective.failureCode==='submission_outcome_unknown'?'submission_outcome_unknown':'unverified_source'};
    result.push({taskId:'pt_task_'+crypto.createHash('sha256').update(origin+'|'+businessDate).digest('hex').slice(0,24),
      origin,displayName:site.displayName??new URL(origin).hostname,logicalSiteKey:origin,logicalGroup:'PT',
      accountKey:'site-default',accountRef:null,identity:{label:'本站账号',source:'configuration'},businessDate,
      taskKind:'pt',ptSupplementOnly:true,inLegacyPlan:false,executionOwner:'legacy-checkin',executionMode:'execute',
      observedStatus:status,observedAt:effective.observedAt??null,evidence,
      ...(condition?{condition}:{}),...(effective.failureCode?{failureCode:effective.failureCode}:{}),
      ...(effective.underlyingFailureCode?{underlyingFailureCode:effective.underlyingFailureCode}:{}),
      ...(typeof effective.submissionAttempted==='boolean'?{submissionAttempted:effective.submissionAttempted}:{})});
  }
  const status={},sites=new Map(),accounts=new Map();
  for(const task of result){
    status[task.observedStatus??'unknown']=(status[task.observedStatus??'unknown']??0)+1;
    const site=sites.get(task.origin)??{origin:task.origin,logicalSiteKey:task.logicalSiteKey,displayName:task.displayName,
      logicalGroup:task.logicalGroup,executionUnitCount:0,status:{},accounts:new Set()};
    site.executionUnitCount++;site.status[task.observedStatus??'unknown']=(site.status[task.observedStatus??'unknown']??0)+1;
    if(task.accountRef)site.accounts.add(task.accountRef);sites.set(task.origin,site);
    if(task.accountRef){
      const key=task.origin+'|'+task.accountRef,account=accounts.get(key)??{accountRef:task.accountRef,identity:task.identity,
        displayName:task.displayName,origin:task.origin,taskCount:0,sites:new Set(),status:{}};
      account.taskCount++;account.sites.add(task.origin);account.status[task.observedStatus??'unknown']=(account.status[task.observedStatus??'unknown']??0)+1;
      accounts.set(key,account);
    }
  }
  const successful=result.filter(task=>['signed','already_signed'].includes(task.observedStatus)),cancelled=result.filter(cancelledTask);
  const unavailable=result.filter(task=>task.observedStatus==='not_available'&&!cancelled.includes(task));
  const verified=task=>task.evidence?.authoritative===true;
  const evidenceQuality={verifiedSuccess:successful.filter(verified).length,unverifiedSuccess:successful.filter(task=>!verified(task)).length,
    verifiedUnavailable:unavailable.filter(verified).length,unverifiedUnavailable:unavailable.filter(task=>!verified(task)).length,cancelled:cancelled.length};
  const serialize=value=>({...value,accounts:value.accounts?[...value.accounts].sort():undefined,sites:value.sites?[...value.sites].sort():undefined});
  return {tasks:result,status,evidenceQuality,planCounts:{...counts},supplementTaskCount:result.length-tasks.length,
    counts:{...counts,logicalSites:sites.size,executionUnits:result.length,status},
    sites:[...sites.values()].map(serialize).sort((a,b)=>a.origin.localeCompare(b.origin)),
    accounts:[...accounts.values()].map(serialize).sort((a,b)=>a.accountRef.localeCompare(b.accountRef))};
}
