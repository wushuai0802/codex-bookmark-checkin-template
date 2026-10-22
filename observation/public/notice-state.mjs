import {externalTask,siteSideTask,taskResultBucket,taskStatusCondition,taskStatusSummary} from './dashboard-model.mjs';

// Presentation-only acknowledgement. Never changes task status or execution.
const STORAGE_KEY = 'fabricReadNotices.v1';
export const noticeKey = task => `${task.businessDate ?? ''}:${task.taskId}:${task.observedStatus}`;
const unresolved = task => !['signed', 'already_signed', 'not_available'].includes(task.observedStatus);
export const pausedNotices = (tasks, now = Date.now()) => tasks.filter(task => unresolved(task)
  && Number.isFinite(Date.parse(task.attention?.pausedUntil)) && Date.parse(task.attention.pausedUntil) > now);
export const pendingNotices = (tasks, now = Date.now()) => tasks.filter(task => unresolved(task)
  && !(Number.isFinite(Date.parse(task.attention?.pausedUntil)) && Date.parse(task.attention.pausedUntil) > now));

export function attentionReason(task){
  const condition=taskStatusCondition(task);
  if(taskResultBucket(task)==='proof')return {label:'回执待补证',filter:'proof',tone:'review',priority:2};
  if(externalTask(task))return {label:taskStatusLabelForWait(condition),filter:'external',tone:'waiting',priority:4};
  if(task.observedStatus==='login_required'||['login_required','upstream_login_required','two_factor_required'].includes(condition))
    return {label:'需登录',filter:'login_required',tone:'urgent',priority:0};
  if(task.observedStatus==='failed')return {label:'执行异常',filter:'failed',tone:'urgent',priority:1};
  if(['identity_conflict','account_mismatch','identity_mismatch'].some(code=>[condition,task.failureCode,task.evidence?.verification].includes(code)))
    return {label:'身份复核',filter:'identity_review',tone:'review',priority:2};
  if(condition==='submission_outcome_unknown')return {label:'提交待核验',filter:'verification',tone:'review',priority:2};
  if(task.observedStatus==='deferred')return {label:'已延后',filter:'deferred',tone:'waiting',priority:3};
  return {label:'需复核',filter:['unknown','not_started'].includes(task.observedStatus)?task.observedStatus:'attention',tone:'review',priority:2};
}
function taskStatusLabelForWait(condition){
  return {site_maintenance:'站点维护',rate_limit:'站点限频',harvest_waiting:'等待上游',site_migration:'站点已迁移',
    bookmark_origin_changed:'地址需核对',entitlement_expired:'权限需检查'}[condition]??'等待外部条件';
}

function groupedPreview(all,limit,pausedCount=0){
  const sorted=[...all].sort((a,b)=>attentionReason(a).priority-attentionReason(b).priority);
  const grouped=new Map();
  for(const task of sorted){
    const key=JSON.stringify([task.businessDate,task.origin,taskStatusCondition(task)??task.observedStatus,taskStatusSummary(task)]);
    const group=grouped.get(key)??{task,tasks:[],origin:task.origin};group.tasks.push(task);grouped.set(key,group);
  }
  const groups=[...grouped.values()];
  return {all:sorted,pausedCount,visible:groups.slice(0,limit),remaining:groups.slice(limit).reduce((n,g)=>n+g.tasks.length,0)};
}

export function overviewQueuePreview(tasks,filter='actionable',limit=4,now=Date.now()){
  const paused=pausedNotices(tasks,now),pausedSet=new Set(paused);
  const inQueue=task=>filter==='external'?siteSideTask(task):taskResultBucket(task)===filter;
  return groupedPreview(tasks.filter(task=>inQueue(task)&&!pausedSet.has(task)),limit,
    paused.filter(inQueue).length);
}
export function attentionPreview(tasks, limit = 4, now = Date.now()) {
  return groupedPreview(pendingNotices(tasks,now),limit,pausedNotices(tasks,now).length);
}

export function createNoticeState(getStorage = () => globalThis.localStorage) {
  let keys = new Set();
  try {
    const saved = JSON.parse(getStorage()?.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(saved)) keys = new Set(saved.filter(key => typeof key === 'string').slice(-2000));
  } catch { /* Blocked storage must not prevent the dashboard from starting. */ }
  return {
    isRead: task => keys.has(noticeKey(task)),
    markRead(tasks) {
      for (const task of tasks) keys.add(noticeKey(task));
      keys = new Set([...keys].slice(-2000));
      try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify([...keys])); } catch { /* Session-only fallback. */ }
    }
  };
}
