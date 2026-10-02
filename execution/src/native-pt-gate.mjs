import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {readBookmarkPlanWithBackup} from './bookmarks.mjs';
import {accountMetadataForOrigin,compatiblePriorResult} from './result-identity.mjs';
import {configuredTargetSkip} from './browser.mjs';
import {isPtExecutionTarget,checkHarvestPtBeforeWrite} from './harvest-pt-gate.mjs';
import {ptExecutionBinding} from './pt-read-policy.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
import {verifiedPtObservation} from './pt-observation-receipt.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const success=value=>['signed','already_signed'].includes(value?.status);
const read=(file,fallback)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const normalizePath=value=>path.resolve(value).replaceAll('\\','/').toLowerCase();
const unknown=()=>({status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,
  retryable:false,nativeGate:true,reason:'原生签到可能已提交，先只读核验，禁止自动重放'});
const deferred=(now,reason)=>({status:'deferred',retryCause:'native_readback_unavailable',submissionAttempted:false,nativeGate:true,
  nextEligibleAt:new Date(now.getTime()+15*60_000).toISOString(),reason});
export function nativePtNavigationRisk(url){
  try{const u=new URL(url);return u.search!==''||!['/','/index.php','/login.php'].includes(u.pathname);}catch{return true;}
}
export function nativeCurrentSuccess(result,now=new Date()){
  const evidence=result?.evidence,at=Date.parse(evidence?.confirmedAt??evidence?.createdAt??'');
  return success(result)&&evidence?.authoritative===true&&Number.isFinite(at)&&at<=now.getTime()+60_000&&
    ['page_text','pt_page','api','usage_log'].includes(evidence.source)&&dayAt(at)===dayAt(now)&&evidence.businessDate===dayAt(now);
}
const safeEvidence=e=>({source:e.source,authoritative:true,confirmedAt:e.confirmedAt,businessDate:e.businessDate,
  ...(e.pagePath?{pagePath:e.pagePath}:{}),...(e.statusSignal?{statusSignal:e.statusSignal}:{})});
export function nativePtDecision({prior,pending,receipt,unsigned=false,reportedToday=false,now=new Date()}={}){
  if(nativeCurrentSuccess(receipt,now))return {...receipt,nativeGate:true,submissionAttempted:false};
  if(nativeCurrentSuccess(prior,now))return {...prior,nativeGate:true,submissionAttempted:false};
  if(!unsigned&&(pending||prior?.submissionAttempted===true&&!success(prior)||prior?.failureCode==='submission_outcome_unknown'))return unknown();
  if(!unsigned&&reportedToday&&success(prior))return {status:'needs_attention',failureCode:'authoritative_status_unavailable',
    submissionAttempted:false,nativeGate:true,retryable:false,reason:'今日已有成功记录，先补齐只读证据，不重复提交'};
  const until=Date.parse(prior?.nextEligibleAt??'');
  if(Number.isFinite(until)&&until>now.getTime())return {...prior,nativeGate:true,submissionAttempted:false};
  return null;
}
function checkLease(root,integration){
  if(integration?.executionEngine!=='v1')return;
  const controller=integration.v2ProjectRoot;
  if(!path.isAbsolute(controller??'')||normalizePath(process.env.CHECKIN_V2_ENGINE_ROOT??'.')!==normalizePath(controller))throw Error('native PT lease root mismatch');
  const lease=read(path.join(controller,'data/v2-run.lock'),null);
  if(!lease?.nonce||lease.nonce!==process.env.CHECKIN_V2_ENGINE_LEASE||!Number.isInteger(lease.pid))throw Error('native PT lease missing');
  process.kill(lease.pid,0);
  const runtime=read(path.join(controller,'config/runtime.local.json'),null);
  if(runtime?.executionEngine!=='v1'||normalizePath(runtime.legacyRoot??'.')!==normalizePath(root))throw Error('native PT execution binding mismatch');
}
function bindingFor(root,config,target,profile,mainProfile,entries){
  if(mainProfile){
    const binding=nativePtReadBinding(config,{...target,accountKey:target.accountKey??'site-default'});
    if(normalizePath(binding.profile)!==normalizePath(profile))throw Error('native main profile mismatch');
    return binding;
  }
  const standard=ptExecutionBinding(config,root,target),profiles=[standard.profile,...entries.map(e=>e.automationUserDataDir).filter(Boolean).map(p=>path.resolve(root,p))];
  const relative=path.relative(path.resolve(root,'data'),path.resolve(profile));
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!profiles.some(p=>normalizePath(p)===normalizePath(profile)))throw Error('native execution profile mismatch');
  return {accountKey:standard.accountKey,profileBinding:crypto.createHash('sha256').update(process.platform==='win32'?path.resolve(profile).toLowerCase():path.resolve(profile)).digest('hex')};
}
function writeJournal(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

// The short gate lock serializes intent updates. Production writes additionally
// require the controller's live lease, inherited by the native subprocess.
export async function runNativePtGate({root,origin,url,profile,mainProfile=false,phase='inspect',attemptId,action,status,evidence,
  now,clock=now?()=>new Date(now):()=>new Date(),readPlan=readBookmarkPlanWithBackup,harvest=checkHarvestPtBeforeWrite,verify=verifiedPtObservation}={}){
  now=clock();
  if(!['inspect','begin','finish'].includes(phase))throw Error('invalid native PT phase');
  const requested=new URL(origin),destination=new URL(url);
  if(requested.protocol!=='https:'||requested.origin!==origin||requested.username||requested.password||destination.protocol!=='https:'||destination.username||destination.password||destination.hash)throw Error('unsafe native PT target');
  const config=read(path.join(root,'config/config.json'),null);
  const plan=await readPlan(config.bookmarksPath,config);
  if(dayAt(clock())!==dayAt(now))return {managed:true,allow:false,decision:deferred(clock(),'业务日期已切换，先刷新当日原生核验')};
  const matches=(plan.targets??[]).filter(t=>t.origin===origin||(t.allowedOrigins??[]).includes(origin));
  if(matches.length!==1)return {managed:true,allow:false,decision:deferred(now,'原生目标不在唯一的当前书签范围中')};
  const target={...matches[0],...accountMetadataForOrigin(matches[0].origin,config)};
  if(!isPtExecutionTarget(target,{root}))return {managed:false,allow:true};
  const entries=[...(config.nativeWafPreflightUrls??[]),...(config.nativeChallengePreflight??[]),...(config.mainChromeFallbackUrls??[])]
    .map(e=>typeof e==='string'?{url:e}:e).filter(e=>{try{return new URL(e.url).origin===origin||e.sourceOrigin===origin;}catch{return false;}});
  if(![origin,...(target.allowedOrigins??[])].includes(destination.origin)||!entries.some(e=>e.url===url)&&!['/','/index.php','/login.php'].includes(destination.pathname))throw Error('unregistered native PT URL');
  const binding=bindingFor(root,config,target,profile,mainProfile,entries);
  const skip=configuredTargetSkip(target,config);
  if(skip)return {managed:true,allow:false,decision:{...skip,nativeGate:true,submissionAttempted:false}};
  const integration=read(path.join(root,'data/v2-integration.json'),null);
  if(phase!=='inspect')checkLease(root,integration);
  const lock=await acquireRunLock(path.join(root,'tmp/native-pt-gate.lock'));
  try{
    const file=path.join(root,'data/native-pt-attempts.json'),journal=read(file,{schemaVersion:1,attempts:[]});
    if(journal.schemaVersion!==1||!Array.isArray(journal.attempts))throw Error('invalid native PT journal');
    const accountKey=target.accountKey??'site-default',sameAccount=a=>a.origin===target.origin&&a.accountKey===accountKey;
    const owned=journal.attempts.find(a=>a.attemptId===attemptId);
    if(owned&&(!sameAccount(owned)||owned.profileBinding!==binding.profileBinding))throw Error('native attempt binding mismatch');
    if(phase==='finish'){
      if(!owned)return {managed:true,allow:false,decision:unknown()};
      if(nativeCurrentSuccess({status,evidence},now)&&dayAt(owned.startedAt)===dayAt(now)&&Date.parse(evidence.confirmedAt)>=Date.parse(owned.startedAt)){
        owned.state='confirmed';owned.finishedAt=now.toISOString();owned.status=status;
        owned.confirmedAt=evidence.confirmedAt;owned.evidence=safeEvidence(evidence);writeJournal(file,journal);
      }
      return {managed:true,allow:true,submissionAttempted:true,profileBinding:binding.profileBinding};
    }
    const latest=read(path.join(root,'logs/latest.json'),null),prior=compatiblePriorResult(target,latest?.results??[]);
    const verified=verify(root,target,config,now);
    const savedCompletion=journal.attempts.filter(a=>sameAccount(a)&&a.profileBinding===binding.profileBinding&&a.state==='confirmed'&&nativeCurrentSuccess(a,now))
      .sort((a,b)=>Date.parse(b.confirmedAt)-Date.parse(a.confirmedAt))[0];
    const receipt=verified?.profileBinding===binding.profileBinding?verified:savedCompletion?{
      status:'already_signed',profileBinding:binding.profileBinding,evidence:savedCompletion.evidence,
      reason:'原生执行的当日持久化回执已确认完成，无需重复提交'}:null;
    if(nativeCurrentSuccess(receipt,now)){
      let changed=false;const confirmed=Date.parse(receipt.evidence.confirmedAt);
      for(const previous of journal.attempts){
        if(sameAccount(previous)&&previous.profileBinding===binding.profileBinding&&previous.state==='submitted'&&
          dayAt(previous.startedAt)===dayAt(confirmed)&&confirmed>=Date.parse(previous.startedAt)){
          previous.state='confirmed';previous.finishedAt=now.toISOString();previous.confirmedAt=receipt.evidence.confirmedAt;
          previous.resolution='passive_readback';previous.status=receipt.status;previous.evidence=safeEvidence(receipt.evidence);changed=true;
        }
      }
      if(changed)writeJournal(file,journal);
    }
    const pendingEntries=journal.attempts.filter(a=>sameAccount(a)&&a.state==='submitted'&&a.attemptId!==attemptId);
    let unsigned=false;
    if(integration?.v2ProjectRoot){
      const report=read(path.join(integration.v2ProjectRoot,'outputs',`pt-fallback-results-${dayAt(now)}.json`),null);
      const proof=report?.sites?.find(r=>r.origin===target.origin&&r.accountKey===accountKey),at=Date.parse(proof?.evidence?.confirmedAt??'');
      const after=Math.max(0,...pendingEntries.map(a=>Date.parse(a.startedAt)),
        prior?.failureCode==='submission_outcome_unknown'?Date.parse(latest?.finishedAt??'')||0:0);
      unsigned=report?.source==='execution-supplement'&&proof?.status==='not_signed'&&proof.profileBinding===binding.profileBinding&&
        proof.submissionAttempted===false&&proof.readSafety==='reviewed_passive'&&proof.operationMode==='safe_history_page'&&
        proof.evidence?.authoritative===true&&proof.evidence.evidenceScope==='site_account_day'&&
        proof.businessDate===dayAt(now)&&proof.evidence.businessDate===dayAt(now)&&Number.isFinite(at)&&
        at>=after&&at<=now.getTime()&&now.getTime()-at<=5*60_000;
    }
    const reportAt=Date.parse(latest?.finishedAt??latest?.generatedAt??'');
    let decision=nativePtDecision({prior,pending:pendingEntries.length>0,receipt,unsigned,
      reportedToday:Number.isFinite(reportAt)&&dayAt(reportAt)===dayAt(now),now});
    if(owned&&owned.state==='confirmed')decision=unknown();
    if(owned&&(dayAt(owned.startedAt)!==dayAt(now)||now.getTime()-Date.parse(owned.startedAt)>10*60_000))decision=unknown();
    if(!decision)decision=harvest(target,{root,now});
    if(dayAt(clock())!==dayAt(now))decision=owned?unknown():deferred(clock(),'业务日期已切换，先刷新当日原生核验');
    if(decision)return {managed:true,allow:false,decision:{...decision,nativeGate:true}};
    if(phase==='inspect')return {managed:true,allow:true,navigationRisk:nativePtNavigationRisk(url)};
    if(!/^[a-f0-9-]{36}$/.test(attemptId??'')||!['navigation','click'].includes(action))throw Error('invalid native attempt action');
    if(owned?.actions.includes(action))return {managed:true,allow:false,decision:unknown()};
    if(unsigned)for(const previous of pendingEntries){previous.state='resolved_not_signed';previous.resolvedAt=now.toISOString();}
    const entry=owned??{attemptId,origin:target.origin,accountKey,profileBinding:binding.profileBinding,businessDate:dayAt(now),
      startedAt:now.toISOString(),state:'submitted',actions:[]};
    entry.actions.push(action);if(!owned)journal.attempts.push(entry);
    writeJournal(file,journal);
    return {managed:true,allow:true,submissionAttempted:true,profileBinding:binding.profileBinding};
  }finally{await releaseRunLock(lock);}
}
