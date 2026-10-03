import fs from 'node:fs';
import path from 'node:path';
import {ptExecutionBinding,ptReadPolicy} from './pt-read-policy.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

// Read an already-verified passive receipt, not a URL. This lets the mature
// executor close its quarantine without opening or resubmitting the site.
function boundPtObservation(root,target,config,now,statuses){
  try{
    const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
    if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot))return null;
    const runtime=JSON.parse(fs.readFileSync(path.join(integration.v2ProjectRoot,'config/runtime.local.json'),'utf8'));
    if(runtime.executionEngine!=='v1'||path.resolve(runtime.legacyRoot).toLowerCase()!==path.resolve(root).toLowerCase())return null;
    const day=dayAt(now),file=path.join(integration.v2ProjectRoot,'outputs','pt-fallback-results-'+day+'.json');
    const report=JSON.parse(fs.readFileSync(file,'utf8'));
    if(report.source!=='execution-supplement'||report.businessDate!==day||!Array.isArray(report.sites))return null;
    const matches=report.sites.filter(site=>site.origin===target.origin);
    if(matches.length!==1)return null;
    const result=matches[0],policy=ptReadPolicy(target.origin,config);
    const binding=policy.nativeMainChrome===true?nativePtReadBinding(config,{...target,accountKey:target.accountKey??'site-default'}):
      ptExecutionBinding(config,root,target);
    const observed=Date.parse(result.observedAt),confirmed=Date.parse(result.evidence?.confirmedAt);
    if(!statuses.includes(result.status)||result.evidence?.authoritative!==true||
       !['pt_page','page_text','api'].includes(result.evidence.source)||result.evidence.evidenceScope!=='site_account_day'||
       result.submissionAttempted!==false||result.submissionOutcomeUnknown===true||
       result.operationMode!==policy.mode||result.readSafety!=='reviewed_passive'||
       result.profileBinding!==binding.profileBinding||result.accountKey!==binding.accountKey||
       result.businessDate!==day||result.evidence.businessDate!==day||
       result.evidence.pagePath!==new URL(policy.url).pathname||
       !Number.isFinite(observed)||!Number.isFinite(confirmed)||observed>now.getTime()+60_000||
       confirmed>observed+60_000||dayAt(observed)!==day||dayAt(confirmed)!==day)return null;
    return result;
  }catch{return null;}
}

export function verifiedPtObservation(root,target,config,now=new Date()){
    const result=boundPtObservation(root,target,config,now,['signed','already_signed']);
    if(!result)return null;
    const day=dayAt(now);
    return {status:'already_signed',reason:'执行 Profile 的同日只读回执确认已签到，无需重复提交',
      submissionAttempted:false,profileBinding:result.profileBinding,
      operationMode:result.operationMode,readSafety:result.readSafety,
      ...(target.accountKey?{accountKey:target.accountKey}:{}),
      reconciliation:{kind:'confirmed_external',observedAt:result.observedAt,accountKey:result.accountKey},
      evidence:{source:result.evidence.source,authoritative:true,businessDate:day,
        confirmedAt:result.evidence.confirmedAt,statusSignal:result.evidence.statusSignal,
        pagePath:result.evidence.pagePath,evidenceScope:'site_account_day'}};
}

// A generic homepage label is not proof of a submission. Reopen only that
// narrow case using a newer exact-account passive proof, never a submitted or
// authoritative success and never an unresolved write intent.
export function recoverablePtHomepage(root,target,prior,config,reportedAt,now=new Date()){
  if(!['signed','already_signed'].includes(prior?.status)||prior.evidence?.authoritative===true||
    prior.submissionAttempted===true||prior.failureCode==='submission_outcome_unknown')return null;
  let policy;try{policy=ptReadPolicy(target.origin,config);}catch{return null;}
  if(!policy.dailyHeader||prior.url!==policy.url)return null;
  const result=boundPtObservation(root,target,config,now,['not_signed']);
  const at=Date.parse(result?.evidence?.confirmedAt??''),reported=Date.parse(reportedAt??'');
  if(!result||!Number.isFinite(reported)||at<reported||at>now.getTime()||now.getTime()-at>5*60_000||
    Math.abs(Date.parse(result.observedAt)-at)>60_000||result.evidence.statusSignal!=='nexus_daily_header_unsigned')return null;
  return result;
}
