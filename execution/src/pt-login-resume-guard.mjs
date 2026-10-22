import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ptExecutionBinding} from './pt-read-policy.mjs';
import {inspectProcessIdentity,classifyLockOwner} from './run-lock.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonical=value=>path.resolve(value).toLowerCase();
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
const decision=(allowed,reason)=>({allowed,reason});
const read=file=>{
  if(fs.statSync(file).size>16*1024*1024)throw Error('journal size');
  return JSON.parse(fs.readFileSync(file,'utf8'));
};
const activeStates=new Set(['in_progress','outcome_unknown','completed_cross_day']);
const states=new Set([...activeStates,'completed','deferred_busy','deferred_preflight']);
const success=new Set(['signed','already_signed']);
const possibleSubmission=attempt=>attempt.outcome?.submissionOutcomeUnknown===true||
  attempt.outcome?.failureCode==='submission_outcome_unknown'||attempt.outcome?.submissionAttempted===true||
  ['clicked','checkinClicked','checkinClickAttempted'].some(key=>attempt.outcome?.[key]===true);

/** Permit only the existing parent's first dispatch after a verified login.
 * This reads the production fallback audit; it never reserves or resolves an
 * attempt, invents a not-signed receipt, or releases another owner's lock.
 */
export async function validatePtLoginResume({root,origin,accountKey,profileBinding,attemptId,now=new Date(),
  inspectOwner=inspectProcessIdentity}={}){
  try{
    const reference=new Date(now),site=new URL(origin);
    if(!Number.isFinite(reference.getTime())||!path.isAbsolute(root??'')||site.protocol!=='https:'||
      site.origin!==origin||site.username||site.password||accountKey!=='site-default'||
      !/^[a-f0-9]{64}$/.test(profileBinding??'')||!uuid.test(attemptId??''))return decision(false,'invalid_request');
    const date=day(reference);
    root=path.resolve(root);
    const config=read(path.join(root,'config/config.json'));
    if([...(config.excludedOrigins??[]),...(config.disabledCheckinOrigins??[])].includes(origin)||
      (config.disabledAccountKeys??[]).includes(accountKey)||
      ptExecutionBinding(config,root,{origin,accountKey}).profileBinding!==profileBinding)
      return decision(false,'scope_unavailable');
    const integration=read(path.join(root,'data/v2-integration.json')),controller=integration?.v2ProjectRoot;
    if(integration.executionEngine!=='v1'||!path.isAbsolute(controller??'')||
      !path.isAbsolute(process.env.CHECKIN_V2_ENGINE_ROOT??'')||
      canonical(controller)!==canonical(process.env.CHECKIN_V2_ENGINE_ROOT))return decision(false,'scope_unavailable');
    const {validateEngineLease}=await import(pathToFileURL(path.join(controller,'src/legacy-engine.mjs')).href);
    validateEngineLease({root:controller,legacyRoot:root});
    const runtime=read(path.join(controller,'config/runtime.local.json'));
    if(runtime.ptFallbackOnlyEnabled!==true)return decision(false,'scope_unavailable');
    const executionOwner=read(path.join(root,'tmp/run.lock'));
    if(executionOwner.version!==1||executionOwner.pid!==process.pid||!uuid.test(executionOwner.nonce??'')||
      !Number.isFinite(Date.parse(executionOwner.processStartedAt??''))||
      classifyLockOwner(executionOwner,await inspectOwner(executionOwner.pid))!=='active')
      return decision(false,'execution_lock_unavailable');
    const lease=read(path.join(controller,'data/v2-run.lock')),
      worker=read(path.join(controller,'data/harvest-fallback.lock'));
    if(worker.schemaVersion!==1||!Number.isSafeInteger(worker.pid)||worker.pid!==lease.pid||
      !uuid.test(worker.nonce??'')||!Number.isFinite(Date.parse(worker.startedAt??'')))
      return decision(false,'current_attempt_mismatch');
    const directory=path.join(controller,'outputs'),todayFile=`harvest-fallback-attempts-${date}.json`;
    const files=fs.readdirSync(directory).filter(name=>/^harvest-fallback-attempts-\d{4}-\d{2}-\d{2}\.json$/.test(name)&&
      name.slice(26,36)<=date).sort();
    if(!files.includes(todayFile))return decision(false,'journal_unavailable');
    const {ptAttemptReconciled}=await import(pathToFileURL(path.join(controller,'src/pt-reconciliation.mjs')).href);
    let current=null;
    const history=[];
    for(const name of files){
      const businessDate=/^harvest-fallback-attempts-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)[1],journal=read(path.join(directory,name));
      if(journal.schemaVersion!==1||journal.businessDate!==businessDate||!Array.isArray(journal.attempts)||
        journal.reconciliations!==undefined&&!Array.isArray(journal.reconciliations))return decision(false,'journal_unavailable');
      for(const [index,attempt] of journal.attempts.entries()){
        if(!attempt||typeof attempt!=='object'||!states.has(attempt.state)||typeof attempt.origin!=='string'||
          !Number.isFinite(Date.parse(attempt.startedAt??''))||
          attempt.businessDate!==undefined&&attempt.businessDate!==businessDate)return decision(false,'journal_unavailable');
        if(attempt.origin!==origin||(attempt.accountKey??'site-default')!==accountKey)continue;
        if(businessDate===date&&attempt.attemptId===attemptId){
          if(current)return decision(false,'current_attempt_mismatch');
          current=attempt;
        }else history.push({attempt,journal,index,businessDate});
      }
    }
    if(!current||current.state!=='in_progress'||current.businessDate!==date||current.accountKey!==accountKey||
      current.workerPid!==worker.pid||current.workerNonce!==worker.nonce||
      day(current.startedAt)!==date||Date.parse(current.startedAt)>reference.getTime()||
      possibleSubmission(current)||current.outcome!==undefined||current.finishedAt!==undefined)
      return decision(false,'current_attempt_mismatch');
    for(const {attempt,journal,index,businessDate} of history){
      const claimed=attempt.outcome?.status??attempt.v1Status;
      if(businessDate===date&&(success.has(claimed)||success.has(attempt.v1Status)))
        return decision(false,'today_already_completed');
      if(businessDate===date&&possibleSubmission(attempt))return decision(false,'prior_submission');
      const pending=activeStates.has(attempt.state)||attempt.outcome?.submissionOutcomeUnknown===true||
        attempt.outcome?.failureCode==='submission_outcome_unknown'||
        attempt.state==='completed'&&['needs_attention','unknown'].includes(claimed)&&attempt.outcome?.submissionAttempted!==false;
      const reconciled=ptAttemptReconciled(journal,attempt,index);
      if(pending&&!reconciled)return decision(false,'prior_outcome_unknown');
      // Manual closure retains its explicit no-same-day-replay condition.
      if(businessDate===date&&pending&&reconciled&&
        !journal.reconciliations?.some(value=>value.attemptId===attempt.attemptId&&value.kind==='confirmed_not_submitted'&&
          value.submissionAttempted===false))return decision(false,'prior_submission');
    }
    const statusFile=path.join(directory,`pt-fallback-results-${date}.json`);
    if(fs.existsSync(statusFile)){
      const report=read(statusFile);
      if(report.schemaVersion!==1||report.source!=='execution-supplement'||report.businessDate!==date||!Array.isArray(report.sites))
        return decision(false,'journal_unavailable');
      const matches=report.sites.filter(value=>value?.origin===origin&&(value.accountKey??'site-default')===accountKey);
      if(matches.length>1)return decision(false,'journal_unavailable');
      if(matches.some(value=>success.has(value.status)))return decision(false,'today_already_completed');
      if(matches.some(value=>value.submissionOutcomeUnknown===true||value.failureCode==='submission_outcome_unknown'))
        return decision(false,'prior_outcome_unknown');
    }
    validateEngineLease({root:controller,legacyRoot:root});
    const currentExecution=read(path.join(root,'tmp/run.lock')),currentWorker=read(path.join(controller,'data/harvest-fallback.lock'));
    if(currentExecution.pid!==executionOwner.pid||currentExecution.nonce!==executionOwner.nonce||
      currentWorker.pid!==worker.pid||currentWorker.nonce!==worker.nonce)return decision(false,'execution_lock_unavailable');
    return decision(true,'first_dispatch_after_login');
  }catch{return decision(false,'journal_unavailable');}
}
