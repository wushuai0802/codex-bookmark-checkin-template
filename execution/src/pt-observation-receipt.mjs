import fs from 'node:fs';
import path from 'node:path';
import {ptExecutionBinding,ptReadPolicy} from './pt-read-policy.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

// Read an already-verified passive receipt, not a URL. This lets the mature
// executor close its quarantine without opening or resubmitting the site.
export function ptObservationBinding(root,target,config){
  const policy=ptReadPolicy(target.origin,config);
  const binding=policy.nativeMainChrome===true||policy.nativeIsolatedChrome===true
    ?nativePtReadBinding(config,{...target,accountKey:target.accountKey??'site-default'},{root,isolated:policy.nativeIsolatedChrome===true}):
    ptExecutionBinding(config,root,target);
  return {accountKey:binding.accountKey,profileBinding:binding.profileBinding,operationMode:policy.mode,
    pagePath:new URL(policy.url).pathname};
}

export function boundPtObservation(root,target,config,{now=new Date(),businessDate=dayAt(now),
  statuses=['signed','already_signed'],after=-Infinity,profileBinding}={}){
  try{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)||businessDate>dayAt(now))return null;
    const integration=JSON.parse(fs.readFileSync(path.join(root,'data/v2-integration.json'),'utf8'));
    if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot))return null;
    const runtime=JSON.parse(fs.readFileSync(path.join(integration.v2ProjectRoot,'config/runtime.local.json'),'utf8'));
    if(runtime.executionEngine!=='v1'||path.resolve(runtime.legacyRoot).toLowerCase()!==path.resolve(root).toLowerCase())return null;
    const day=businessDate,file=path.join(integration.v2ProjectRoot,'outputs','pt-fallback-results-'+day+'.json');
    const report=JSON.parse(fs.readFileSync(file,'utf8'));
    if(report.source!=='execution-supplement'||report.businessDate!==day||!Array.isArray(report.sites))return null;
    const matches=report.sites.filter(site=>site.origin===target.origin);
    if(matches.length!==1)return null;
    const result=matches[0],binding=ptObservationBinding(root,target,config);
    if(profileBinding!==undefined&&profileBinding!==binding.profileBinding)return null;
    const observed=Date.parse(result.observedAt),confirmed=Date.parse(result.evidence?.confirmedAt);
    if(!statuses.includes(result.status)||result.evidence?.authoritative!==true||
       !['pt_page','page_text','api'].includes(result.evidence.source)||result.evidence.evidenceScope!=='site_account_day'||
       result.submissionAttempted!==false||result.submissionOutcomeUnknown===true||
       result.operationMode!==binding.operationMode||result.readSafety!=='reviewed_passive'||
       result.profileBinding!==binding.profileBinding||result.accountKey!==binding.accountKey||
       result.businessDate!==day||result.evidence.businessDate!==day||
       result.evidence.pagePath!==binding.pagePath||
       !Number.isFinite(observed)||!Number.isFinite(confirmed)||observed>now.getTime()||confirmed>now.getTime()||
       Math.abs(confirmed-observed)>60_000||confirmed<=after||dayAt(observed)!==day||dayAt(confirmed)!==day)return null;
    if(target.origin==='https://open.cd'&&['signed','already_signed'].includes(result.status)&&(
      !['pt_page','page_text'].includes(result.evidence.source)||
      !['open_cd_daily_record_entry','submitted_success_response','same_day_page_text'].includes(String(result.evidence.statusSignal??''))||
      result.evidence.evidenceScope!==undefined&&result.evidence.evidenceScope!=='site_account_day'||
      result.evidence.pagePath!==undefined&&result.evidence.pagePath!=='/index.php'))return null;
    return result;
  }catch{return null;}
}

export function verifiedPtObservation(root,target,config,now=new Date()){
    const result=boundPtObservation(root,target,config,{now});
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

// A negative receipt authorizes only a new current-day guarded attempt. It is
// never evidence that an older submission did not happen or did not succeed.
export function freshPtUnsignedObservation(root,target,config,{now=new Date(),after=-Infinity,profileBinding}={}){
  const result=boundPtObservation(root,target,config,{now,statuses:['not_signed'],after,profileBinding});
  const confirmed=Date.parse(result?.evidence?.confirmedAt??'');
  if(!result||now.getTime()-confirmed>5*60_000||
    !['nexus_daily_header_unsigned','open_cd_daily_unsigned'].includes(result.evidence.statusSignal))return null;
  return result;
}

// A generic homepage label is not proof of a submission. Reopen only that
// narrow case using a newer exact-account passive proof, never a submitted or
// authoritative success and never an unresolved write intent.
export function recoverablePtHomepage(root,target,prior,config,reportedAt,now=new Date()){
  if(!['signed','already_signed'].includes(prior?.status)||prior.evidence?.authoritative===true||
    prior.submissionAttempted===true||prior.failureCode==='submission_outcome_unknown')return null;
  let policy;try{policy=ptReadPolicy(target.origin,config);}catch{return null;}
  if(!policy.dailyHeader||prior.url!==policy.url)return null;
  const result=boundPtObservation(root,target,config,{now,statuses:['not_signed']});
  const at=Date.parse(result?.evidence?.confirmedAt??''),reported=Date.parse(reportedAt??'');
  if(!result||!Number.isFinite(reported)||at<reported||at>now.getTime()||now.getTime()-at>5*60_000||
    Math.abs(Date.parse(result.observedAt)-at)>60_000||result.evidence.statusSignal!=='nexus_daily_header_unsigned')return null;
  return result;
}
