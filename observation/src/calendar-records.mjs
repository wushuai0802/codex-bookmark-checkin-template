import {redactText} from './contracts.mjs';
import {displayIdentity,shortLabel} from './display-identity.mjs';
import {calendarPtSummaries} from '../public/calendar-model.mjs';

export function ptCalendarSummaries(ptStatus){
  if(!Array.isArray(ptStatus?.sites))return null;
  return calendarPtSummaries(ptStatus).map((task,index)=>({...task,displayName:shortLabel(task.displayName),identity:displayIdentity({label:'本站账号'}),
    evidence:{source:task.evidence?.source??'none',authoritative:task.evidence?.authoritative===true&&
      ptStatus.sites[index]?.effective?.authoritative===true&&ptStatus.sites[index]?.effective?.fresh===true,
      ...(task.evidence?.verification==='task_disabled'?{verification:'task_disabled',rawSource:'configuration'}:{}),
      summary:redactText(task.evidence?.summary??''),redacted:true}}));
}
