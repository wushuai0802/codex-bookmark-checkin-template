import fs from 'node:fs';
import path from 'node:path';
import {validateSiteTwoFactorScope} from './two-factor-scope.mjs';
import {verifyHhclubNativeProfile,inspectHhclubLogin} from './hhclub-two-factor-login.mjs';
import {hddolbyPassiveContext} from './hddolby-two-factor.mjs';
import {readHddolbyHeader,hddolbyDailyStatusProof} from './hddolby-readonly.mjs';
import {freshPtUnsignedObservation} from './pt-observation-receipt.mjs';

const origin='https://www.uhddolby.com',adapterId='hddolby-nexus-stepup-v1';
const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

/** Native network only. No cookie export, login fields or authentication here. */
export async function runHddolbyNativeFlow({root,config,profile,port,page,mode='ReadOnly',clock=()=>new Date(),
  scope=validateSiteTwoFactorScope,profileProof=()=>verifyHhclubNativeProfile(profile,port),
  readHeader=readHddolbyHeader,runTarget,readUnsigned=freshPtUnsignedObservation}={}){
  if(!['ReadOnly','Checkin'].includes(mode))throw Error('Native HDDolby mode rejected');
  const started=clock(),opt=config?.siteTwoFactorRecovery?.[origin];let guard,firewall;
  const finish=value=>({origin,status:value.status,observedAt:clock().toISOString(),businessDate:day(clock()),
    startedAt:started.toISOString(),accountKey:'site-default',profileBinding:guard.binding.profileBinding,
    submissionAttempted:value.submissionAttempted===true,operationMode:value.submissionAttempted===true?'legacy_checkin':'safe_history_page',
    readSafety:value.submissionAttempted===true?'attendance_page_risk':'reviewed_passive',
    ...(value.failureCode?{failureCode:value.failureCode}:{}),
    ...(value.evidence?{evidence:{source:value.evidence.source,authoritative:value.evidence.authoritative===true,
      confirmedAt:value.evidence.confirmedAt,businessDate:value.evidence.businessDate,pagePath:value.evidence.pagePath,
      statusSignal:value.evidence.statusSignal,evidenceScope:'site_account_day'}}:{})});
  try{
    if(opt?.enabled!==true||opt.reviewed!==true||opt.allowPasswordLogin!==true||opt.provider!=='bitwarden'||
      opt.adapterId!==adapterId||new URL(page.url()).origin!==origin)throw Error('Native HDDolby opt-in rejected');
    guard=await scope({root,origin,config,profile,adapterId});
    if(!guard||!await profileProof()||!await guard.assertCurrent())throw Error('Native HDDolby binding rejected');
    firewall=async route=>{
      const request=route.request();let target;try{target=new URL(request.url());}catch{return route.abort('blockedbyclient');}
      if(!['GET','HEAD'].includes(request.method())||target.origin!==origin||target.pathname==='/attendance.php')
        return route.abort('blockedbyclient');
      return route.fallback();
    };
    await page.context().route('**/*',firewall);
    const current=()=>readHeader(hddolbyPassiveContext(page),{origin,now:clock(),expectedAccountId:opt.expectedAccountId});
    const before=await current();
    if(day(clock())!==day(started)||!await guard.assertCurrent()||!await profileProof())throw Error('Native HDDolby scope changed');
    // Some Nexus sessions are established after the initial redirect. The
    // current document can remain the login form although fresh home/log GETs
    // already prove the bound account. Read that proof before classifying it.
    if(!hddolbyDailyStatusProof(before,clock())&&new URL(page.url()).pathname==='/login.php'){
      const form=await inspectHhclubLogin(page,{origin});
      if(form)return finish({status:'login_required',failureCode:'login_required',submissionAttempted:false});
    }
    if(mode==='ReadOnly'||before.status!=='not_signed'||!hddolbyDailyStatusProof(before,clock()))return finish(before);
    // Use the parent's existing intent and fresh receipt. A direct helper call
    // cannot bypass the ordinary unknown-submission and exact-account gates.
    const integration=read(path.join(root,'data/v2-integration.json'));
    const attempts=read(path.join(integration.v2ProjectRoot,'outputs',`harvest-fallback-attempts-${day(clock())}.json`));
    const worker=read(path.join(integration.v2ProjectRoot,'data/harvest-fallback.lock'));
    const id=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;
    const target={origin,accountKey:'site-default',title:'HDDolby',candidates:[origin+'/attendance.php'],
      allowedOrigins:[origin],folderNames:['PT补签'],ptSupplement:true};
    const receipt=readUnsigned(root,target,config,{now:clock(),profileBinding:guard.binding.profileBinding});
    const own=attempts.attempts?.filter(a=>a.attemptId===id&&a.origin===origin&&a.accountKey==='site-default'&&
      a.state==='in_progress'&&a.workerPid===worker.pid&&a.workerNonce===worker.nonce);
    if(!receipt||!id||own?.length!==1||own[0].recoveryEvidence?.profileBinding!==guard.binding.profileBinding||
      own[0].recoveryEvidence?.evidence?.confirmedAt!==receipt.evidence?.confirmedAt)
      throw Error('Native HDDolby submission intent unavailable');
    process.kill(worker.pid,0);
    if(!await guard.assertCurrent()||!await profileProof()||day(clock())!==day(started))throw Error('Native HDDolby scope changed');
    await page.context().unroute('**/*',firewall);firewall=null;
    if(!runTarget)({processTarget:runTarget}=await import('./browser.mjs'));
    const rules=[];
    for(const relative of ['config/qa-rules.json','config/qa-rules.local.json']){
      const file=path.join(root,relative);if(fs.existsSync(file))rules.push(...(read(file).rules??[]));
    }
    const submitted=await runTarget(page.context(),target,{...config,retryCount:0,failureScreenshots:false,
      capturePtEvidence:true,ptFallbackRecheck:true},rules,path.join(root,'tmp'));
    const after=await current();
    if(day(clock())!==day(started)||!await guard.assertCurrent()||!await profileProof())throw Error('Native HDDolby scope changed');
    if(after.status==='already_signed'&&hddolbyDailyStatusProof(after,clock()))
      return finish({...after,status:'signed',submissionAttempted:submitted.submissionAttempted!==false});
    return finish({status:'needs_attention',failureCode:submitted.failureCode??'submission_outcome_unknown',
      submissionAttempted:submitted.submissionAttempted!==false});
  }finally{
    if(firewall)try{await page.context().unroute('**/*',firewall);}catch{}
    if(guard)await guard.release();
  }
}
