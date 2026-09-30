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

export function ptAttemptReconciled(state,attempt,index){
  return state.reconciliations?.some(r=>r.attemptId===ptAttemptId(attempt,index)&&r.businessDate===state.businessDate&&
    r.origin===attempt.origin&&r.accountKey===(attempt.accountKey??'site-default')&&
    (r.kind==='confirmed_external'||r.kind==='closed_manual'&&r.operatorConfirmed===true||
      r.kind==='confirmed_not_submitted'&&r.submissionAttempted===false));
}

export function loadPtRecoveryDiagnostics(root,businessDate){
  const directory=path.join(root,'outputs'),byOrigin=new Map();
  if(!fs.existsSync(directory))return {businessDate,sites:[]};
  for(const file of fs.readdirSync(directory).sort()){
    const match=/^harvest-fallback-attempts-(\d{4}-\d{2}-\d{2})[.]json$/.exec(file);
    if(!match||match[1]>businessDate)continue;
    const state=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
    if(state.businessDate!==match[1]||!Array.isArray(state.attempts))throw Error('invalid PT attempt journal');
    for(const [index,attempt] of state.attempts.entries()){
      if(ptAttemptReconciled(state,attempt,index))continue;
      const unknown=['in_progress','outcome_unknown','completed_cross_day'].includes(attempt.state)||
        attempt.outcome?.submissionOutcomeUnknown===true||attempt.outcome?.failureCode==='submission_outcome_unknown';
      const unverified=match[1]===businessDate&&attempt.state==='completed'&&
        ['needs_attention','unknown'].includes(attempt.v1Status)&&attempt.outcome?.submissionAttempted!==false;
      if(!unknown&&!unverified)continue;
      if(byOrigin.has(attempt.origin)&&!unverified)continue;
      if(byOrigin.has(attempt.origin)&&byOrigin.get(attempt.origin).code==='prior_outcome_unknown')continue;
      const code=unknown&&match[1]<businessDate?'prior_outcome_unknown':unknown?'submission_outcome_unknown':'unverified_prior_attempt';
      byOrigin.set(attempt.origin,{origin:attempt.origin,code,blockedSince:match[1],
        summary:code==='prior_outcome_unknown'?`${match[1]} 的补签结果尚未结案，须先只读核验当前状态`:
          code==='unverified_prior_attempt'?'今日补签缺少明确结果和提交状态，须先只读核验':'今日提交结果不明，须先只读核验，禁止自动重放'});
    }
  }
  return {businessDate,sites:[...byOrigin.values()]};
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
