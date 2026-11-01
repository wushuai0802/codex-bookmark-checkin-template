import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {nativePtReadBinding} from './native-pt-read.mjs';
import {ptReadPolicy} from './pt-read-policy.mjs';
import {runNativePtGate} from './native-pt-gate.mjs';
import {readNativePtApiHeaderInContext} from './native-pt-api.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {readRecoveryState,attemptedToday,writeRecoveryState} from './native-pt-two-factor.mjs';
import {piggoOrigin,piggoCalendarUrl,piggoDay,piggoApiData,piggoResponseFresh,
  acceptedPiggoCalendarReceipt,installPiggoCalendarFirewall} from './piggo-calendar.mjs';
import {inspectPiggoSpaLogin,usernameSelector,passwordSelector,submitSelector} from './piggo-login-form.mjs';
export {inspectPiggoSpaLogin} from './piggo-login-form.mjs';

const loginUrl=piggoOrigin+'/login';
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
  prepare,withLogin,validateLease=validateController,acquire=acquireRunLock,release=releaseRunLock}={}){
  let lock,firewall,route,attempted=false,accepted=false,reason='recovery_unavailable',entry,journal,output;
  const outcome=()=>output=({origin:piggoOrigin,handled:true,status:accepted?'logged_in':'needs_attention',
    ...(!accepted?{failureCode:'two_factor_required'}:{}),
    nativeTwoFactorRecovery:{phase:'password_login',attempted,accepted,reason}});
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
    if(!await bound())return outcome();
    journal=readRecoveryState(root);
    if(attemptedToday(journal,binding,today,'password_login')){reason='daily_recovery_limit';return outcome();}
    const verify=()=>readHeader({root,origin:piggoOrigin,context:page.context(),expectedProfileBinding:binding.profileBinding,profileProof,clock,gate});
    const register=async result=>{
      if(!acceptedPiggoCalendarReceipt(result?.readbackReceipt,binding,clock()))return false;
      const saved=await gate({...args,phase:'readback',receipt:result.readbackReceipt});
      return saved.allow===true&&saved.receiptAccepted===true;
    };
    const before=await verify();
    if(await register(before)){accepted=true;reason='already_authenticated';return outcome();}
    if(before.status!=='login_required'){reason='passive_proof_unavailable';return outcome();}
    firewall=await installPiggoCalendarFirewall(page.context(),{clock});
    let challengePosts=0,loginPosts=0,armed=false;
    route=async intercepted=>{
      const request=intercepted.request();let target;try{target=new URL(request.url());}catch{return intercepted.abort('blockedbyclient');}
      if(request.method()==='GET')return intercepted.fallback();
      if(!armed||target.origin!==piggoOrigin||target.search||target.hash||target.username||target.password||request.method()!=='POST')
        return intercepted.abort('blockedbyclient');
      if(target.pathname==='/v1/web/auth/srp/challenge'&&challengePosts===0&&loginPosts===0){challengePosts++;return intercepted.continue();}
      if(['/v1/web/auth/srp/login','/v1/web/login'].includes(target.pathname)&&loginPosts===0){loginPosts++;return intercepted.continue();}
      return intercepted.abort('blockedbyclient');
    };
    await page.route('**/*',route);
    const guestWait=page.waitForResponse(response=>response.url()===piggoOrigin+'/v1/web/auth/guest-config'&&
      response.request().method()==='GET',{timeout:15000}).catch(()=>null);
    await page.goto(loginUrl,{waitUntil:'domcontentloaded',timeout:15000});
    const guest=await guestWait;
    if(!guest||guest.status()!==200||!piggoResponseFresh(guest,clock())){reason='login_form_unreviewed';return outcome();}
    const guestText=await guest.text();
    if(Buffer.byteLength(guestText)>100_000||piggoApiData(JSON.parse(guestText))?.captcha!==false){reason='captcha_requires_manual';return outcome();}
    const form=await inspectForm(page);
    if(form?.challenge||form?.otp){reason=form.otp?'two_factor_requires_manual':'captcha_requires_manual';return outcome();}
    if(form?.reviewed!==true){reason='login_form_unreviewed';return outcome();}
    if(!prepare||!withLogin){const provider=await import('./bitwarden-totp.mjs');prepare??=provider.prepareBitwardenTotp;withLogin??=provider.withBitwardenLogin;}
    if((await prepare({root,origin:piggoOrigin,binding,config}))?.ready!==true){reason='provider_unavailable';return outcome();}
    let consumed=false,accepting=true,pending;
    const consume=credential=>{
      if(!accepting||consumed)return Promise.resolve();consumed=true;
      return pending=(async()=>{
      const latest=await inspectForm(page);
      if(latest?.reviewed!==true||latest.challenge||latest.otp||!await bound()){reason='login_form_changed';return;}
      await validateLease(root);
      journal=readRecoveryState(root);
      if(attemptedToday(journal,binding,today,'password_login')){reason='daily_recovery_limit';return;}
      entry={origin:piggoOrigin,accountKey:binding.accountKey,profileBinding:binding.profileBinding,businessDate:today,
        phase:'password_login',state:'pending',attemptedAt:clock().toISOString()};
      journal.attempts.push(entry);writeRecoveryState(root,journal);attempted=true;reason='authentication_unknown';
      const username=page.locator(usernameSelector),password=page.locator(passwordSelector);
      try{
        await username.fill(credential.username);await password.fill(credential.password);
        const filled=await inspectForm(page);
        if(filled?.reviewed!==true||filled.challenge||filled.otp||!await bound())throw Error('form changed');
        const responseWait=page.waitForResponse(response=>
          [piggoOrigin+'/v1/web/auth/srp/login',piggoOrigin+'/v1/web/login'].includes(response.url())&&
          response.request().method()==='POST',{timeout:20000}).catch(()=>null);
        armed=true;
        await page.locator(submitSelector).click({timeout:10000});
        const response=await responseWait;armed=false;
        if(loginPosts!==1||!response||!piggoResponseFresh(response,clock()))return;
        if([400,401,403,422].includes(response.status())){entry.state='rejected';reason='authentication_rejected';return;}
        if(response.status()!==200)return;
        const challenge=await inspectForm(page);
        if(challenge?.otp||challenge?.challenge){reason=challenge.otp?'two_factor_requires_manual':'captcha_requires_manual';return;}
        const after=await verify();
        if(!await bound()||!await register(after))return;
        accepted=true;entry.state='accepted';reason='authentication_accepted';
      }finally{
        armed=false;
        // No credential, code, raw response, title or exception enters output.
        await username.fill('').catch(()=>{});await password.fill('').catch(()=>{});
      }
      })();
    };
    let provided;
    try{provided=await withLogin({root,origin:piggoOrigin,binding,config,consume});}
    finally{accepting=false;if(pending)await pending;}
    if(provided?.ready!==true&&!attempted)reason='provider_unavailable';
    return outcome();
  }catch{return outcome();}
  finally{
    if(entry){
      if(entry.state==='pending')entry.state='unknown';
      entry.finishedAt=clock().toISOString();entry.reason=accepted?'authentication_accepted':
        entry.state==='rejected'?'authentication_rejected':'authentication_unknown';
      try{writeRecoveryState(root,journal);}catch{
        accepted=false;reason='authentication_unknown';
        if(output)Object.assign(output,{status:'needs_attention',failureCode:'two_factor_required',
          nativeTwoFactorRecovery:{phase:'password_login',attempted,accepted,reason}});
      }
    }
    if(route)await page.unroute('**/*',route).catch(()=>{});
    await firewall?.dispose().catch(()=>{});
    if(lock)await release(lock).catch(()=>{});
  }
}
