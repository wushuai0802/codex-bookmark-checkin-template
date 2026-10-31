import {conditionLabels,statusLabels,externalRetryCauses,ptSiteDisplayNames,siteFaultCodes} from './checkin-contract.generated.mjs';
import {waitingTask,harvestWindowActive,harvestWaitSummary} from './harvest-window.mjs';

function availabilityCondition(task){
  const value=task?.availability;
  return value?.condition==='site_maintenance'?'site_maintenance':
    value?.condition==='upstream_unavailable'&&siteFaultCodes.includes(value.failureCode)?'upstream_unavailable':null;
}
export function taskStatusCondition(task){return waitingTask(task)?'harvest_waiting':availabilityCondition(task)??task?.condition;}
export function taskStatusSummary(task){return waitingTask(task)?harvestWaitSummary(task.waiting):task?.waiting?
  '等待窗口已结束，尚无当日确认回执，请先核验':availabilityCondition(task)?task.availability.summary:task?.evidence?.summary;}
export function cancelledTask(task){return task?.observedStatus==='not_available'&&task?.evidence?.verification==='task_disabled'&&
  task.evidence.authoritative===true&&task.evidence.rawSource==='configuration';}
export function taskStatusLabel(task){return cancelledTask(task)?conditionLabels.task_disabled:
  (!['signed','already_signed','not_available'].includes(task?.observedStatus)?conditionLabels[taskStatusCondition(task)]:null)??statusLabels[task?.observedStatus]??task?.observedStatus;}
export function externalTask(task){return !waitingTask(task)&&!['signed','already_signed','not_available'].includes(task?.observedStatus)&&
  [...externalRetryCauses,'site_maintenance','entitlement_expired','site_migration','bookmark_origin_changed'].includes(taskStatusCondition(task));}

export function siteSideTask(task){
  if(['signed','already_signed','not_available'].includes(task?.observedStatus))return false;
  const condition=taskStatusCondition(task);
  if(['site_maintenance','rate_limit','site_migration','bookmark_origin_changed'].includes(condition))return true;
  return condition==='upstream_unavailable'&&[...siteFaultCodes,
    'oauth_upstream_unavailable','oauth_upstream_circuit_open'].includes(availabilityCondition(task)?task.availability.failureCode:task.failureCode);
}

// Charts and their drill-down filters share the same presentation buckets.
// The original execution enum and receipt remain unchanged.
export function taskDisplayStatus(task,now=Date.now()){
  if(waitingTask(task,now))return 'waiting';
  if(cancelledTask(task))return 'cancelled';
  if(['signed','already_signed'].includes(task?.observedStatus))return 'signed';
  if(externalTask(task))return 'external';
  if(task?.observedStatus!=='not_available'&&taskStatusCondition(task)==='submission_outcome_unknown')return 'verification';
  return task?.observedStatus??'unknown';
}

// Presentation only: retain the execution receipt and its original evidence.
export function taskResultBucket(task,now=Date.now()){
  if((!task?.dayClass||task.dayClass==='verifying')&&waitingTask(task,now))return 'waiting';
  if(task?.dayClass)return ({done:'verified',verifying:'proof',actionNeeded:'actionable',external:'excluded',paused:'excluded',noFeature:'excluded'})[task.dayClass]??'proof';
  if(cancelledTask(task)||siteSideTask(task))return 'excluded';
  if(['signed','already_signed'].includes(task?.observedStatus))return task.evidence?.authoritative===true?'verified':'proof';
  if(task?.observedStatus==='not_available')return task.evidence?.authoritative===true?'excluded':'proof';
  return 'actionable';
}

export function identityTitle(item) {
  const identity = item.identity ?? {};
  return identity.username || identity.label || (identity.userId ? `ID ${identity.userId}` : '默认账号（身份待采集）');
}

export function identityCaption(item) {
  const identity = item.identity ?? {};
  if (!identity.userId) return '用户 ID 尚未采集';
  const label = identity.idKind === 'linuxdo' ? 'LinuxDO ID' : '用户 ID';
  const note = identity.source === 'browser-cache' ? '（登录缓存，待在线核验）' : identity.source === 'configuration' ? '（配置值）' : '';
  return `${label}：${identity.userId}${note}`;
}

export function siteTitle(item) {
  try { const url=new URL(item.origin);return ptSiteDisplayNames[url.origin] || item.displayName || url.hostname; }
  catch { return item.displayName || item.origin || '未知站点'; }
}

export const TASK_FILTERS = [
  ['', '全部任务'],
  ['verified','已核验','核验结果'],
  ['proof','待补证','核验结果'],
  ['actionable','待处理','核验结果'],
  ['waiting','等待执行','核验结果'],
  ['excluded','已排除','核验结果'],
  ['completed', '成功回执'],
  ['pending', '尚未完成'],
  ['external', '等待外部条件'],
  ['verification', '结果待核验'],
  ['unavailable', '未开放'],
  ['cancelled', '已取消'],
  ['attention', '需关注'],
  ['deferred', '已延迟'],
  ['login_required', '需登录'],
  ['identity_review','身份复核'],
  ['failed','执行异常'],
];

export const normalizeTaskFilter = value => value === 'not_available' ? 'unavailable'
  : ['success','signed','already_signed'].includes(value) ? 'completed' : value;

export function matchesTask(task, { status = '', query = '',now=Date.now() } = {}) {
  status = normalizeTaskFilter(status);
  const display=taskDisplayStatus(task,now);
  const statusGroups = {
    completed: ['signed'],
    pending: ['deferred', 'needs_attention', 'failed', 'unknown', 'not_started', 'login_required','external','verification','waiting'],
    attention: ['needs_attention', 'failed', 'unknown', 'not_started'],
    login_required: ['login_required'],
    unavailable: ['not_available'],
  };
  const statusGroup=Object.hasOwn(statusGroups,status)?statusGroups[status]:null;
  const statusMatch = !status || (['verified','proof','actionable','waiting','excluded'].includes(status)?taskResultBucket(task,now)===status:
    status==='identity_review'?taskResultBucket(task,now)==='actionable'&&
      ['identity_conflict','account_mismatch','identity_mismatch'].some(code=>[task.condition,task.failureCode,task.evidence?.verification].includes(code)):
    statusGroup ? statusGroup.includes(display) : display === status);
  const haystack = [task.origin, siteTitle(task), task.displayName, task.logicalSiteKey, task.accountRef, task.taskId,
    task.identity?.username, task.identity?.userId, task.identity?.label].join(' ').toLowerCase();
  return statusMatch && haystack.includes(query.trim().toLowerCase());
}

export function ledgerPendingCount(record) {
  const counts = record?.counts?.status ?? {};
  const total = record?.counts?.executionUnits ?? 0;
  return Math.max(0, total - (counts.signed ?? 0) - (counts.already_signed ?? 0) - (counts.not_available ?? 0));
}

export function ledgerCancelledCount(record){
  return Math.min(record?.counts?.status?.not_available??0,(record?.taskSummaries??record?.tasks??[]).filter(cancelledTask).length);
}

export function matchesLedger(record, filter = 'all') {
  if (filter === 'pending') return ledgerPendingCount(record) > 0;
  if (filter === 'changed') return (record?.drift?.statusChanges??[]).some(visibleLedgerChange)
    || record?.drift?.classification === 'plan_changed' || (record?.changes??[]).some(visibleLedgerChange);
  return true;
}

export function visibleLedgerChange(change={}) {
  return !((!change.kind||change.kind==='status')&&['signed','already_signed'].includes(change.from)&&
    ['signed','already_signed'].includes(change.to));
}

export function matchesPt(site, scope = '') {
  const category = ptStatusCategory(site);
  const evidenceState = ptEvidenceState(site);
  return !scope || (scope === 'monitor' && !site.inLegacyPlan) || (scope === 'plan' && site.inLegacyPlan)
    || (scope === 'fresh' && site.effective?.fresh)
    || (scope === 'confirmed' && category === 'confirmed')
    || (scope === 'reported' && category === 'reported')
    || (scope === 'review' && (site.inLegacyPlan===true||site.fallbackEnabled===true) &&
      !['monitor_only_unconfirmed','external_blocked','harvest_waiting'].includes(evidenceState) && category === 'unknown')
    || (scope === 'waiting' && evidenceState === 'harvest_waiting')
    || (scope === 'monitor_unconfirmed' && evidenceState === 'monitor_only_unconfirmed')
    || (scope === 'verification' && evidenceState === 'verification_pending')
    || (scope === 'external' && evidenceState === 'external_blocked');
}

// New snapshots carry this classification explicitly. Old snapshots retain
// a safe compatible view; bookmark inventory must never imply execution.
export function ptEvidenceState(site) {
  if(site?.harvestWaiting&&harvestWindowActive(site.harvestWaiting))return 'harvest_waiting';
  const states=['confirmed','guarded_read_needed','not_signed_confirmed','verification_pending',
    'monitor_only_unconfirmed','external_blocked','unavailable','disabled','unconfirmed'];
  if(states.includes(site?.evidenceState))return site.evidenceState;
  const e=site?.effective??{};
  if(e.fresh!==false&&['signed','already_signed'].includes(e.status)&&e.authoritative===true)return 'confirmed';
  if(e.fresh!==false&&['site_maintenance','site_migration','bookmark_origin_changed'].includes(ptStatusCondition(site)))return 'external_blocked';
  if(e.failureCode==='submission_outcome_unknown'||['submission_outcome_unknown','unverified_prior_attempt'].includes(site?.recovery?.code))return 'verification_pending';
  if(!site?.inLegacyPlan&&!site?.fallbackEnabled)return 'monitor_only_unconfirmed';
  if(e.fresh!==false&&e.status==='not_available'&&e.authoritative===true)return 'unavailable';
  if(e.fresh!==false&&e.status==='not_signed'&&e.authoritative===true)return 'not_signed_confirmed';
  return 'guarded_read_needed';
}

export const PT_EVIDENCE_LABELS = Object.freeze({
  harvest_waiting:'等待 Harvest',
  confirmed:'已签到',guarded_read_needed:'待只读复核',not_signed_confirmed:'今日未签到',
  verification_pending:'提交待核验',monitor_only_unconfirmed:'观测未确认',
  external_blocked:'等待外部条件',unavailable:'未开放',disabled:'已取消',unconfirmed:'状态未确认'
});

export function ptStatusCondition(site) {
  if(site?.harvestWaiting&&harvestWindowActive(site.harvestWaiting))return 'harvest_waiting';
  const effective=site?.effective??{};
  if(effective.fresh!==false&&effective.siteCondition==='site_maintenance')return 'site_maintenance';
  if(effective.fresh!==false&&!['signed','already_signed','not_available'].includes(effective.status)){
    const moved=[effective,...(site?.observations??[]).filter(item=>item.fresh===true)]
      .flatMap(item=>[item.failureCode,item.underlyingFailureCode])
      .find(code=>['site_migration','bookmark_origin_changed'].includes(code));
    if(moved)return moved;
  }
  if(effective.failureCode==='submission_outcome_unknown'||
    ['submission_outcome_unknown','unverified_prior_attempt'].includes(site?.recovery?.code))return 'submission_outcome_unknown';
  return effective.retryCause;
}

export function ptStatusCategory(site) {
  const status=site?.effective?.status,authoritative=site?.effective?.authoritative===true;
  if(site?.effective?.fresh===false)return 'unknown';
  if(['signed','already_signed'].includes(status))return authoritative?'confirmed':'reported';
  if(status==='not_available'&&authoritative)return 'unavailable';
  return 'unknown';
}
