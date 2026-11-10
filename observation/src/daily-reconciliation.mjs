export {confirmedPtByTask} from '../public/pt-evidence.mjs';
import {authorizedWorkload} from './workload-view.mjs';
import {harvestOverdue,harvestDeadlinePassed} from '../public/harvest-overdue.mjs';
import {dayVerdict} from '../public/day-verdict.mjs';

// Shared by the dashboard and the daily notification projection. This reads
// already-published evidence and cannot change execution or submission history.
export function verdictSnapshot(snapshot,{now=new Date()}={}){
  const workload=authorizedWorkload({...snapshot,now:new Date(now).getTime()});
  return {...snapshot,tasks:workload.tasks};
}

export function harvestOutage(snapshot,{now=new Date()}={}){
  const context=snapshot.ptStatus?.harvestAvailability,time=new Date(now).getTime();
  if(!context||!harvestDeadlinePassed(time,context.overdueAt))return null;
  const projected=verdictSnapshot(snapshot,{now}),verdict=dayVerdict(projected,{now});
  if(snapshot.businessDate!==verdict.businessDate)return null;
  const included=new Set(verdict.items.filter(item=>!['done','paused','noFeature','external'].includes(item.class)).map(item=>item.taskId));
  const origins=new Set(projected.tasks.filter(task=>included.has(task.taskId)).map(task=>task.origin));
  const sites=(snapshot.ptStatus.sites??[]).filter(site=>origins.has(site.origin));
  const overdue=sites.flatMap(site=>{const state=harvestOverdue(site,snapshot.ptStatus,time);return state?[{site,...state}]:[];});
  return {businessDate:verdict.businessDate,unresolved:overdue.length,
    unavailable:overdue.filter(value=>value.reasonCode==='harvest_overdue_unavailable').length,
    incomplete:overdue.filter(value=>value.reasonCode==='harvest_overdue_incomplete').length,
    takenOver:(snapshot.ptStatus.sites??[]).filter(site=>site.harvestTakeover?.businessDate===verdict.businessDate).length,
    needsHuman:overdue.filter(value=>!value.canTakeOver).length,
    pendingTakeover:overdue.filter(value=>value.canTakeOver&&value.site.harvestTakeover?.businessDate!==verdict.businessDate).length,
    origins:[...new Set(overdue.map(value=>value.site.origin))].sort()};
}
