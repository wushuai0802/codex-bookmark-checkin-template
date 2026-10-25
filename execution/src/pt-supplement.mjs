import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {launchAutomationContext,processTarget} from './browser.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {ptExecutionBinding,ptReadPolicy,installPtReadFirewall,readPtPassivePage,readPtPublicAvailability} from './pt-read-policy.mjs';
import {ptDiagnostic} from './pt-diagnostics.mjs';
import {nativePtReadBinding,inspectNativePtHeader} from './native-pt-read.mjs';
import {readOurbitsProfile} from './pt-profile-read.mjs';
import {readHddolbyHeader} from './hddolby-readonly.mjs';
import {recoverPtLogin,runHddolbyNative as runNativeHddolby} from './pt-login-recovery.mjs';
import {readHhclubProfileState} from './hhclub-two-factor-login.mjs';
import {validatePtLoginResume} from './pt-login-resume-guard.mjs';
import {projectPtNativeDiagnostic} from './pt-native-diagnostic.mjs';

const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);
const terminal=new Set(['signed','already_signed']);
const rewardHintOrigins=new Set(['https://hdtime.org','https://cyanbug.net']);

function exactOrigin(value){
  const url=new URL(value);
  if(url.protocol!=='https:'||url.origin!==value||url.username||url.password)throw Error('invalid PT origin');
  return url.origin;
}

export function ptSupplementTarget(catalog,origin){
  const requested=exactOrigin(origin);
  if(!Array.isArray(catalog?.sites))throw Error('PT catalog is missing sites');
  const matches=catalog.sites.filter(site=>site?.origin===requested);
  if(matches.length!==1)throw Error('PT origin is absent or ambiguous');
  const entryUrl=matches[0].entryUrl;
  const url=new URL(entryUrl);
  if(url.protocol!=='https:'||url.origin!==requested||url.username||url.password||url.search||url.hash||entryUrl.length>255)throw Error('PT entry is unsafe');
  const operationMode='legacy_checkin';
  const readSafety='unknown';
  return {origin:requested,title:matches[0].displayName??url.hostname,
    candidates:[entryUrl],allowedOrigins:[requested],
    accountKey:'site-default',folderNames:['PT补签'],ptSupplement:true,operationMode,readSafety};
}

export function publicSupplementResult(origin,result,now=new Date()){
  const claimed=result?.status;
  const confirmedAt=Date.parse(result?.evidence?.confirmedAt??result?.evidence?.createdAt);
  const dated=Number.isFinite(confirmedAt)&&confirmedAt<=now.getTime()+60_000&&
    dayAt(new Date(confirmedAt))===dayAt(now)&&
    (!result?.evidence?.businessDate||result.evidence.businessDate===dayAt(now))&&
    (!result?.startedAt||confirmedAt>=Date.parse(result.startedAt)-60_000);
  const authoritative=(terminal.has(claimed)||claimed==='not_signed')&&result?.evidence?.authoritative===true&&
    dated&&result?.failureCode!=='submission_outcome_unknown';
  const unavailable=result?.status==='not_available'&&result?.evidence?.authoritative===true&&
    dated;
  const status=authoritative?claimed:claimed==='login_required'?'login_required':
    claimed==='deferred'&&result?.submissionAttempted===false?'unknown':
    result?.failureCode==='submission_outcome_unknown'?'needs_attention':
    unavailable?'not_available':
    terminal.has(claimed)?'unknown':'needs_attention';
  const source=['api','page_text','usage_log','pt_page'].includes(result?.evidence?.source)?result.evidence.source:'none';
  const diagnostic=ptDiagnostic(result);
  return {origin,status,observedAt:now.toISOString(),
    ...(!authoritative?{failureCode:diagnostic.failureCode,...(diagnostic.siteCondition?{siteCondition:diagnostic.siteCondition}:{})}:{}),
    ...(!authoritative&&diagnostic.underlyingFailureCode?{underlyingFailureCode:diagnostic.underlyingFailureCode}:{}),
    ...(diagnostic.retryCause?{retryCause:diagnostic.retryCause,
      ...(Number.isFinite(Date.parse(result.nextEligibleAt))?{nextEligibleAt:new Date(result.nextEligibleAt).toISOString()}:{} )}:{}),
    ...(projectPtNativeDiagnostic(result?.nativeFlow)?{nativeFlow:projectPtNativeDiagnostic(result.nativeFlow)}:{}),
    operationMode:result?.operationMode??'unknown',readSafety:result?.readSafety??'unknown',
    ...(result?.profileBinding?{profileBinding:result.profileBinding,accountKey:result.accountKey??'site-default'}:{}),
    businessDate:dayAt(now),...(result?.startedAt?{startedAt:result.startedAt}:{}),
    evidence:{source,authoritative:authoritative||unavailable,
      ...(Number.isFinite(confirmedAt)?{confirmedAt:new Date(confirmedAt).toISOString()}:{}),
      ...(result?.evidence?.businessDate?{businessDate:result.evidence.businessDate}:{}),
      ...(result?.evidence?.statusSignal?{statusSignal:result.evidence.statusSignal}:{}),
      ...(['/index.php','/','/userdetails.php','/log.php'].includes(result?.evidence?.pagePath)?{pagePath:result.evidence.pagePath}:{}),
      evidenceScope:'site_account_day',summary:authoritative?(claimed==='not_signed'?'已登录首页确认今日尚未签到':'执行层确认今日签到'):
      terminal.has(claimed)&&result?.evidence?.statusSignal==='cumulative_reward'?'检测到签到已得，疑似已签到；尚缺今日回执':
      terminal.has(claimed)?'执行层返回完成状态，仍需权威证据复核':
      diagnostic.summary},
    ...(result?.failureCode==='submission_outcome_unknown'?{submissionOutcomeUnknown:true}:{}),
    ...(result?.submissionAttempted===true?{submissionAttempted:true}:{}),
    ...(result?.submissionAttempted===false?{submissionAttempted:false}:{})};
}

export function ptRewardCounter(bodyText){
  const values=[...String(bodyText??'').matchAll(/(?:签到已得|簽到已得)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)]
    .map(match=>Number(match[1].replaceAll(',','')));
  return values.length>0&&values.every(value=>Number.isFinite(value)&&value===values[0])?values[0]:null;
}

export async function readPtRewardCounter(context,origin,config){
  let page;
  try{
    page=await context.newPage();
    await page.goto(`${origin}/`,{waitUntil:'domcontentloaded',timeout:Math.min(15000,Number(config.navigationTimeoutMs)||15000)});
    if(new URL(page.url()).origin!==origin)return null;
    return ptRewardCounter(await page.locator('body').innerText({timeout:5000}));
  }catch{return null;}
  finally{await page?.close().catch(()=>{});}
}

export async function runPtSupplement({root,origin,catalogFile,catalogHash,now,clock=()=>now?new Date(now):new Date(),
  readOnly=false,verifyBeforeSubmit=false,loginRecoveryOnly=false,validateScope=()=>{},
  launch=launchAutomationContext,runTarget=processTarget,readReward=readPtRewardCounter,
  acquire=acquireRunLock,release=releaseRunLock,inspectNative=inspectNativePtHeader,readAvailability=readPtPublicAvailability,
  readHddolby=readHddolbyHeader,recoverLogin=recoverPtLogin,readPassive=readPtPassivePage,
  fallbackAttemptId,validateLoginResume=validatePtLoginResume,readLoginProfile=readHhclubProfileState,
  runHddolbyNative=runNativeHddolby}={}){
  if(!/^[a-f0-9]{64}$/i.test(catalogHash??''))throw Error('catalog hash is required');
  const bytes=fs.readFileSync(catalogFile);
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==catalogHash.toLowerCase())throw Error('PT catalog changed');
  const target=ptSupplementTarget(JSON.parse(bytes.toString('utf8')),origin);
  if(loginRecoveryOnly&&(readOnly||!verifyBeforeSubmit||origin!=='https://www.uhddolby.com'))throw Error('Login-only recovery is not reviewed for this target');
  const startedAt=clock();
  const legacyRoot=path.resolve(root);
  const config=JSON.parse(fs.readFileSync(path.join(legacyRoot,'config/config.json'),'utf8'));
  const configHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(legacyRoot,'config/config.json'))).digest('hex');
  const unchangedConfig=()=>crypto.createHash('sha256').update(fs.readFileSync(path.join(legacyRoot,'config/config.json'))).digest('hex')===configHash;
  await validateScope();
  const plan=JSON.parse(fs.readFileSync(path.join(legacyRoot,'data/last-valid-bookmark-plan.json'),'utf8'));
  // A bookmark entry is not automatically a safe read-only URL. Some PT
  // sites perform attendance on page load, so their mature flow is a formal
  // mutation even when no button is clicked.
  if(!Array.isArray(plan.targets)||(!readOnly&&!verifyBeforeSubmit&&plan.targets.some(item=>item.origin===target.origin)))throw Error('PT origin belongs to the daily plan');
  if((config.excludedOrigins??[]).includes(target.origin)||(config.disabledCheckinOrigins??[]).includes(target.origin)||
    (config.disabledAccountKeys??[]).includes('site-default'))throw Error('PT origin disabled by execution configuration');
  const owners=plan.targets.filter(item=>item.origin===target.origin);
  if(owners.length>1)throw Error('PT account binding is ambiguous');
  target.accountKey=owners[0]?.accountKey??'site-default';
  if((config.disabledAccountKeys??[]).includes(target.accountKey))throw Error('PT account disabled by execution configuration');
  const policy=readOnly||verifyBeforeSubmit?ptReadPolicy(target.origin,config):null;
  const nativeRead=readOnly&&(policy?.nativeMainChrome===true||policy?.nativeIsolatedChrome===true);
  const binding=nativeRead?nativePtReadBinding(config,target,{root:legacyRoot,isolated:policy.nativeIsolatedChrome===true}):ptExecutionBinding(config,legacyRoot,target);
  const profile=binding.profile;
  if(!nativeRead&&!fs.existsSync(path.join(profile,'Local State')))throw Error('execution browser profile is unavailable');
  const readRules=file=>{try{return JSON.parse(fs.readFileSync(path.join(legacyRoot,file),'utf8')).rules??[];}catch(error){if(error.code==='ENOENT')return [];throw error;}};
  const rules=[...readRules('config/qa-rules.json'),...readRules('config/qa-rules.local.json')];
  const safeConfig={...binding.config,retryCount:0,failureScreenshots:false,capturePtEvidence:true,ptPassiveReadOnly:readOnly,
    ptFallbackRecheck:verifyBeforeSubmit===true||config.ptFallbackRecheck===true,
    ...(policy?.proxyServer?{ptReadProxyServer:policy.proxyServer}:{})};
  const metadata={accountKey:binding.accountKey,profileBinding:binding.profileBinding,startedAt:startedAt.toISOString(),
    operationMode:policy?.mode??'legacy_checkin',readSafety:policy?'reviewed_passive':'attendance_page_risk'};
  const lock=await acquire(path.join(legacyRoot,'tmp/run.lock'));
  let context;
  const loginOpt=config.siteTwoFactorRecovery?.[target.origin];
  const supportedLogin=target.origin==='https://hhanclub.net'&&loginOpt?.adapterId==='hhclub-nexus-login-v1'||
    target.origin==='https://www.uhddolby.com'&&loginOpt?.adapterId==='hddolby-nexus-stepup-v1'&&loginOpt.allowPasswordLogin===true;
  const canRecoverLogin=!readOnly&&supportedLogin&&loginOpt?.enabled===true&&loginOpt.reviewed===true&&loginOpt.provider==='bitwarden';
  let loginRecoveryUsed=false;
  const recoverLoginOnce=async()=>{
    if(loginRecoveryUsed)return {handled:true,status:'needs_attention',failureCode:'two_factor_required'};
    loginRecoveryUsed=true;
    return recoverLogin({root:legacyRoot,origin:target.origin,config,profile});
  };
  const recoverAndRead=async original=>{
    if(!canRecoverLogin||original?.status!=='login_required')return original;
    await context.close();context=null;
    await validateScope();
    if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('PT authentication scope changed');
    const login=await recoverLoginOnce();
    if(login?.handled!==true||login.status!=='logged_in')return {status:'needs_attention',submissionAttempted:false,
      failureCode:login?.failureCode==='two_factor_required'?'two_factor_required':'native_readback_unavailable',
      ...(login?.siteTwoFactorRecovery?{siteTwoFactorRecovery:login.siteTwoFactorRecovery}:{})};
    await validateScope();
    if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('PT authentication scope changed');
    const readPolicy=ptReadPolicy(target.origin,config);
    context=await launch({...safeConfig,ptPassiveReadOnly:true,
      ...(readPolicy.proxyServer?{ptReadProxyServer:readPolicy.proxyServer}:{})});
    if(readPolicy.hddolbyHeader===true){
      const result=await readHddolby(context,{origin:target.origin,now:clock(),proxyServer:readPolicy.proxyServer,expectedAccountId:loginOpt.expectedAccountId});
      if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('PT authentication scope changed');
      return {...result,submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
        ...(login.siteTwoFactorRecovery?{siteTwoFactorRecovery:login.siteTwoFactorRecovery}:{})};
    }
    await installPtReadFirewall(context,readPolicy);
    const page=await context.newPage();
    try{
      const response=await page.goto(readPolicy.url,{waitUntil:'domcontentloaded',timeout:15000});
      const observed=await readPassive(page,readPolicy,{origin:target.origin,now:clock(),httpStatus:response?.status?.()??0});
      if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('PT authentication scope changed');
      if(['not_signed','already_signed','signed'].includes(observed.status)&&observed.evidence?.authoritative===true&&
        observed.evidence.accountId!==String(loginOpt.expectedAccountId))
        return {status:'unknown',failureCode:'account_mismatch',submissionAttempted:false};
      return {...observed,submissionAttempted:false,
        operationMode:'safe_history_page',readSafety:'reviewed_passive',
        ...(login.siteTwoFactorRecovery?{siteTwoFactorRecovery:login.siteTwoFactorRecovery}:{})};
    }finally{await page.close().catch(()=>{});}
  };
  try {
    await validateScope();
    if(nativeRead){
      const result=await inspectNative({root:legacyRoot,origin:target.origin,url:policy.url,
        ...(policy.nativeIsolatedChrome===true?{isolated:true}:{})});
      if(result.submissionAttempted!==false)throw Error('Native PT read did not prove submission was disabled');
      if(dayAt(clock())!==dayAt(startedAt))throw Error('PT business day changed during readback');
      return publicSupplementResult(target.origin,{...metadata,...result,submissionAttempted:false},clock());
    }
    if(target.origin==='https://www.uhddolby.com'&&supportedLogin&&loginOpt?.enabled===true&&loginOpt.reviewed===true&&loginOpt.provider==='bitwarden'){
      if(!readOnly&&!verifyBeforeSubmit)throw Error('Native HDDolby requires a passive check before submission');
      // Checkin performs its own fresh passive read in the same native session.
      // Do not launch an extra read-only browser between the parent's proof and it.
      const nativeMode=readOnly||loginRecoveryOnly?'ReadOnly':'Checkin';
      let result=await runHddolbyNative({root:legacyRoot,origin:target.origin,config,profile,mode:nativeMode,clock});
      if(!readOnly&&result.status==='login_required'){
        const login=await recoverLoginOnce();
        result=login.status==='logged_in'?await runHddolbyNative({root:legacyRoot,origin:target.origin,config,profile,mode:nativeMode,clock}):login;
      }
      await validateScope();
      if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('Native HDDolby scope changed');
      return publicSupplementResult(target.origin,{...metadata,...result},clock());
    }
    if(canRecoverLogin&&!verifyBeforeSubmit&&fallbackAttemptId!==undefined){
      const firstDispatch=()=>validateLoginResume({root:legacyRoot,origin:target.origin,accountKey:binding.accountKey,
        profileBinding:binding.profileBinding,attemptId:fallbackAttemptId,now:clock()});
      const allowed=await firstDispatch();
      if(allowed?.allowed!==true)return publicSupplementResult(target.origin,{...metadata,status:'unknown',
        failureCode:'authoritative_status_unavailable',submissionAttempted:false},clock());
      const identityPolicy=ptReadPolicy(target.origin,config);
      context=await launch({...safeConfig,ptPassiveReadOnly:true,
        ...(identityPolicy.proxyServer?{ptReadProxyServer:identityPolicy.proxyServer}:{})});
      const identityArgs={expectedAccountId:String(loginOpt.expectedAccountId),now:clock()};
      let identity=await readLoginProfile(context,identityArgs);
      if(identity?.authenticated===true&&identity.accountMatched!==true)
        return publicSupplementResult(target.origin,{...metadata,status:'unknown',failureCode:'account_mismatch',submissionAttempted:false},clock());
      if(identity?.status==='login_required'&&identity.submissionAttempted===false){
        await context.close();context=null;
        await validateScope();
        if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig()||(await firstDispatch())?.allowed!==true)
          return publicSupplementResult(target.origin,{...metadata,status:'unknown',failureCode:'authoritative_status_unavailable',submissionAttempted:false},clock());
        const login=await recoverLoginOnce();
        if(login?.handled!==true||login.status!=='logged_in')
          return publicSupplementResult(target.origin,{...metadata,status:'needs_attention',failureCode:
            login?.failureCode==='two_factor_required'?'two_factor_required':'native_readback_unavailable',submissionAttempted:false},clock());
        context=await launch({...safeConfig,ptPassiveReadOnly:true,
          ...(identityPolicy.proxyServer?{ptReadProxyServer:identityPolicy.proxyServer}:{})});
        identity=await readLoginProfile(context,{...identityArgs,now:clock()});
        if(identity?.authenticated!==true||identity.accountMatched!==true)
          return publicSupplementResult(target.origin,{...metadata,status:'unknown',failureCode:
            identity?.authenticated===true?'account_mismatch':'native_readback_unavailable',submissionAttempted:false},clock());
      }
      await context.close();context=null;
      await validateScope();
      if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig()||(await firstDispatch())?.allowed!==true)
        return publicSupplementResult(target.origin,{...metadata,status:'unknown',failureCode:'authoritative_status_unavailable',submissionAttempted:false},clock());
      // The parent's existing audit proves this is the first dispatch, not a
      // replay. HHCLUB's identity panel supplies no daily negative evidence.
      // Continue its original flow and keep the real formal receipt.
    }
    context=await launch({...safeConfig,ptPassiveReadOnly:readOnly||verifyBeforeSubmit});
    await validateScope();
    let hddolbyVerified=false;
    if((readOnly||verifyBeforeSubmit)&&policy.hddolbyHeader===true){
      let result=await readHddolby(context,{origin:target.origin,now:clock(),
        proxyServer:policy.proxyServer,
        expectedAccountId:config.siteTwoFactorRecovery?.[target.origin]?.expectedAccountId});
      if(canRecoverLogin&&result.status==='login_required')result=await recoverAndRead(result);
      if(dayAt(clock())!==dayAt(startedAt))throw Error('PT business day changed during account header readback');
      if(readOnly||loginRecoveryOnly||result.status!=='not_signed'||result.evidence?.authoritative!==true)
        return publicSupplementResult(target.origin,{...metadata,...result},clock());
      await context.close();context=null;
      await validateScope();
      context=await launch({...safeConfig,ptPassiveReadOnly:false});
      metadata.operationMode='legacy_checkin';metadata.readSafety='attendance_page_risk';
      hddolbyVerified=true;
    }
    if(readOnly&&policy.selfProfileHeader===true){
      const result=await readOurbitsProfile(context,{origin:target.origin,now:clock()});
      if(dayAt(clock())!==dayAt(startedAt))throw Error('PT business day changed during profile readback');
      return publicSupplementResult(target.origin,{...metadata,...result},clock());
    }
    if(readOnly||verifyBeforeSubmit&&!hddolbyVerified){
      await installPtReadFirewall(context,policy);
      const readOnlyUrl=policy.url;
      const page=await context.newPage();
      try{
        const response=await page.goto(readOnlyUrl,{waitUntil:'domcontentloaded',timeout:Math.min(15000,Number(config.navigationTimeoutMs)||15000)}).catch(error=>{
          if(!readOnly||!policy.publicAvailabilityUrl)throw error;return null;
        });
        const observedAt=clock();
        let result=await readPassive(page,policy,{origin:target.origin,now:observedAt,httpStatus:response?.status?.()??0});
        // An authenticated daily control is newer account evidence than a
        // public maintenance landing page. Login also needs its own recovery.
        if(readOnly&&policy.publicAvailabilityUrl&&!['signed','already_signed','not_signed','login_required'].includes(result.status))
          result=await readAvailability(target.origin,policy)??result;
        if(dayAt(clock())!==dayAt(startedAt))throw Error('PT business day changed during readback');
        if(canRecoverLogin&&result.status==='login_required'){
          await page.close().catch(()=>{});
          result=await recoverAndRead(result);
        }
        if(readOnly||result.status!=='not_signed'||result.evidence?.authoritative!==true)
          return publicSupplementResult(target.origin,{...metadata,...result,submissionAttempted:false},clock());
      }finally{await page.close().catch(()=>{});}
      await context.close();context=null;
      await validateScope();
      if(dayAt(clock())!==dayAt(startedAt))throw Error('PT business day changed before submission');
      context=await launch({...safeConfig,ptPassiveReadOnly:false});
      metadata.operationMode='legacy_checkin';metadata.readSafety='attendance_page_risk';
    }
    const before=await readReward(context,target.origin,safeConfig);
    let result=await runTarget(context,target,safeConfig,rules,path.join(legacyRoot,'tmp'));
    if(canRecoverLogin&&result?.status==='login_required'){
      result=await recoverAndRead(result);
      if(result.status==='not_signed'&&result.evidence?.authoritative===true){
        await context.close();context=null;
        await validateScope();
        if(dayAt(clock())!==dayAt(startedAt)||!unchangedConfig())throw Error('PT authentication scope changed');
        context=await launch({...safeConfig,ptPassiveReadOnly:false});
        result=await runTarget(context,target,safeConfig,rules,path.join(legacyRoot,'tmp'));
      }
    }
    if(terminal.has(result?.status)&&result?.evidence?.authoritative!==true&&
       (before!==null||rewardHintOrigins.has(target.origin))){
      const after=await readReward(context,target.origin,safeConfig);
      const observedAt=clock();
      if(before!==null&&after!==null&&after>before){
        result={...result,evidence:{source:'pt_page',authoritative:dayAt(startedAt)===dayAt(observedAt),confirmedAt:observedAt.toISOString(),
          businessDate:dayAt(observedAt),statusSignal:'reward_increment'}};
      }else if(rewardHintOrigins.has(target.origin)&&after!==null&&after>0&&
               (before===null||after===before)){
        result={...result,evidence:{source:'pt_page',authoritative:false,statusSignal:'cumulative_reward'}};
      }
    }
    return publicSupplementResult(target.origin,{...result,...metadata},clock());
  } finally {
    try{await context?.close();}finally{await release(lock);}
  }
}
