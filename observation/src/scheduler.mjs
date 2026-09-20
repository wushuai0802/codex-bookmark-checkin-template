import {normalizeOrigin, taskIdentity} from './contracts.mjs';

function parseSchedule(value) {
  const match=/^(\d{2}):(\d{2})$/.exec(String(value??''));
  if(!match||Number(match[1])>23||Number(match[2])>59) throw Error('schedule must be HH:mm');
  return {hour:Number(match[1]),minute:Number(match[2])};
}

export function buildDailyDispatchPlan({tasks=[],businessDate,schedule='08:05',owners={},now=new Date().toISOString()}={}) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate??''))) throw Error('businessDate is invalid');
  if(!Number.isFinite(Date.parse(now))) throw Error('now is invalid');
  const at=parseSchedule(schedule), day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(now));
  const due=day===businessDate && (new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(now)) >= `${String(at.hour).padStart(2,'0')}:${String(at.minute).padStart(2,'0')}`);
  const seen=new Set(), dispatch=[], blocked=[];
  for(const source of tasks){
    if(!source||source.monitorOnly===true||source.executionMode==='monitor_only'){blocked.push({origin:source?.origin??null,accountKey:source?.accountKey??null,reason:'monitor_only'});continue;}
    const origin=normalizeOrigin(source.origin), accountKey=String(source.accountKey||'site-default'), key=`${origin}|${accountKey}`;
    if(seen.has(key)){blocked.push({origin,accountKey,reason:'duplicate_task'});continue;} seen.add(key);
    const owner=owners[key]??source.executionOwner??'legacy-checkin';
    if(!['legacy-checkin','v2-worker'].includes(owner)){blocked.push({origin,accountKey,reason:'unknown_owner'});continue;}
    const identity=taskIdentity({businessDate,logicalSiteKey:origin,accountKey,actionType:source.actionType??'checkin',scheduleOccurrence:'daily'});
    dispatch.push({...identity,origin,logicalSiteKey:origin,accountKey,businessDate,actionType:source.actionType??'checkin',executionOwner:owner,due,eligible:due&&owner==='v2-worker'});
  }
  return {schemaVersion:1,mode:'v2_dispatch_plan',businessDate,schedule,generatedAt:new Date(now).toISOString(),due,executionEnabled:false,dispatch,blocked};
}
