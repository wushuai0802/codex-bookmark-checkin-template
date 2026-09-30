import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
import {projectPtSiteResult} from './pt-site-execution.mjs';
import {redactText} from './contracts.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
export function ptAttemptId(attempt,index){
  return attempt.attemptId??('legacy_'+crypto.createHash('sha256').update(JSON.stringify([
    attempt.origin,attempt.accountKey??'site-default',attempt.startedAt,attempt.state,index])).digest('hex').slice(0,24));
}
export function listPtAttempts(root,businessDate){
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(businessDate??''))throw Error('invalid business date');
  const state=JSON.parse(fs.readFileSync(path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json'),'utf8'));
  if(state.businessDate!==businessDate||!Array.isArray(state.attempts))throw Error('invalid attempt journal');
  return state.attempts.map((item,index)=>({attemptId:ptAttemptId(item,index),origin:item.origin,
    accountKey:item.accountKey??'site-default',state:item.state,startedAt:item.startedAt}));
}

// Reconciliation is append-only evidence, never deletion or reset of attempts.
// Old attempts without an exact profile binding require manual investigation.
export function reconcilePtAttempt({root,businessDate,attemptId,receipt,kind='confirmed_external',acknowledgement=null,note='',now=new Date()}={}){
  if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(businessDate??'')||typeof attemptId!=='string')throw Error('invalid reconciliation identity');
  const lease=acquireExecutionLock(root,{name:'harvest-fallback.lock'});
  try{
    const file=path.join(root,'outputs','harvest-fallback-attempts-'+businessDate+'.json');
    const state=JSON.parse(fs.readFileSync(file,'utf8'));
    if(state.businessDate!==businessDate||!Array.isArray(state.attempts))throw Error('invalid attempt journal');
    const matches=state.attempts.filter((attempt,index)=>ptAttemptId(attempt,index)===attemptId);
    if(matches.length!==1)throw Error('attempt identity missing or ambiguous');
    const attempt=matches[0];
    let resolution;
    if(kind==='confirmed_external'){
    const result=projectPtSiteResult(receipt,attempt.origin);
    const binding=attempt.profileBinding??attempt.outcome?.profileBinding;
    const confirmed=Date.parse(result.evidence?.confirmedAt),observed=Date.parse(result.observedAt);
    if(!/^[a-f0-9]{64}$/.test(binding??'')||binding!==result.profileBinding||
       result.accountKey!==(attempt.accountKey??'site-default')||result.submissionAttempted!==false||
       !['safe_status_endpoint','safe_history_page'].includes(result.operationMode)||result.readSafety!=='reviewed_passive'||
       !['signed','already_signed'].includes(result.status)||result.evidence.authoritative!==true||
       !Number.isFinite(confirmed)||!Number.isFinite(Date.parse(attempt.startedAt))||confirmed<Date.parse(attempt.startedAt)-60_000||
       observed>now.getTime()+60_000||dayAt(observed)!==businessDate||dayAt(confirmed)!==businessDate||
       result.businessDate!==businessDate||result.evidence.businessDate!==businessDate)throw Error('receipt does not prove this account/profile/day');
    resolution={schemaVersion:1,attemptId,kind:'confirmed_external',origin:attempt.origin,accountKey:result.accountKey,
      businessDate,profileBinding:binding,confirmedAt:result.evidence.confirmedAt,observedAt:result.observedAt,
      reconciledAt:now.toISOString(),operationMode:result.operationMode,status:result.status};
    }else if(kind==='closed_manual'){
      if(acknowledgement!=='reviewed-this-attempt-no-same-day-replay'||typeof note!=='string'||note.trim().length<10||note.length>240)
        throw Error('explicit operator review is required');
      resolution={schemaVersion:1,attemptId,kind,origin:attempt.origin,accountKey:attempt.accountKey??'site-default',businessDate,
        operatorConfirmed:true,note:redactText(note),reconciledAt:now.toISOString(),status:'unknown'};
    }else if(kind==='confirmed_not_submitted'){
      if(attempt.submissionState!=='not_submitted'||attempt.outcome?.submissionAttempted!==false||
        attempt.outcome?.submissionOutcomeUnknown===true||attempt.outcome?.failureCode==='submission_outcome_unknown')
        throw Error('executor has not proven non-submission');
      resolution={schemaVersion:1,attemptId,kind,origin:attempt.origin,accountKey:attempt.accountKey??'site-default',businessDate,
        submissionAttempted:false,reconciledAt:now.toISOString(),status:'unknown'};
    }else throw Error('invalid reconciliation kind');
    state.reconciliations??=[];
    const existing=state.reconciliations.find(item=>item.attemptId===attemptId);
    if(existing)return existing;
    state.reconciliations.push(resolution);
    const temporary=file+'.'+crypto.randomUUID()+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.rmSync(temporary);}
    return resolution;
  }finally{releaseExecutionLock(lease);}
}
