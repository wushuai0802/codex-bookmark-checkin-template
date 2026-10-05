import fs from 'node:fs';
import path from 'node:path';
import {projectPtSiteResult} from './pt-site-execution.mjs';
import {acquireExecutionLock,releaseExecutionLock} from './execution-lock.mjs';
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

export function currentPassivePtResult(value,now=new Date()){
  const result=projectPtSiteResult(value,value.origin),day=dayAt(now),observed=Date.parse(result.observedAt);
  if(['signed','already_signed','not_signed'].includes(value.status)&&result.status!==value.status)
    throw Error('passive completion or non-completion requires authoritative evidence');
  // A read-only probe can itself be inconclusive. Preserve that diagnostic as
  // account-scoped evidence, while keeping the submission gate closed. It is
  // deliberately limited to the reviewed passive mode and an explicit
  // non-submission result; an unknown result from a write-capable flow still
  // fails closed below.
  const passiveUncertain=result.submissionOutcomeUnknown===true&&
    ['unknown','needs_attention'].includes(result.status)&&result.submissionAttempted===false&&
    result.operationMode==='safe_history_page'&&result.readSafety==='reviewed_passive';
  if(result.operationMode!=='safe_history_page'||result.readSafety!=='reviewed_passive'||result.submissionAttempted!==false||
     (!passiveUncertain&&result.submissionOutcomeUnknown===true)||!/^[a-f0-9]{64}$/.test(result.profileBinding??'')||!result.accountKey||
     result.businessDate!==day||dayAt(observed)!==day||observed>now.getTime()+60_000||now.getTime()-observed>5*60_000)
    throw Error('current bound passive PT result required');
  if(['signed','already_signed','not_signed'].includes(result.status)){
    const confirmed=Date.parse(result.evidence.confirmedAt);
    if(result.evidence.authoritative!==true||result.evidence.businessDate!==day||!Number.isFinite(confirmed)||
      dayAt(confirmed)!==day||Math.abs(observed-confirmed)>60_000||result.evidence.evidenceScope!=='site_account_day')
      throw Error('passive PT evidence must confirm the current account day');
  }
  return result;
}

export function recordPtVerification(root,value,{now=new Date(),lockHeld=false}={}){
  const result=currentPassivePtResult(value,now),businessDate=dayAt(now);
  const lease=lockHeld?null:acquireExecutionLock(root,{name:'harvest-fallback.lock'});
  try{
    const directory=path.join(root,'outputs'),file=path.join(directory,`pt-fallback-results-${businessDate}.json`);
    fs.mkdirSync(directory,{recursive:true});
    const report=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):
      {schemaVersion:1,source:'execution-supplement',businessDate,sites:[]};
    if(report.source!=='execution-supplement'||report.businessDate!==businessDate||!Array.isArray(report.sites))throw Error('invalid PT receipt report');
    const previous=report.sites.find(s=>s.origin===result.origin);
    // Keep every observation; a later diagnostic must not erase confirmed completion.
    fs.appendFileSync(path.join(directory,`pt-verifications-${businessDate}.jsonl`),JSON.stringify(result)+'\n',{mode:0o600});
    if(previous&&Date.parse(previous.observedAt)>Date.parse(result.observedAt))return {recorded:false,result};
    if(previous?.evidence?.authoritative===true&&['signed','already_signed'].includes(previous.status)&&
       !['signed','already_signed'].includes(result.status))return {recorded:false,result};
    report.generatedAt=now.toISOString();report.sites=report.sites.filter(s=>s.origin!==result.origin).concat(result);
    const temporary=file+'.'+process.pid+'.tmp';
    try{fs.writeFileSync(temporary,JSON.stringify(report,null,2),{mode:0o600});fs.renameSync(temporary,file);}
    finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return {recorded:true,result};
  }finally{if(lease)releaseExecutionLock(lease);}
}
