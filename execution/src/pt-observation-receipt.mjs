import fs from 'node:fs';
import path from 'node:path';
import {ptExecutionBinding,ptReadPolicy} from './pt-read-policy.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

// Read an already-verified passive receipt, not a URL. This lets the mature
// executor close its quarantine without opening or resubmitting the site.
export function verifiedPtObservation(root,target,config,now=new Date()){
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
    const result=matches[0],binding=ptExecutionBinding(config,root,target),policy=ptReadPolicy(target.origin,config);
    const observed=Date.parse(result.observedAt),confirmed=Date.parse(result.evidence?.confirmedAt);
    if(!['signed','already_signed'].includes(result.status)||result.evidence?.authoritative!==true||
       !['pt_page','page_text','api'].includes(result.evidence.source)||result.evidence.evidenceScope!=='site_account_day'||
       result.submissionAttempted!==false||result.submissionOutcomeUnknown===true||
       result.operationMode!==policy.mode||result.readSafety!=='reviewed_passive'||
       result.profileBinding!==binding.profileBinding||result.accountKey!==binding.accountKey||
       result.businessDate!==day||result.evidence.businessDate!==day||
       result.evidence.pagePath!==new URL(policy.url).pathname||
       !Number.isFinite(observed)||!Number.isFinite(confirmed)||observed>now.getTime()+60_000||
       confirmed>observed+60_000||dayAt(observed)!==day||dayAt(confirmed)!==day)return null;
    return {status:'already_signed',reason:'执行 Profile 的同日只读回执确认已签到，无需重复提交',
      submissionAttempted:false,profileBinding:binding.profileBinding,
      operationMode:result.operationMode,readSafety:result.readSafety,
      ...(target.accountKey?{accountKey:target.accountKey}:{}),
      reconciliation:{kind:'confirmed_external',observedAt:result.observedAt,accountKey:binding.accountKey},
      evidence:{source:result.evidence.source,authoritative:true,businessDate:day,
        confirmedAt:result.evidence.confirmedAt,statusSignal:result.evidence.statusSignal,
        pagePath:result.evidence.pagePath,evidenceScope:'site_account_day'}};
  }catch{return null;}
}
