const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const minute=60_000;
const dated=(value,businessDate)=>Number.isFinite(Date.parse(value))&&day(value)===businessDate;

export function copyHarvestWindow(value){
  if(value?.source!=='harvest'||!['scheduled','running'].includes(value.phase)||
    !dated(value.observedAt,value.businessDate)||!dated(value.referenceAt,value.businessDate)||
    Date.parse(value.deadlineAt)!==Date.parse(value.referenceAt)+30*minute)return null;
  const result={source:'harvest',businessDate:value.businessDate,observedAt:value.observedAt,phase:value.phase,
    referenceAt:value.referenceAt,deadlineAt:value.deadlineAt};
  if(value.origin){try{const url=new URL(value.origin);if(url.protocol!=='https:'||url.origin!==value.origin||url.username||url.password)return null;
    result.origin=value.origin;}catch{return null;}}
  return result;
}

// Presentation only: no execution permission, lease or write budget is changed.
export function projectHarvestWindow(report,now=Date.now()){
  if(report?.schemaVersion!==1||report.source!=='harvest'||report.businessDate!==day(now)||!dated(report.generatedAt,report.businessDate))return null;
  const completion=report.taskCompletion;
  if(['completed','failed'].includes(completion?.status))return null;
  const running=completion?.status==='running'&&Number.isInteger(completion.resultId)&&completion.activeTaskCount>0;
  const at=running?completion.startedAt:report.taskSchedule?.scheduledAt;
  if(!dated(at,report.businessDate)||!running&&report.taskSchedule?.businessDate!==report.businessDate)return null;
  return {source:'harvest',businessDate:report.businessDate,observedAt:report.generatedAt,
    phase:running?'running':'scheduled',referenceAt:new Date(at).toISOString(),deadlineAt:new Date(Date.parse(at)+30*minute).toISOString()};
}

export function harvestWindowActive(window,now=Date.now()){
  const observed=Date.parse(window?.observedAt??''),at=Date.parse(window?.referenceAt??''),until=Date.parse(window?.deadlineAt??'');
  return window?.source==='harvest'&&window.businessDate===day(now)&&['scheduled','running'].includes(window.phase)&&
    dated(window.observedAt,window.businessDate)&&dated(window.referenceAt,window.businessDate)&&
    observed<=now+minute&&now-observed<=30*minute&&Number.isFinite(until)&&until===at+30*minute&&now<until&&
    (window.phase!=='running'||at<=now+minute);
}

export function siteHarvestWait(site,window,now=Date.now()){
  const e=site?.effective??{};
  if(!harvestWindowActive(window,now)||site.inLegacyPlan||!site.fallbackEnabled||site.disabledByConfig||
     site.harvestManaged!==true||site.discrepancy||e.status!=='unknown'||e.failureCode||e.authoritative===true||e.submissionAttempted===true)return null;
  if(['submission_outcome_unknown','unverified_prior_attempt'].includes(site.recovery?.code))return null;
  if((site.observations??[]).some(item=>item.fresh===true&&(item.failureCode||item.submissionAttempted===true||item.status!=='unknown')))return null;
  return {...window,origin:site.origin};
}

export function waitingTask(task,now=Date.now()){
  return task?.ptSupplementOnly===true&&task?.waiting?.origin===task.origin&&harvestWindowActive(task.waiting,now)&&
    !['signed','already_signed','not_available','failed','login_required'].includes(task.observedStatus)&&!task.failureCode&&task.submissionAttempted!==true;
}

// An observation made before the deadline cannot tell us what happened after
// it. Allow a short publication handoff, then report a sync delay rather than
// accusing every previously waiting site of failing. This grants no extra
// Harvest execution time and never changes the dashboard's progress or guards.
export function harvestNotificationSyncPending(ptStatus,now=Date.now()){
  const window=copyHarvestWindow(ptStatus?.harvestWindow);
  if(!window||window.businessDate!==day(now)||ptStatus.businessDate!==day(now)||
     now<Date.parse(window.deadlineAt))return null;
  const observed=Date.parse(window.observedAt);
  if(!harvestWindowActive(window,observed))return null;
  const origins=[...new Set((ptStatus.sites??[]).filter(site=>siteHarvestWait(site,window,observed)).map(site=>site.origin))].sort();
  return origins.length?{businessDate:window.businessDate,observedAt:window.observedAt,deadlineAt:window.deadlineAt,
    overdue:now>=Date.parse(window.deadlineAt)+5*minute,origins}:null;
}

export function harvestWaitSummary(window){
  if(window?.phase==='running')return 'Harvest 正在执行，完成后自动核验';
  const at=Date.parse(window?.referenceAt??'');
  return Number.isFinite(at)?'等待 Harvest 计划 '+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(at):'等待 Harvest 执行';
}
