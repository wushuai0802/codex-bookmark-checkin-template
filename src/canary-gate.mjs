import {planHash} from './contracts.mjs';
import {snapshotSafetyReasons} from './freshness.mjs';

const terminal=new Set(['signed','already_signed','not_available']);
export function evaluateCanaryGate({snapshot,acceptance,worker,taskId,now=new Date().toISOString(),requiredDays=7}={}){
 const reasons=[];const task=snapshot?.tasks?.find(item=>item.taskId===taskId);
 if(snapshot?.mode!=='shadow_read_only')reasons.push('snapshot_not_shadow');
 if(snapshot?.planHash!==planHash(snapshot?.tasks??[]))reasons.push('plan_hash_invalid');
 reasons.push(...snapshotSafetyReasons(snapshot,now));
 if(!acceptance?.accepted||Number(acceptance.eligibleRecentDays)<requiredDays)reasons.push('shadow_acceptance_incomplete');
 if(acceptance?.invalidRecords?.length)reasons.push('shadow_history_invalid');
 if(acceptance?.ownerConflictRecords>0)reasons.push('shadow_owner_conflict');
 if(!task)reasons.push('task_not_found');
 else {
  if(task.executionOwner!=='legacy-checkin')reasons.push('unexpected_current_owner');
  if(!terminal.has(task.observedStatus))reasons.push('task_not_terminal');
  if(task.identity?.source==='browser-cache'||task.identity?.source==='configuration')reasons.push('identity_not_live_verified');
  if(task.identity?.userId==null)reasons.push('identity_missing');
 }
 if(!worker?.profileIsolation||worker?.executionModes?.includes('execute')!==true)reasons.push('worker_not_execute_capable');
 if(worker?.allowedOrigins?.includes(task?.origin)!==true)reasons.push('origin_not_allowlisted');
 return {schemaVersion:1,evaluatedAt:new Date(now).toISOString(),taskId:taskId??null,accepted:reasons.length===0,reasons,executionEnabled:false,leaseGranted:false};
}
