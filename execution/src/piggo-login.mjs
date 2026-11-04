import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {bounded,TIMED_OUT} from './bounded-wait.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
import {ptReadPolicy} from './pt-read-policy.mjs';
import {runNativePtGate} from './native-pt-gate.mjs';
import {readNativePtApiHeaderInContext,runPiggoCalendarCheckinInContext} from './native-pt-api.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {readRecoveryState,attemptedToday,writeRecoveryState} from './native-pt-two-factor.mjs';
import {piggoOrigin,piggoCalendarUrl,piggoLockedUrl,piggoDay,piggoApiData,piggoResponseFresh,
  acceptedPiggoCalendarReceipt,installPiggoCalendarFirewall} from './piggo-calendar.mjs';
import {inspectPiggoSpaLogin,inspectPiggoIdleUnlock,usernameSelector,passwordSelector,submitSelector,
  unlockPasswordSelector,unlockSubmitSelector} from './piggo-login-form.mjs';
export {inspectPiggoSpaLogin,inspectPiggoIdleUnlock} from './piggo-login-form.mjs';

const loginUrl=piggoOrigin+'/login';
// Every path segment starts with a letter, so numeric account IDs never enter diagnostics.
const safePath=/^\/(?:[a-z][a-z0-9_-]{0,30}(?:\/[a-z][a-z0-9_-]{0,30}){0,7})?$/;
const apiPath=value=>safePath.test(value)&&value.startsWith('/v1/web/');
const readbackCodes=values=>Object.fromEntries(Object.entries(values).filter(([,code])=>typeof code==='string'&&/^[a-z][a-z_]{0,39}$/.test(code)));
const pagePath=page=>{
  try{const url=new URL(page.url());return url.origin===piggoOrigin&&safePath.test(url.pathname)?url.pathname:undefined;}
  catch{return undefined;}
};
// Only the API envelope's numeric code is kept; its message and data never leave here.
async function unlockEnvelope(response,ms){
  try{
    const text=await bounded(response.text(),ms);if(text===TIMED_OUT||Buffer.byteLength(text)>100_000)return null;
    const value=JSON.parse(text);
    if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'code'))return null;
    return {accepted:value.code===0,...(Number.isSafeInteger(value.code)&&Math.abs(value.code)<1e9?{code:value.code}:{})};
  }catch{return null;}
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function validateController(root){
  const integration=read(path.join(root,'data/v2-integration.json'));
  if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot??''))throw Error('lease');
  const {validateEngineLease}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/legacy-engine.mjs')).href);
  if(validateEngineLease({root:integration.v2ProjectRoot,legacyRoot:root})!==true)throw Error('lease');
  const runner=read(path.join(root,'tmp/run.lock'));
  if(!Number.isSafeInteger(runner.pid)||runner.pid<=0||typeof runner.nonce!=='string'||!runner.nonce)throw Error('runner');
  process.kill(runner.pid,0);
}

export async function recoverPiggoSpaLogin({root,page,profile,profileProof,mode='Login',clock=()=>new Date(),
  gate=runNativePtGate,readHeader=readNativePtApiHeaderInContext,inspectForm=inspectPiggoSpaLogin,
  inspectUnlock=inspectPiggoIdleUnlock,checkinInContext=runPiggoCalendarCheckinInContext,
  prepare,withLogin,validateLease=validateController,acquire=acquireRunLock,release=releaseRunLock,timeouts={}}={}){
  // Tests may shorten these bounds; configuration cannot extend them.
  const limits=Object.fromEntries(Object.entries({consume:90000,body:5000,review:10000,verify:45000,
    binding:10000,response:20000,action:10000,cleanup:5000}).map(([key,value])=>
    [key,Number.isFinite(timeouts[key])&&timeouts[key]>0?Math.min(value,timeouts[key]):value]));
  let deadline=Infinity;
  const remaining=()=>Math.max(0,deadline-performance.now());
  const wait=async(operation,ms)=>{
    if(!remaining())throw Error('authentication_wait_expired');
    const result=await bounded(operation(),Math.min(ms,remaining()));
    if(result===TIMED_OUT||!remaining())throw Error('authentication_wait_expired');
    return result;
  };
  let lock,firewall,route,attempted=false,accepted=false,reason='recovery_unavailable',providerReason,entry,journal,output;
  let passiveDiagnostic={},submitDiagnostic={},recoveryMode='password_login',dailyCheckin,finalized=false;const blockedPosts=[];
  const outcome=()=>output=({origin:piggoOrigin,handled:true,status:accepted?'logged_in':'needs_attention',
    ...(dailyCheckin?{dailyCheckin}:{}),
    ...(!accepted?{failureCode:'two_factor_required'}:{}),
    nativeTwoFactorRecovery:{phase:'password_login',recoveryMode,attempted,accepted,reason,...(providerReason?{providerReason}:{}),...passiveDiagnostic,
      ...submitDiagnostic,...(blockedPosts.length?{blockedPosts:[...blockedPosts]}:{})}});
  try{
    // A read-only consumer must not even prepare the vault or navigate login.
    if(mode!=='Login'){reason='readonly';return outcome();}
    const configFile=path.join(root,'config/config.json'),configText=fs.readFileSync(configFile,'utf8'),config=JSON.parse(configText),
      fingerprint=crypto.createHash('sha256').update(configText).digest('hex');
    const opt=config.nativePtTwoFactorRecovery?.[piggoOrigin];
    if(opt?.enabled!==true||opt.reviewed!==true||opt.provider!=='bitwarden'||opt.allowPasswordLogin!==true||
      opt.loginSource!=='bitwarden'){reason='login_not_allowed';return outcome();}
    if(opt.spaPasswordFormReviewed!==true){reason='login_form_unreviewed';return outcome();}
    ptReadPolicy(piggoOrigin,config);
    const binding=nativePtReadBinding(config,{origin:piggoOrigin,accountKey:'site-default'},{root,isolated:true});
    if(path.resolve(profile??'').toLowerCase()!==binding.profile.toLowerCase()||typeof profileProof!=='function')return outcome();
    await validateLease(root);
    lock=await acquire(path.join(root,'tmp/piggo-password-login.lock'));
    const today=piggoDay(clock()),args={root,origin:piggoOrigin,url:piggoCalendarUrl,profile:binding.profile,mainProfile:false,clock};
    const bound=async()=>{
      const result=await gate({...args,phase:'bind'});
      return result.managed===true&&result.allow===true&&result.accountKey===binding.accountKey&&
        result.profileBinding===binding.profileBinding&&hash(configFile)===fingerprint&&piggoDay(clock())===today&&await profileProof();
    };
    if(!await wait(bound,limits.binding))return outcome();
    journal=readRecoveryState(root);
    if(attemptedToday(journal,binding,today,'password_login')){reason='daily_recovery_limit';return outcome();}
    const verify=()=>readHeader({root,origin:piggoOrigin,context:page.context(),expectedProfileBinding:binding.profileBinding,profileProof,clock,gate});
    const register=async result=>{
      if(!acceptedPiggoCalendarReceipt(result?.readbackReceipt,binding,clock()))return false;
      const saved=await gate({...args,phase:'readback',receipt:result.readbackReceipt});
      return saved.allow===true&&saved.receiptAccepted===true;
    };
    const complete=async()=>{
      // Persist authentication before any attendance intent. A failed audit
      // finalization leaves the daily guard and never opens the write path.
      if(entry){entry.finishedAt=clock().toISOString();entry.reason='authentication_accepted';writeRecoveryState(root,journal);finalized=true;}
      dailyCheckin=await checkinInContext({root,context:page.context(),expectedProfileBinding:binding.profileBinding,
        profileProof:async()=>await bounded(bound(),limits.binding)===true,clock,gate,validateLease});
      return outcome();
    };
    const before=await wait(verify,limits.verify);
    if(await wait(()=>register(before),limits.binding)){accepted=true;reason='already_authenticated';return await complete();}
    if(before?.status!=='login_required'){
      reason='passive_proof_unavailable';
      passiveDiagnostic=readbackCodes({passiveStatus:before.status,passiveFailure:before.failureCode,
        passiveStage:before.nativeReadback?.apiStage});
      return outcome();
    }
    const unlocking=before.failureCode==='idle_locked';
    recoveryMode=unlocking?'idle_unlock':'password_login';
    const review=unlocking?inspectUnlock:inspectForm,passwordField=unlocking?unlockPasswordSelector:passwordSelector,
      submitButton=unlocking?unlockSubmitSelector:submitSelector;
    const challengePath=unlocking?'/v1/web/me/lab-unlock/srp/challenge':'/v1/web/auth/srp/challenge';
    const submitPaths=unlocking?['/v1/web/me/lab-unlock/srp']:['/v1/web/auth/srp/login','/v1/web/login'];
    if(unlocking){
      const unlockBound=await wait(()=>gate({...args,url:piggoLockedUrl,phase:'bind',recoveryMode}),limits.binding);
      if(unlockBound.managed!==true||unlockBound.allow!==true||unlockBound.accountKey!==binding.accountKey||
        unlockBound.profileBinding!==binding.profileBinding||!await wait(bound,limits.binding))return outcome();
    }
    firewall=await installPiggoCalendarFirewall(page.context(),{clock,allowIdleUnlock:unlocking,allowAuthLanding:true});
    let challengePosts=0,loginPosts=0,armed=false,clicked=false;
    route=async intercepted=>{
      const request=intercepted.request();let target;try{target=new URL(request.url());}catch{return intercepted.abort('blockedbyclient');}
      if(request.method()==='GET')return intercepted.fallback();
      const block=()=>{
        // After the click, a blocked same-origin API path says which request the page still needed.
        if(clicked&&blockedPosts.length<4&&target.origin===piggoOrigin&&apiPath(target.pathname))blockedPosts.push(target.pathname);
        return intercepted.abort('blockedbyclient');
      };
      if(!armed||target.origin!==piggoOrigin||target.search||target.hash||target.username||target.password||request.method()!=='POST'||
        /\.\.|\\|%(?:2e|2f|5c)/i.test(request.url().split(/[?#]/)[0]))
        return block();
      if(target.pathname===challengePath&&challengePosts===0&&loginPosts===0){challengePosts++;return intercepted.continue();}
      if(submitPaths.includes(target.pathname)&&loginPosts===0&&(!unlocking||challengePosts===1)){loginPosts++;return intercepted.continue();}
      return block();
    };
    await page.route('**/*',route);
    const guestWait=unlocking?null:page.waitForResponse(response=>response.url()===piggoOrigin+'/v1/web/auth/guest-config'&&
      response.request().method()==='GET',{timeout:15000}).catch(()=>null);
    await page.goto(unlocking?piggoLockedUrl:loginUrl,{waitUntil:'domcontentloaded',timeout:15000});
    if(!unlocking){
    const guest=await guestWait;
    if(!guest||guest.status()!==200||!piggoResponseFresh(guest,clock())){reason='login_form_unreviewed';return outcome();}
    const guestText=await wait(()=>guest.text(),limits.body);
    if(Buffer.byteLength(guestText)>100_000||piggoApiData(JSON.parse(guestText))?.captcha!==false){reason='captcha_requires_manual';return outcome();}
    }
    // The page requests guest-config before it loads the lazy login chunk.
    await page.waitForSelector(unlocking?passwordField:usernameSelector,{timeout:15000}).catch(()=>{});
    const form=await wait(()=>review(page),limits.review);
    if(form?.challenge||form?.otp){reason=form.otp?'two_factor_requires_manual':'captcha_requires_manual';return outcome();}
    if(form?.reviewed!==true){reason='login_form_unreviewed';return outcome();}
    if(!prepare||!withLogin){const provider=await import('./bitwarden-totp.mjs');prepare??=provider.prepareBitwardenTotp;withLogin??=provider.withBitwardenLogin;}
    const prepared=await prepare({root,origin:piggoOrigin,binding,config});
    if(prepared?.ready!==true){reason='provider_unavailable';providerReason=prepared?.reason;return outcome();}
    let consumed=false,accepting=true,pending;
    const consume=credential=>{
      if(!accepting||consumed)return Promise.resolve();consumed=true;
      return pending=(async()=>{
      const latest=await wait(()=>review(page),limits.review);
      if(latest?.reviewed!==true||latest.challenge||latest.otp||!await wait(bound,limits.binding)){reason='login_form_changed';return;}
      await wait(()=>validateLease(root),limits.binding);
      journal=readRecoveryState(root);
      if(attemptedToday(journal,binding,today,'password_login')){reason='daily_recovery_limit';return;}
      entry={origin:piggoOrigin,accountKey:binding.accountKey,profileBinding:binding.profileBinding,businessDate:today,
        phase:'password_login',recoveryMode,state:'pending',attemptedAt:clock().toISOString()};
      journal.attempts.push(entry);writeRecoveryState(root,journal);attempted=true;reason='authentication_unknown';
      const username=unlocking?null:page.locator(usernameSelector),password=page.locator(passwordField);
      // The last stage reached tells an unknown result apart: before the click nothing was sent.
      const stage=value=>{
        submitDiagnostic.submitStage=unlocking?'unlock_'+value:value;
        entry.stage=submitDiagnostic.submitStage;writeRecoveryState(root,journal);
      };
      try{
        deadline=performance.now()+limits.consume;
        stage('fill');
        if(username)await wait(()=>username.fill(credential.username,{timeout:limits.action}),limits.action);
        await wait(()=>password.fill(credential.password,{timeout:limits.action}),limits.action);
        const filled=await wait(()=>review(page),limits.review);
        if(filled?.reviewed!==true||filled.challenge||filled.otp||!await wait(bound,limits.binding))throw Error('form changed');
        const responseWait=page.waitForResponse(response=>
          submitPaths.some(value=>response.url()===piggoOrigin+value)&&
          response.request().method()==='POST',{timeout:limits.response}).catch(()=>null);
        armed=true;clicked=true;stage('click');
        await wait(()=>page.locator(submitButton).click({timeout:limits.action}),limits.action);
        stage('login_response');
        const response=await bounded(responseWait,Math.min(limits.response,remaining()));armed=false;
        Object.assign(submitDiagnostic,{challengePosts,loginPosts});
        if(loginPosts!==1||!remaining())return;
        if(response&&response!==TIMED_OUT){
        stage('login_response_freshness');
        if(!piggoResponseFresh(response,clock()))return;
        stage('login_http_status');submitDiagnostic.loginHttpStatus=response.status();
        if([400,401,403,422].includes(response.status())){entry.state='rejected';reason='authentication_rejected';return;}
        if(response.status()!==200)return;
          const envelope=await unlockEnvelope(response,Math.min(limits.body,remaining()));
          if(envelope?.code!==undefined)submitDiagnostic.loginApiCode=envelope.code;
          if(!envelope)submitDiagnostic.loginEnvelope='unavailable';
          // Only the unlock envelope rejects; a login code stays diagnostic and the readback decides.
          else if(unlocking&&!envelope.accepted){entry.state='rejected';reason='authentication_rejected';return;}
        }else submitDiagnostic.loginEnvelope='unavailable';
        if(!remaining())return;
        stage('post_login_form');
        const challenge=await wait(()=>review(page),limits.review);
        submitDiagnostic.postLoginForm=!challenge?'navigated':challenge.otp?'otp':challenge.challenge?'challenge':
          challenge.reviewed?'unchanged':'changed';
        if(challenge?.otp||challenge?.challenge){reason=challenge.otp?'two_factor_requires_manual':'captcha_requires_manual';return;}
        stage('post_login_readback');
        const after=await wait(verify,limits.verify);
        Object.assign(submitDiagnostic,readbackCodes({afterStatus:after?.status,afterFailure:after?.failureCode,
          afterStage:after?.nativeReadback?.apiStage}));
        const landed=pagePath(page);if(landed)submitDiagnostic.loginPagePath=landed;
        stage('post_login_binding');
        if(!await wait(bound,limits.binding))return;
        stage('post_login_receipt');
        if(!await wait(()=>register(after),limits.binding))return;
        stage('accepted');
        accepted=true;entry.state='accepted';reason='authentication_accepted';
      }finally{
        armed=false;
        // No credential, one-time code, raw response, title or exception enters output; only fixed codes and numbers do.
        if([loginUrl,piggoLockedUrl].includes(page.url())){
          if(username)await bounded(username.fill('',{timeout:3000}),3000).catch(()=>{});
          await bounded(password.fill('',{timeout:3000}),3000).catch(()=>{});
        }
      }
      })();
    };
    let provided;
    try{provided=await withLogin({root,origin:piggoOrigin,binding,config,consume});}
    finally{accepting=false;if(pending)await pending;}
    if(provided?.ready!==true&&!attempted){reason='provider_unavailable';providerReason=provided?.reason;}
    return accepted?await complete():outcome();
  }catch{if(entry&&!finalized){accepted=false;if(entry.state==='accepted')entry.state='unknown';reason='authentication_unknown';}return outcome();}
  finally{
    if(entry&&!finalized){
      if(entry.state==='pending')entry.state='unknown';
      entry.finishedAt=clock().toISOString();entry.reason=accepted?'authentication_accepted':
        entry.state==='rejected'?'authentication_rejected':'authentication_unknown';
      try{writeRecoveryState(root,journal);}catch{
        accepted=false;reason='authentication_unknown';
        if(output)Object.assign(output,{status:'needs_attention',failureCode:'two_factor_required',
          nativeTwoFactorRecovery:{phase:'password_login',recoveryMode,attempted,accepted,reason}});
      }
    }
    // Closing the credential tab may emit lab-lock; keep both firewalls in
    // place until it is closed. The caller still owns the browser context.
    const closed=firewall&&typeof page.close==='function'
      ?await bounded(page.close(),limits.cleanup).catch(()=>TIMED_OUT):undefined;
    // If close stalls, retain the write firewall until the caller disconnects.
    if(closed!==TIMED_OUT){
      if(route)await bounded(page.unroute('**/*',route),limits.cleanup).catch(()=>{});
      await bounded(firewall?.dispose(),limits.cleanup).catch(()=>{});
    }
    if(lock)await release(lock).catch(()=>{});
  }
}
