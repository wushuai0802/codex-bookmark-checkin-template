import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateSiteTwoFactorScope} from './two-factor-scope.mjs';
import {verifyHhclubNativeProfile,inspectHhclubLogin} from './hhclub-two-factor-login.mjs';
import {hddolbyPassiveContext} from './hddolby-two-factor.mjs';
import {readHddolbyHeader,hddolbyDailyStatusProof} from './hddolby-readonly.mjs';
import {boundPtObservation} from './pt-observation-receipt.mjs';
import {projectPtNativeDiagnostic} from './pt-native-diagnostic.mjs';

const origin='https://www.uhddolby.com',adapterId='hddolby-nexus-stepup-v1';
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const parentObservation=(root,target,config,options)=>boundPtObservation(root,target,config,{...options,statuses:['not_signed']});
async function publishNativeUnsigned({controller,receipt,now}){
  const {recordPtVerification}=await import(pathToFileURL(path.join(controller,'src/pt-verification.mjs')).href);
  // The caller proved the current parent's worker nonce and live owner. That
  // parent holds this lock and awaits us; append only the fresh passive proof.
  return recordPtVerification(controller,receipt,{now,lockHeld:true});
}

/** Native network only. No cookie export, login fields or authentication here. */
export async function runHddolbyNativeFlow({root,config,profile,port,page,mode='ReadOnly',clock=()=>new Date(),
  scope=validateSiteTwoFactorScope,profileProof=()=>verifyHhclubNativeProfile(profile,port),
  readHeader=readHddolbyHeader,runTarget,readUnsigned=parentObservation,publishUnsigned=publishNativeUnsigned}={}){
  if(!['ReadOnly','Checkin'].includes(mode))throw Error('Native HDDolby mode rejected');
  const started=clock(),opt=config?.siteTwoFactorRecovery?.[origin];let guard,firewall,dispatched=false;
  const diagnostic={stage:'preflight',code:'scope_unavailable',attendanceRequestObserved:false,authenticationRequestObserved:false};
  const context=page.context();
  const onRequest=request=>{try{
    const url=new URL(request.url());if(url.origin!==origin)return;
    if(url.pathname==='/attendance.php')diagnostic.attendanceRequestObserved=true;
    if(request.method()==='POST'&&url.pathname==='/take2fa.php')diagnostic.authenticationRequestObserved=true;
    if(request.isNavigationRequest())diagnostic.lastPath=url.pathname;
  }catch{}};
  const onResponse=response=>{try{const url=new URL(response.url());
    if(url.origin===origin&&url.pathname==='/attendance.php')diagnostic.attendanceResponseStatus=response.status();
  }catch{}};
  const attempted=value=>diagnostic.attendanceRequestObserved===true||value.submissionAttempted===true||dispatched&&value.submissionAttempted!==false;
  const finish=value=>({origin,status:value.status,observedAt:clock().toISOString(),businessDate:day(clock()),
    startedAt:started.toISOString(),accountKey:'site-default',profileBinding:guard?.binding?.profileBinding,
    submissionAttempted:attempted(value),operationMode:attempted(value)?'legacy_checkin':'safe_history_page',
    readSafety:attempted(value)?'attendance_page_risk':'reviewed_passive',
    ...(value.failureCode?{failureCode:value.failureCode}:{}),
    ...(value.underlyingFailureCode?{underlyingFailureCode:value.underlyingFailureCode}:{}),
    ...(value.retryCause?{retryCause:value.retryCause}:{}),
    ...(value.siteCondition==='site_maintenance'?{siteCondition:value.siteCondition}:{}),
    nativeFlow:projectPtNativeDiagnostic({...diagnostic,durationMs:clock()-started}),
    ...(value.evidence?{evidence:{source:value.evidence.source,authoritative:value.evidence.authoritative===true,
      confirmedAt:value.evidence.confirmedAt,businessDate:value.evidence.businessDate,pagePath:value.evidence.pagePath,
      statusSignal:value.evidence.statusSignal,evidenceScope:'site_account_day'}}:{})});
  try{
    if(opt?.enabled!==true||opt.reviewed!==true||opt.allowPasswordLogin!==true||opt.provider!=='bitwarden'||
      opt.adapterId!==adapterId||new URL(page.url()).origin!==origin)throw Error('Native HDDolby opt-in rejected');
    guard=await scope({root,origin,config,profile,adapterId});
    if(!guard||!await profileProof()||!await guard.assertCurrent())throw Error('Native HDDolby binding rejected');
    context.on?.('request',onRequest);context.on?.('response',onResponse);
    firewall=async route=>{
      const request=route.request();let target;try{target=new URL(request.url());}catch{return route.abort('blockedbyclient');}
      if(!['GET','HEAD'].includes(request.method())||target.origin!==origin||target.pathname==='/attendance.php')
        return route.abort('blockedbyclient');
      return route.fallback();
    };
    await context.route('**/*',firewall);
    diagnostic.stage='passive_read';diagnostic.code='readback_unavailable';
    const current=()=>readHeader(hddolbyPassiveContext(page),{origin,now:clock(),expectedAccountId:opt.expectedAccountId});
    const before=await current();
    diagnostic.readbackStatus=before.status;
    if(day(clock())!==day(started)||!await guard.assertCurrent()||!await profileProof())throw Error('Native HDDolby scope changed');
    // Some Nexus sessions are established after the initial redirect. The
    // current document can remain the login form although fresh home/log GETs
    // already prove the bound account. Read that proof before classifying it.
    if(!hddolbyDailyStatusProof(before,clock())&&new URL(page.url()).pathname==='/login.php'){
      const form=await inspectHhclubLogin(page,{origin});
      if(form){diagnostic.code='login_required';return finish({status:'login_required',failureCode:'login_required',submissionAttempted:false});}
    }
    if(['already_signed','not_signed'].includes(before.status)&&!hddolbyDailyStatusProof(before,clock())){
      diagnostic.code='fresh_unsigned_required';
      return finish({status:'unknown',failureCode:'authoritative_status_unavailable',submissionAttempted:false});
    }
    if(mode==='ReadOnly'||before.status!=='not_signed'){
      diagnostic.code='native_result';return finish(before);
    }
    // Use the parent's existing intent and fresh receipt. A direct helper call
    // cannot bypass the ordinary unknown-submission and exact-account gates.
    diagnostic.stage='intent_check';diagnostic.code='parent_intent_unavailable';
    const integration=read(path.join(root,'data/v2-integration.json'));
    const attempts=read(path.join(integration.v2ProjectRoot,'outputs',`harvest-fallback-attempts-${day(clock())}.json`));
    const worker=read(path.join(integration.v2ProjectRoot,'data/harvest-fallback.lock'));
    const id=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
    const target={origin,accountKey:'site-default',title:'HDDolby',candidates:[origin+'/attendance.php'],
      allowedOrigins:[origin],folderNames:['PT补签'],ptSupplement:true};
    const receipt=readUnsigned(root,target,config,{now:clock(),profileBinding:guard.binding.profileBinding});
    const own=attempts.attempts?.filter(a=>a.attemptId===id&&a.origin===origin&&a.accountKey==='site-default'&&
      a.state==='in_progress'&&a.workerPid===worker.pid&&a.workerNonce===worker.nonce);
    const intentAt=Date.parse(own?.[0]?.startedAt??''),confirmed=Date.parse(receipt?.evidence?.confirmedAt??'');
    diagnostic.parentEvidenceAgeMs=clock()-confirmed;
    if(!receipt||!id||own?.length!==1||own[0].recoveryEvidence?.profileBinding!==guard.binding.profileBinding||
      own[0].recoveryEvidence?.evidence?.confirmedAt!==receipt.evidence?.confirmedAt||
      !Number.isFinite(intentAt)||intentAt>clock().getTime()||clock()-intentAt>180_000||
      day(intentAt)!==day(started)||!hddolbyDailyStatusProof(receipt,new Date(intentAt)))
      throw Error('Native HDDolby submission intent unavailable');
    process.kill(worker.pid,0);
    if(!await guard.assertCurrent()||!await profileProof()||day(clock())!==day(started))throw Error('Native HDDolby scope changed');
    diagnostic.code='fresh_unsigned_required';
    const dispatchAt=clock();
    if(!hddolbyDailyStatusProof(before,dispatchAt)||before.status!=='not_signed')throw Error('Fresh native unsigned proof required');
    await publishUnsigned({controller:integration.v2ProjectRoot,now:dispatchAt,receipt:{...finish(before),
      evidence:{...before.evidence,evidenceScope:'site_account_day'}}});
    if(!await guard.assertCurrent()||!hddolbyDailyStatusProof(before,clock())||day(clock())!==day(started))throw Error('Native HDDolby scope changed');
    await context.unroute('**/*',firewall);firewall=null;
    if(!runTarget)({processTarget:runTarget}=await import('./browser.mjs'));
    const rules=[];
    for(const relative of ['config/qa-rules.json','config/qa-rules.local.json']){
      const file=path.join(root,relative);if(fs.existsSync(file))rules.push(...(read(file).rules??[]));
    }
    diagnostic.stage='submit';diagnostic.code='execution_failed';dispatched=true;
    const submitted=await runTarget(context,target,{...config,automationUserDataDir:profile,retryCount:0,failureScreenshots:false,
      capturePtEvidence:true,ptFallbackRecheck:true},rules,path.join(root,'tmp'));
    if(submitted.submissionAttempted===false&&!diagnostic.attendanceRequestObserved)dispatched=false;
    if(submitted.twoFactorRecovery){
      diagnostic.twoFactorReason=submitted.twoFactorRecovery.reason;
      diagnostic.twoFactorAttempted=submitted.twoFactorRecovery.attempted;
      diagnostic.twoFactorAccepted=submitted.twoFactorRecovery.accepted;
    }
    diagnostic.stage='readback';diagnostic.code='readback_unavailable';
    const after=await current();
    diagnostic.readbackStatus=after.status;
    if(day(clock())!==day(started)||!await guard.assertCurrent()||!await profileProof())throw Error('Native HDDolby scope changed');
    if(after.status==='already_signed'&&hddolbyDailyStatusProof(after,clock())){
      diagnostic.stage='complete';diagnostic.code='confirmed';
      return finish({...after,status:'signed',submissionAttempted:dispatched});
    }
    return finish({...submitted,status:'needs_attention',failureCode:submitted.failureCode??'submission_outcome_unknown',
      submissionAttempted:dispatched});
  }catch{
    return finish({status:'needs_attention',failureCode:dispatched?'submission_outcome_unknown':
      diagnostic.stage==='intent_check'?'authoritative_status_unavailable':'native_readback_unavailable',submissionAttempted:dispatched});
  }finally{
    context.off?.('request',onRequest);context.off?.('response',onResponse);
    if(firewall)try{await context.unroute('**/*',firewall);}catch{}
    if(guard)await guard.release();
  }
}
