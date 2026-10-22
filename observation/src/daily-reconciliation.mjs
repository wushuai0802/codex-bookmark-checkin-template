import {classifyPtEvidenceState} from './pt-status.mjs';

// Shared by the dashboard and the daily notification projection. This reads
// already-published evidence and cannot change execution or submission history.
export function confirmedPtByTask(snapshot){
  if(snapshot?.ptStatus?.businessDate!==snapshot?.businessDate)return new Map();
  const counts=new Map();
  for(const task of snapshot?.tasks??[])counts.set(task.origin,(counts.get(task.origin)??0)+1);
  const verified=new Map();
  for(const site of snapshot?.ptStatus?.sites??[]){
    const current=site?.effective,at=Date.parse(current?.observedAt??'');
    if(classifyPtEvidenceState(site)!=='confirmed'||!['signed','already_signed'].includes(current?.status)||current?.authoritative!==true||
       current?.evidence?.authoritative!==true||
       current?.fresh!==true||!Number.isFinite(at)||at>Date.parse(snapshot.generatedAt)+60_000||
       new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at))!==snapshot.businessDate)continue;
    if(!site.accountRef&&counts.get(site.origin)!==1)continue;
    verified.set(site.origin+'|'+(site.accountRef??'site-default'),current);
  }
  return verified;
}
