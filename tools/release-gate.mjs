import {assertManualHandoffState} from './release-lib.mjs';

const dayCodes=new Set(['final_report_today','no_retry_pending','harvest_settled','evidence_settled','notifications_flushed']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const time=value=>typeof value==='string'?Date.parse(value):NaN;
export const shanghaiDay=value=>new Intl.DateTimeFormat('en-CA',{
  timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'
}).format(new Date(value));
const requireValue=(condition,reason)=>{if(!condition)throw Error(reason);};
function read(entry,label){
  requireValue(entry?.ok===true,`${label}: ${['missing','invalid_json','read_failed','fields_missing','unavailable'].includes(entry?.error)?entry.error:'missing or unreadable evidence'}`);
  requireValue(entry.value!==undefined&&entry.value!==null,`${label}: fields missing`);
  return entry.value;
}
const count=value=>Number.isSafeInteger(value)&&value>=0;
function sameDayTime(value,today,label){
  if(value===null)return false;
  requireValue(Number.isFinite(time(value)),`${label}: invalid or missing timestamp`);
  return shanghaiDay(value)<=today;
}
function finalDay(report){
  requireValue(typeof report.runId==='string'&&/^\d{8}-[A-Za-z0-9-]+$/.test(report.runId),'final report: runId missing or invalid');
  const day=report.runId.slice(0,8);
  return `${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6,8)}`;
}
export function releaseTasks(snapshot){
  const tasks=read(snapshot?.tasks,'tasks');
  requireValue(Array.isArray(tasks)&&tasks.length>=2,'tasks: main and sync tasks required');
  requireValue(['main','sync'].every(role=>tasks.some(task=>task.role===role))&&new Set(tasks.map(task=>task.role)).size===tasks.length,'tasks: roles missing or duplicated');
  for(const task of tasks){
    requireValue(typeof task.state==='string'&&Number.isFinite(task.nextRunMs)&&Number.isFinite(time(task.lastRun))&&
      Number.isSafeInteger(task.lastResult)&&/^[a-f0-9]{64}$/.test(task.definitionHash??''),'tasks: fields missing or invalid');
  }
  return tasks;
}

// Snapshot entries are explicit read results, not truthy defaults. Only the
// caller performs I/O; failures and incomplete projections stay closed here.
export function evaluateReleaseGate(snapshot,{now,overrideDayGate}={}){
  const at=new Date(now).getTime(),checks={},reasons=[];
  const validNow=Number.isFinite(at),today=validNow?shanghaiDay(at):null;
  const override=typeof overrideDayGate==='string'&&overrideDayGate.trim().length>0;
  function check(code,run){
    try{
      requireValue(validNow,'current time missing or invalid');
      requireValue(snapshot?.schemaVersion===1&&Number.isFinite(time(snapshot.capturedAt))&&
        time(snapshot.capturedAt)<=at+5_000&&at-time(snapshot.capturedAt)<30_000,'snapshot missing, invalid or stale');
      run();checks[code]={ok:true};
    }catch(error){checks[code]={ok:false,reason:error.message};reasons.push(`${code}: ${error.message}`);}
  }
  check('tasks_ready',()=>{
    const tasks=releaseTasks(snapshot);
    requireValue(tasks.every(task=>task.state==='Ready'),'not all tasks are Ready');
    requireValue(tasks.every(task=>task.nextRunMs-at>75_000),'next trigger is within 75 seconds');
  });
  check('no_active_process',()=>{
    const value=read(snapshot?.processes,'processes');
    requireValue(count(value.count)&&Array.isArray(value.roles),'processes: fields missing');
    requireValue(value.count===0&&value.roles.length===0,'project processes are active');
  });
  check('no_pt_lifecycle',()=>{
    const value=read(snapshot?.lifecycle,'lifecycle');
    requireValue(typeof value.exists==='boolean','lifecycle: existence unknown');
    requireValue(!value.exists,'PT lifecycle marker exists');
  });
  check('no_manual_session',()=>{
    const values=read(snapshot?.manualSessions,'manual sessions');
    requireValue(Array.isArray(values)&&values.length===3,'manual session coverage missing');
    for(const value of values){
      requireValue(typeof value.exists==='boolean','manual session existence unknown');
      if(!value.exists)continue;
      requireValue(typeof value.state==='string'&&typeof value.pidActive==='boolean','manual session fields missing');
      assertManualHandoffState(value,()=>value.pidActive);
    }
  });
  const daily={
    final_report_today(){
      const report=read(snapshot?.finalReport,'final report');
      requireValue(finalDay(report)===today,'no final report for today in Shanghai');
      requireValue(report.runState==='final'&&report.executionComplete===true&&report.isComplete===true,'today execution has not finished');
      requireValue(Number.isFinite(time(report.finishedAt))&&time(report.finishedAt)<=at,'final report timestamp missing or in the future');
    },
    no_retry_pending(){
      const state=read(snapshot?.scheduler,'scheduler state'),report=read(snapshot?.finalReport,'final report');
      requireValue(state.phase==='finished'&&state.lastAttemptDate===today&&state.reportValid===true&&state.reportExecutionComplete===true&&
        state.lastRunId===report.runId&&count(state.automaticRetryCount),'scheduler state incomplete, stale or still running');
      requireValue(Object.hasOwn(state,'nextEligibleAt')&&Array.isArray(report.results)&&Object.hasOwn(report,'nextRetryAt'),'retry fields missing');
      const scheduled=sameDayTime(state.nextEligibleAt,today,'scheduler nextEligibleAt');
      requireValue(!scheduled,'scheduler retry remains scheduled today');
      requireValue(state.automaticRetryCount===0||state.nextEligibleAt!==null,'automatic retries have no verifiable schedule');
      requireValue(!sameDayTime(report.nextRetryAt,today,'report nextRetryAt'),'report retry remains scheduled today');
      for(const row of report.results){
        requireValue(object(row)&&typeof row.status==='string','retry result fields missing');
        if(row.nextEligibleAt!==undefined&&row.nextEligibleAt!==null){
          requireValue(Number.isFinite(time(row.nextEligibleAt)),'result nextEligibleAt invalid');
          if(row.retryable!==false&&row.submissionAttempted!==true&&row.retryExhaustedForDay!==true)
            requireValue(!sameDayTime(row.nextEligibleAt,today,'result retry'),'result retry remains scheduled today');
        }else if(row.status==='deferred'&&row.retryable!==false&&row.submissionAttempted!==true&&row.retryExhaustedForDay!==true){
          throw Error('deferred result has no verifiable schedule');
        }
      }
      const fallback=read(snapshot?.fallback,'fallback schedule');
      requireValue(Array.isArray(fallback.pending),'fallback schedule fields missing');
      requireValue(fallback.pending.length===0,'fallback automatic steps remain pending');
    },
    harvest_settled(){
      const value=read(snapshot?.harvest,'Harvest');
      requireValue(typeof value.enabled==='boolean','Harvest enablement unknown');
      if(!value.enabled)return;
      requireValue(value.businessDate===today&&Number.isFinite(time(value.generatedAt))&&shanghaiDay(value.generatedAt)===today&&time(value.generatedAt)<=at,'Harvest observation is missing or not from today');
      const task=value.taskCompletion;
      requireValue(object(task)&&['completed','failed'].includes(task.status)&&count(task.resultId)&&task.activeTaskCount===0&&task.activityCoverage==='recorded_results','Harvest task has not verifiably ended');
      requireValue(Number.isFinite(time(task.startedAt))&&Number.isFinite(time(task.completedAt))&&
        shanghaiDay(task.startedAt)===today&&shanghaiDay(task.completedAt)===today&&
        time(task.completedAt)>=time(task.startedAt)&&time(task.completedAt)<=time(value.generatedAt),'Harvest completion timestamps invalid');
      requireValue(value.harvestWindow===null,'Harvest window still scheduled or running');
    },
    evidence_settled(){
      const value=read(snapshot?.evidence,'passive evidence');
      requireValue(typeof value.enabled==='boolean','passive evidence enablement unknown');
      if(!value.enabled)return;
      requireValue(value.businessDate===today&&Array.isArray(value.candidates)&&typeof value.dirtyMarkerPresent==='boolean','passive evidence fields missing or stale');
      requireValue(!value.dirtyMarkerPresent,'passive evidence publication remains pending');
      for(const candidate of value.candidates){
        requireValue(typeof candidate.ptOnly==='boolean'&&typeof candidate.changedReview==='boolean','passive candidate fields missing');
        const old=candidate.previous;
        if(old===null)throw Error('passive evidence review has budget and is due');
        requireValue(object(old)&&typeof old.businessDate==='string'&&count(old.attempts)&&count(old.wakeups)&&
          count(old.totalAttempts)&&Number.isFinite(time(old.nextAttemptAt)),'passive review state fields missing');
        if(old.businessDate!==today)throw Error('passive evidence review has budget and is due');
        const attempts=candidate.changedReview?0:old.attempts;
        if(attempts>=2||old.wakeups>=24||candidate.ptOnly&&old.totalAttempts>=6)continue;
        // A reserved later step today is unfinished too. A next-day step is
        // allowed, and the long-lived business status never enters this test.
        if(candidate.changedReview||sameDayTime(old.nextAttemptAt,today,'passive nextAttemptAt'))
          throw Error('passive evidence review has budget and remains scheduled today');
      }
    },
    notifications_flushed(){
      const value=read(snapshot?.notifications,'notification outbox');
      requireValue(Array.isArray(value),'notification outbox fields missing');
      for(const item of value){
        requireValue(typeof item.delivered==='boolean','notification delivered flag missing');
        requireValue(item.delivered===true,'notification delivery remains pending');
      }
    }
  };
  for(const [code,run] of Object.entries(daily)){
    if(override)checks[code]={ok:true,skipped:true,reason:overrideDayGate.trim()};
    else check(code,run);
  }
  let phase='settled';
  if(!checks.final_report_today.ok)phase='before_run';
  else if([...dayCodes].some(code=>!checks[code].ok))phase='settling';
  if(['tasks_ready','no_active_process','no_pt_lifecycle','no_manual_session'].some(code=>!checks[code].ok))phase='unsafe';
  else if(override)phase='override';
  return {ok:reasons.length===0,phase,reasons,checks};
}

// Verification observes naturally occurring task runs; it never starts one.
export function evaluateReleaseVerification(snapshot,{revision,roots,deployedAt}={}){
  const reasons=[],pending=[];
  const fail=reason=>reasons.push(reason);
  try{
    requireValue(snapshot?.schemaVersion===1&&Number.isFinite(time(snapshot.capturedAt)),'verification snapshot fields missing');
    requireValue(Number.isFinite(time(deployedAt)),'deployment timestamp missing or invalid');
    const markers=read(snapshot?.markers,'release markers');
    requireValue(Array.isArray(roots)&&roots.includes('execution')&&roots.includes('observation'),'runtime roots missing');
    for(const role of roots)requireValue(markers[role]?.revision===revision&&markers[role]?.deployedAt===deployedAt,`${role} release marker mismatch`);
    const tasks=releaseTasks(snapshot),main=tasks.find(task=>task.role==='main'),sync=tasks.find(task=>task.role==='sync');
    const events=read(snapshot?.gatewayEvents,'gateway events');
    requireValue(Array.isArray(events),'gateway events fields missing');
    for(const event of events){
      requireValue(Number.isFinite(time(event.time)),'gateway event timestamp missing or invalid');
      requireValue(time(event.time)<time(deployedAt),'new gateway failure event');
    }
    const lifecycle=read(snapshot?.lifecycle,'lifecycle');
    requireValue(typeof lifecycle.exists==='boolean','lifecycle existence unknown');
    const running=task=>task.state==='Running'||task.lastResult===267009;
    if(lifecycle.exists)requireValue(running(main)||running(sync),'PT lifecycle marker remains after tasks ended');
    for(const task of [sync,main]){
      if(time(task.lastRun)<=time(deployedAt)||running(task)){pending.push(`${task.role}: waiting for a completed natural run`);continue;}
      requireValue(task.state==='Ready',`${task.role} task state rejected`);
      requireValue(task.lastResult===0||task.role==='main'&&task.lastResult===2,`${task.role} task result rejected`);
    }
    const report=read(snapshot?.finalReport,'final report');
    requireValue(Number.isFinite(time(report.finishedAt))&&typeof report.runId==='string','final report fields missing');
    if(time(report.finishedAt)<=time(deployedAt)){
      // Scheduled main runs may no-op after the day is done without a new report.
      pending.push('waiting for a new final report after deployment');
    }else{
      requireValue(report.runState==='final'&&report.isComplete===true&&report.executionComplete===true,'new report is incomplete');
      requireValue(time(report.finishedAt)<=time(snapshot.capturedAt),'final report timestamp is in the future');
    }
  }catch(error){fail(error.message);}
  return {status:reasons.length?'fail':pending.length?'pending':'pass',reasons:[...reasons,...pending]};
}
