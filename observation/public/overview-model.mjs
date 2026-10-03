import {taskDisplayStatus,siteSideTask} from './dashboard-model.mjs';

export function projectOverviewSnapshot(data={}) {
  return {...(data.snapshot??{}),tasks:data.tasks??[],ptStatus:data.ptStatus,readiness:data.readiness,
    snapshotMeta:data.snapshotMeta??data.snapshot?.snapshotMeta,
    evidenceQuality:data.evidenceQuality??data.snapshot?.evidenceQuality,
    status:data.status??data.snapshot?.counts?.status??{},
    counts:{...(data.snapshot?.counts??{}),status:data.status??data.snapshot?.counts?.status??{}}};
}

function successCounts(status={}) {
  const counts={...status};
  if(Object.hasOwn(counts,'signed')||Object.hasOwn(counts,'already_signed')){
    const count=value=>Number.isInteger(value)&&value>=0?value:0;
    counts.signed=count(counts.signed)+count(counts.already_signed);
    delete counts.already_signed;
  }
  return counts;
}

export function overviewStatusCounts(data={}) {
  const total=data.counts?.executionUnits;
  if(!Array.isArray(data.tasks)||data.tasks.length!==total){
    const status=successCounts(data.status??data.counts?.status??{});
    const cancelled=Math.min(status.not_available??0,Number.isInteger(data.evidenceQuality?.cancelled)?Math.max(0,data.evidenceQuality.cancelled):0);
    if(cancelled){status.not_available-=cancelled;status.cancelled=cancelled;}
    return status;
  }
  return successCounts(data.tasks.reduce((counts,task)=>{
    const status=taskDisplayStatus(task);
    counts[status]=(counts[status]??0)+1;return counts;
  },{}));
}

export function overviewMetrics(data = {}, now = Date.now()) {
  const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
  const status = overviewStatusCounts(data);
  const total = count(data.counts?.executionUnits);
  const success = count(status.signed) + count(status.already_signed);
  const unavailable = count(status.not_available);
  const cancelled = count(status.cancelled);
  const verifiedSuccess = Math.min(success, count(data.evidenceQuality?.verifiedSuccess));
  const unverifiedSuccess = success - verifiedSuccess;
  const verifiedUnavailable = Math.min(unavailable, count(data.evidenceQuality?.verifiedUnavailable));
  const unverifiedUnavailable = unavailable - verifiedUnavailable;
  const pending = Math.max(0, total - success - unavailable - cancelled);
  const excludedSiteIssues=Array.isArray(data.tasks)&&data.tasks.length===total
    ?Math.min(pending,data.tasks.filter(siteSideTask).length):0;
  const eligible=Math.max(0,total-verifiedUnavailable-cancelled-excludedSiteIssues);
  const manual = count(status.needs_attention) + count(status.login_required) + count(status.failed) + count(status.verification);
  const age = now - Date.parse(data.generatedAt ?? '');
  const healthAge = now - Date.parse(data.health?.sourceCheckedAt ?? '');
  const businessDate = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date(now));
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= 26 * 3_600_000
    && (!data.businessDate || data.businessDate === businessDate)
    && data.snapshotMeta?.generationStale!==true&&data.snapshotMeta?.fresh!==false;
  const healthFresh = data.health?.freshness?.fresh === true && Number.isFinite(healthAge)
    && healthAge >= -60_000 && healthAge <= 26 * 3_600_000;
  return {
    total, success, unavailable, cancelled, pending, manual, verifiedSuccess, unverifiedSuccess, verifiedUnavailable, unverifiedUnavailable,excludedSiteIssues,
    executionRate: total ? Math.round(success / total * 100) : null,
    deferred: count(status.deferred),external:count(status.external),
    eligible,
    rate: eligible ? Math.round(verifiedSuccess / eligible * 100) : null,
    fresh, healthFresh,
    healthy: data.health?.healthy === true && healthFresh,
    allResolved: total > 0 && pending === 0 && unverifiedSuccess === 0 && unverifiedUnavailable === 0,
    ageMinutes: Number.isFinite(age) ? Math.max(0, Math.floor(age / 60_000)) : null,
  };
}

export function dailySummaryTitle(metrics, {previousDay = false, pausedCount = 0} = {}) {
  if (!metrics.total) return '等待今日签到数据';
  if (previousDay) return '等待今日签到结果';
  if (!metrics.fresh) return '当前数据已过期';
  if (metrics.allResolved) return '今日签到项已全部确认';
  if(metrics.excludedSiteIssues&&metrics.unverifiedSuccess===0&&metrics.unverifiedUnavailable===0){
    const localPending=metrics.pending-metrics.excludedSiteIssues;
    if(localPending===0)return metrics.eligible>0
      ?`项目签到已完成 · ${metrics.excludedSiteIssues} 个站点待恢复`
      :`${metrics.excludedSiteIssues} 个站点待恢复`;
    return `还有 ${localPending} 个项目签到项待处理 · ${metrics.excludedSiteIssues} 个站点待恢复`;
  }
  if (metrics.pending) return pausedCount
    ? `${metrics.pending} 项未完成 · ${Math.min(pausedCount, metrics.pending)} 项暂缓关注`
    : `还有 ${metrics.pending} 个签到项待处理`;
  return '执行回执已收齐，成功证据待补录';
}

export const statusColors = { signed: '#36c99b', already_signed: '#36c99b', not_available: '#bbc6d4', cancelled:'#91a4b7', needs_attention: '#ffc65c', deferred: '#b69cf6', external:'#b69cf6',verification:'#ffc65c', login_required: '#ffac70', failed: '#ff7f93', unknown: '#91a4b7',not_started:'#91a4b7' };
export function statusGradient(status = {}) {
  const entries = Object.entries(successCounts(status)).filter(([, n]) => Number.isInteger(n) && n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '#e8edf3';
  let start = 0;
  return `conic-gradient(${entries.map(([key, n]) => {
    const end = start + n / total * 100;
    const segment = `${statusColors[key] ?? statusColors.unknown} ${start}% ${end}%`;
    start = end; return segment;
  }).join(',')})`;
}
