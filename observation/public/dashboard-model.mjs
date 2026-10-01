import {conditionLabels,statusLabels,externalRetryCauses} from './checkin-contract.generated.mjs';

export function taskStatusLabel(task){return (!['signed','already_signed','not_available'].includes(task?.observedStatus)?conditionLabels[task?.condition]:null)??statusLabels[task?.observedStatus]??task?.observedStatus;}
export function externalTask(task){return !['signed','already_signed','not_available'].includes(task?.observedStatus)&&
  [...externalRetryCauses,'site_maintenance','entitlement_expired'].includes(task?.condition);}

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
  try { return item.displayName || new URL(item.origin).hostname; }
  catch { return item.displayName || item.origin || '未知站点'; }
}

export const TASK_FILTERS = [
  ['', '全部任务'],
  ['completed', '已完成'],
  ['pending', '尚未完成'],
  ['external', '等待外部条件'],
  ['verification', '结果待核验'],
  ['unavailable', '未开放'],
  ['attention', '需关注'],
  ['deferred', '已延迟'],
  ['login_required', '需登录'],
];

export const normalizeTaskFilter = value => value === 'not_available' ? 'unavailable'
  : value === 'success' ? 'completed' : value;

export function matchesTask(task, { status = '', query = '' } = {}) {
  status = normalizeTaskFilter(status);
  const value = task.observedStatus;
  const statusGroups = {
    completed: ['signed', 'already_signed'],
    pending: ['deferred', 'needs_attention', 'failed', 'unknown', 'not_started', 'login_required'],
    attention: ['needs_attention', 'failed', 'unknown', 'not_started'],
    login_required: ['login_required'],
    unavailable: ['not_available'],
  };
  const statusMatch = !status || (status==='external'?externalTask(task):status==='verification'?!['signed','already_signed','not_available'].includes(value)&&task.condition==='submission_outcome_unknown':
    status==='attention'?statusGroups.attention.includes(value)&&!externalTask(task)&&task.condition!=='submission_outcome_unknown':
    statusGroups[status] ? statusGroups[status].includes(value) : value === status);
  const haystack = [task.origin, task.displayName, task.logicalSiteKey, task.accountRef, task.taskId,
    task.identity?.username, task.identity?.userId, task.identity?.label].join(' ').toLowerCase();
  return statusMatch && haystack.includes(query.trim().toLowerCase());
}

export function ledgerPendingCount(record) {
  const counts = record?.counts?.status ?? {};
  const total = record?.counts?.executionUnits ?? 0;
  return Math.max(0, total - (counts.signed ?? 0) - (counts.already_signed ?? 0) - (counts.not_available ?? 0));
}

export function matchesLedger(record, filter = 'all') {
  if (filter === 'pending') return ledgerPendingCount(record) > 0;
  if (filter === 'changed') return (record?.drift?.statusChanges?.length ?? 0) > 0
    || record?.drift?.classification === 'plan_changed' || (record?.changes?.length ?? 0) > 0;
  return true;
}

export function matchesPt(site, scope = '') {
  const category = ptStatusCategory(site);
  return !scope || (scope === 'monitor' && !site.inLegacyPlan) || (scope === 'plan' && site.inLegacyPlan)
    || (scope === 'fresh' && site.effective?.fresh)
    || (scope === 'confirmed' && category === 'confirmed')
    || (scope === 'reported' && category === 'reported')
    || (scope === 'review' && (site.inLegacyPlan===true||site.fallbackEnabled===true) && category === 'unknown');
}

export function ptStatusCondition(site) {
  const effective=site?.effective??{};
  if(effective.fresh!==false&&effective.siteCondition==='site_maintenance')return 'site_maintenance';
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
