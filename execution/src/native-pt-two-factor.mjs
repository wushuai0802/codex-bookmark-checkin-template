import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {launchAutomationContext} from './browser.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
import {readNativePtApiHeader,readNativePtApiHeaderInContext,piggoNativePassiveContext} from './native-pt-api.mjs';
import {runNativePtGate} from './native-pt-gate.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';

const ORIGIN='https://piggo.me',HOME=ORIGIN+'/index.php';
const PROTOCOL=ORIGIN+'/inputWrap/js/index.js',AUTH=ORIGIN+'/bank/authentication';
const PROOF_MAX_AGE_MS=30_000,MIN_CODE_REMAINING_MS=3_000;
const vaultKeys=['BW_SESSION','BW_PASSWORD','BW_CLIENTID','BW_CLIENTSECRET'];
const providerFailureReasons=new Set(['disabled','origin_not_allowed','profile_mismatch','invalid_configuration',
  'runtime_unavailable','entrypoint_unavailable','session_missing','session_invalid','session_unavailable',
  'provider_busy','server_mismatch','vault_locked','vault_unauthenticated','vault_state_invalid',
  'cli_status_failed','cli_status_invalid','vault_sync_failed','totp_read_failed','totp_invalid',
  'totp_near_rotation','clock_invalid','clock_unstable','totp_wait_failed','totp_consumer_failed',
  'helper_failed','helper_output_invalid']);
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hashFile=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical=value=>path.resolve(value).toLowerCase();
const metadata=(reason,attempted=false,accepted=false)=>({nativeTwoFactorRecovery:{attempted,accepted,reason}});
const nowDate=clock=>{const value=new Date(clock());if(!Number.isFinite(value.getTime()))throw Error('clock');return value;};
const providerFailure=value=>value?.ready===false&&providerFailureReasons.has(value.reason)
  ?value.reason==='provider_busy'?'provider_busy':'provider_'+value.reason:'totp_unavailable';

function settings(root,origin,expectedProfileBinding){
  if(!path.isAbsolute(root??'')||origin!==ORIGIN||!/^[a-f0-9]{64}$/.test(expectedProfileBinding??''))throw Error('configuration');
  root=path.resolve(root);
  const file=path.join(root,'config/config.json'),config=read(file),optIn=config.nativePtTwoFactorRecovery?.[origin];
  if(optIn?.enabled!==true||optIn.reviewed!==true||optIn.provider!=='bitwarden')return null;
  const policy=config.ptReadOnlyPolicies?.[origin];
  if(policy?.reviewed!==true||policy.nativeApiHeaderFallback!==true||policy.nativeIsolatedChrome!==true||
    policy.dailyHeader!==true||policy.mode!=='safe_history_page'||policy.url!==HOME||
    policy.selector!=='#info_block'||policy.actionPath!=='/attendance.php'||
    (config.supplementalOAuthAccounts??[]).some(value=>value.origin===origin))throw Error('configuration');
  const binding=nativePtReadBinding(config,{origin,accountKey:'site-default'},{root,isolated:true});
  if(binding.profileBinding!==expectedProfileBinding)throw Error('binding');
  return {root,origin,config,policy,binding,configHash:hashFile(file)};
}

function realChallenge(value,binding,now){
  const facts=value?.nativeSecurityDiagnostic;
  const typed=['verificationRoute','otpInputPresent','scopedOtpInputPresent','passwordInputPresent','sameOrigin','pageContentAvailable','waf'];
  const observed=Date.parse(value?.observedAt??'');
  return value?.origin===ORIGIN&&value.accountKey==='site-default'&&value.profileBinding===binding.profileBinding&&
    Number.isFinite(observed)&&observed<=now.getTime()&&now.getTime()-observed<=5*60_000&&day(observed)===day(now)&&
    (value.failureCode==='two_factor_required'||value.underlyingFailureCode==='two_factor_required')&&
    facts&&typed.every(key=>typeof facts[key]==='boolean')&&facts.otpInputPresent===true&&
    facts.scopedOtpInputPresent===true&&facts.passwordInputPresent===false&&facts.sameOrigin===true&&
    facts.pageContentAvailable===true&&facts.waf===false;
}

async function validateControllerLease(root){
  const integration=read(path.join(root,'data/v2-integration.json')),controller=integration.v2ProjectRoot;
  if(integration.executionEngine!=='v1'||!path.isAbsolute(controller??'')||
    !path.isAbsolute(process.env.CHECKIN_V2_ENGINE_ROOT??'')||
    canonical(process.env.CHECKIN_V2_ENGINE_ROOT)!==canonical(controller)||!process.env.CHECKIN_V2_ENGINE_LEASE)
    throw Error('lease');
  const {validateEngineLease}=await import(pathToFileURL(path.join(controller,'src/legacy-engine.mjs')).href);
  if(validateEngineLease({root:controller,legacyRoot:root})!==true)throw Error('lease');
}

function sameConfiguration(state){
  return hashFile(path.join(state.root,'config/config.json'))===state.configHash;
}

function readRecoveryState(root){
  const file=path.join(root,'data/bitwarden/recovery-state.json');
  if(!fs.existsSync(file))return {schemaVersion:1,attempts:[]};
  const value=read(file);
  if(value?.schemaVersion!==1||!Array.isArray(value.attempts)||value.attempts.length>4096||
    value.attempts.some(entry=>entry?.origin!==ORIGIN||entry.accountKey!=='site-default'||
      !/^[a-f0-9]{64}$/.test(entry.profileBinding??'')||!['pending','accepted','rejected','unknown'].includes(entry.state)||
      !Number.isFinite(Date.parse(entry.attemptedAt??''))||entry.businessDate!==day(entry.attemptedAt)||
      entry.phase!==undefined&&!['stepup','password_login'].includes(entry.phase)))throw Error('state');
  // Project only the non-secret fields, even if another writer added content.
  return {schemaVersion:1,attempts:value.attempts.map(entry=>({origin:entry.origin,accountKey:entry.accountKey,
    profileBinding:entry.profileBinding,businessDate:entry.businessDate,state:entry.state,attemptedAt:entry.attemptedAt,
    ...(entry.phase?{phase:entry.phase}:{}),
    ...(Number.isFinite(Date.parse(entry.finishedAt??''))?{finishedAt:entry.finishedAt}:{}),
    ...(['authentication_accepted','authentication_rejected','authentication_unknown','authentication_redirected',
      'authentication_http_error','authentication_response_invalid'].includes(entry.reason)?{reason:entry.reason}:{})}))};
}

function attemptedToday(state,binding,businessDate,phase='stepup'){
  return state.attempts.some(entry=>entry.origin===ORIGIN&&entry.accountKey===binding.accountKey&&
    entry.profileBinding===binding.profileBinding&&entry.businessDate===businessDate&&(entry.phase??'stepup')===phase);
}

function writeRecoveryState(root,state){
  const file=path.join(root,'data/bitwarden/recovery-state.json'),temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

function stripComments(source){
  let output='',quote=null,escaped=false;
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(quote){
      output+=char;
      if(escaped){escaped=false;continue;}
      if(char==='\\'){escaped=true;continue;}
      if(char===quote){quote=null;continue;}
      if((char==='\n'||char==='\r')&&quote!=='`')return null;
      continue;
    }
    if(char==='"'||char==="'"||char==='`'){quote=char;output+=char;continue;}
    if(char==='/'&&source[i+1]==='/'){
      output+=' ';i++;
      while(i+1<source.length&&source[i+1]!=='\n'&&source[i+1]!=='\r')i++;
      continue;
    }
    if(char==='/'&&source[i+1]==='*'){
      const end=source.indexOf('*/',i+2);if(end===-1)return null;
      output+=' '+source.slice(i+2,end).replace(/[^\r\n]/g,' ');i=end+1;continue;
    }
    output+=char;
  }
  return quote?null:output;
}

function quotedProperty(source,name){
  const matches=[...source.matchAll(new RegExp(`(?:\\b${name}|['"]${name}['"])\\s*:\\s*(['"])([^'"]*)\\1`,'g'))];
  return matches.length===1?matches[0][2]:null;
}

// Inspect a bounded public contract without evaluating the site's JavaScript.
function verifiedProtocol({url,status,body}={}){
  if(url!==PROTOCOL||status!==200||typeof body!=='string'||!body||Buffer.byteLength(body)>16_384)return false;
  const source=stripComments(body);if(source===null)return false;
  if([...source.matchAll(/\bjQuery\.ajax\s*\(/g)].length!==1||quotedProperty(source,'url')!=='/bank/authentication'||
    quotedProperty(source,'type')!=='POST'||[...source.matchAll(/\.append\s*\(/g)].length!==1||
    !/\bformData\.append\s*\(\s*(['"])two_step_code\1\s*,\s*prevVal\s*\)/.test(source)||
    !/\bdata\s*:\s*formData\b/.test(source)||!/\bprocessData\s*:\s*false\b/.test(source)||
    !/\bcontentType\s*:\s*false\b/.test(source)||!/\.done\s*\(\s*function\s*\(\s*response\s*\)/.test(source))return false;
  const assignment=source.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*lodashGet\s*\(\s*response\s*,\s*(['"])msg\2\s*,\s*null\s*\)/);
  if(!assignment)return false;
  return /if\s*\(\s*lodashGet\s*\(\s*response\s*,\s*(['"])ret\1\s*,\s*null\s*\)\s*!==\s*0\s*\)/.test(source)&&
    new RegExp(`if\\s*\\(\\s*${assignment[1].replace(/\$/g,'\\$')}\\s*===\\s*(['"])ok\\1\\s*\\)\\s*\\{\\s*window\\.location\\.reload\\(\\s*\\)\\s*;?`).test(source);
}

function receiptFor(value,state,now){
  const receipt=value?.readbackReceipt,inspection=receipt?.inspection,evidence=receipt?.evidence;
  const observed=Date.parse(receipt?.observedAt??''),confirmed=Date.parse(evidence?.confirmedAt??'');
  if(!['already_signed','not_signed'].includes(receipt?.status)||value.status!==receipt.status||
    receipt.origin!==ORIGIN||receipt.url!==HOME||receipt.accountKey!=='site-default'||
    receipt.profileBinding!==state.binding.profileBinding||receipt.submissionAttempted!==false||
    receipt.operationMode!=='safe_history_page'||receipt.readSafety!=='reviewed_passive'||
    receipt.businessDate!==day(now)||evidence?.businessDate!==day(now)||evidence.authoritative!==true||
    evidence.source!=='page_text'||evidence.pagePath!=='/index.php'||evidence.evidenceScope!=='site_account_day'||
    !Number.isFinite(observed)||!Number.isFinite(confirmed)||observed>now.getTime()||confirmed>now.getTime()||
    now.getTime()-observed>PROOF_MAX_AGE_MS||now.getTime()-confirmed>PROOF_MAX_AGE_MS||
    day(observed)!==day(now)||day(confirmed)!==day(now)||Math.abs(observed-confirmed)>1000||
    inspection?.currentUrl!==HOME||inspection.authenticated!==true||inspection.sameOrigin!==true||
    inspection.pageContentAvailable!==true||inspection.siteBodyLoaded!==true||inspection.waf!==false||
    inspection.loginRoute!==false||inspection.securityVerification!==false)return null;
  const negative=receipt.status==='not_signed',text=String(negative?inspection.unsignedControl:inspection.successControl);
  const unsigned=[state.policy.unsignedText,...(state.policy.unsignedTexts??[])].filter(value=>typeof value==='string');
  const signed=/^(?:今日|今天)?(?:已签到|已簽到|已经签到|已經簽到)$/.test(text)||
    state.policy.signedRewardControl===true&&/^(?:签到已得|簽到已得)[0-9,.]+(?:,\s*补签卡:\s*\d+)?$/.test(text);
  if(text.length>128||(negative?!(evidence.statusSignal==='nexus_daily_header_unsigned'&&unsigned.includes(text)&&
      inspection.success===false&&inspection.signedControlCount===0&&inspection.unsignedControlCount===1&&!inspection.successControl):
    !(evidence.statusSignal==='nexus_daily_header_signed'&&signed&&inspection.success===true&&
      inspection.signedControlCount===1&&inspection.unsignedControlCount===0&&!inspection.unsignedControl)))return null;
  return {origin:ORIGIN,url:HOME,accountKey:'site-default',profileBinding:state.binding.profileBinding,status:receipt.status,
    businessDate:receipt.businessDate,observedAt:receipt.observedAt,submissionAttempted:false,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',evidence:{source:'page_text',authoritative:true,
      confirmedAt:evidence.confirmedAt,businessDate:evidence.businessDate,pagePath:'/index.php',
      statusSignal:evidence.statusSignal,evidenceScope:'site_account_day'},
    inspection:{currentUrl:HOME,sameOrigin:true,pageContentAvailable:true,siteBodyLoaded:true,authenticated:true,
      waf:false,loginRoute:false,securityVerification:false,success:!negative,successText:false,
      signedControlCount:negative?0:1,unsignedControlCount:negative?1:0,
      successControl:negative?'':text,unsignedControl:negative?text:''}};
}

/** Recover a reviewed native 2FA challenge; this never submits attendance. */
export async function recoverNativePtTwoFactor({root,origin,nativeDiagnostic,expectedProfileBinding,clock=Date.now,
  launch=launchAutomationContext,gate=runNativePtGate,prepare,withTotp,readHeader=readNativePtApiHeader,
  acquire=acquireRunLock,release=releaseRunLock}={}){
  let state,context,closeContext,lock,attempted=false,accepted=false,reason='recovery_unavailable';
  const savedEnvironment=new Map(vaultKeys.filter(key=>Object.hasOwn(process.env,key)).map(key=>[key,process.env[key]]));
  for(const key of vaultKeys)delete process.env[key];
  try{
    try{state=settings(root,origin,expectedProfileBinding);}catch{return metadata('configuration_invalid');}
    if(!state)return metadata('disabled');
    if(!realChallenge(nativeDiagnostic,state.binding,nowDate(clock)))return metadata('challenge_invalid');
    try{await validateControllerLease(state.root);}catch{return metadata('lease_unavailable');}
    try{lock=await acquire(path.join(state.root,'tmp/run.lock'));}catch{return metadata('execution_busy');}
    const dateClock=()=>nowDate(clock),startedDay=day(dateClock());
    const boundArgs={root:state.root,origin:ORIGIN,url:HOME,profile:state.binding.profile,mainProfile:false,phase:'bind',clock:dateClock};
    const bind=async()=>{
      const bound=await gate(boundArgs);
      return bound?.managed===true&&bound.allow===true&&bound.accountKey==='site-default'&&
        bound.profileBinding===state.binding.profileBinding&&sameConfiguration(state)&&day(dateClock())===startedDay;
    };
    if(!await bind())return metadata('scope_unavailable');
    let journal;try{journal=readRecoveryState(state.root);}catch{return metadata('recovery_state_invalid');}
    let accountId=null;
    const retainedLaunch=async options=>{
      if(options.automationUserDataDir!==state.binding.profile||options.nativePtReadOrigin!==ORIGIN||
        options.ptPassiveReadOnly!==true)throw Error('context binding');
      if(!context){
        context=await launch({...options,backgroundWindowMode:'offscreen',failureScreenshots:false});
        closeContext=context.close.bind(context);
      }
      return {request:context.request,route:context.route.bind(context),close:async()=>{},newPage:async()=>{
        const page=await context.newPage(),evaluate=page.evaluate.bind(page);
        page.evaluate=async(fn,args)=>{
          const parsed=await evaluate(fn,args);
          if(args?.url===HOME){
            const identities=[...new Set((parsed?.controls??[]).filter(control=>control.path==='/userdetails.php')
              .map(control=>control.accountId).filter(value=>/^\d{1,20}$/.test(value??'')))];
            accountId=identities.length===1?identities[0]:null;
          }
          return parsed;
        };
        return page;
      }};
    };
    const passive=async()=>{
      accountId=null;
      const value=await readHeader({root:state.root,origin:ORIGIN,launch:retainedLaunch,gate,clock:dateClock});
      return {receipt:receiptFor(value,state,dateClock()),accountId};
    };
    const before=await passive();
    if(!before.receipt||!before.accountId)return metadata('passive_proof_unavailable');
    if(before.receipt.status==='already_signed')return {...metadata('already_signed'),readbackReceipt:before.receipt};
    if(attemptedToday(journal,state.binding,startedDay))return metadata('daily_recovery_limit');
    if(!prepare||!withTotp){
      const provider=await import('./bitwarden-totp.mjs');
      prepare??=provider.prepareBitwardenTotp;withTotp??=provider.withBitwardenTotp;
    }
    const ready=await prepare({root:state.root,origin:ORIGIN,binding:state.binding,config:state.config});
    if(ready?.ready!==true)return metadata(providerFailure(ready));
    const response=await context.request.get(PROTOCOL,{maxRedirects:0,maxRetries:0,ignoreHTTPSErrors:false,timeout:15_000});
    if(!verifiedProtocol({url:response.url(),status:response.status(),body:await response.text()}))return metadata('protocol_unverified');
    // Sync and protocol preparation may be slow. Renew the passive proof before
    // reading an ephemeral code; do not reuse the first 30-second proof.
    const fresh=await passive();
    if(!fresh.receipt||fresh.accountId!==before.accountId)return metadata('account_changed');
    if(fresh.receipt.status==='already_signed')return {...metadata('already_signed'),readbackReceipt:fresh.receipt};
    if(!realChallenge(nativeDiagnostic,state.binding,dateClock()))return metadata('challenge_invalid');
    if(!await bind())return metadata('scope_unavailable');
    await validateControllerLease(state.root);
    let callbackUsed=false,accepting=true,pending;
    reason='totp_unavailable';
    const submit=async(code,codeMetadata)=>{
      if(typeof code!=='string'||!/^\d{6}$/.test(code)){reason='totp_invalid';return;}
      const now=dateClock(),age=now.getTime()-Date.parse(fresh.receipt.observedAt);
      if(day(now)!==startedDay){reason='business_day_changed';return;}
      if(age<0||age>PROOF_MAX_AGE_MS){reason='proof_expired';return;}
      if(!Number.isFinite(codeMetadata?.validUntilMs)||codeMetadata.validUntilMs-now.getTime()<MIN_CODE_REMAINING_MS||
        codeMetadata.validUntilMs-now.getTime()>30_000){reason='totp_expired';return;}
      if(!await bind()){reason='scope_unavailable';return;}
      try{await validateControllerLease(state.root);}catch{reason='lease_unavailable';return;}
      if(!realChallenge(nativeDiagnostic,state.binding,dateClock())){reason='challenge_invalid';return;}
      try{journal=readRecoveryState(state.root);}catch{reason='recovery_state_invalid';return;}
      if(attemptedToday(journal,state.binding,startedDay)){reason='daily_recovery_limit';return;}
      const dispatchTime=dateClock(),dispatchAge=dispatchTime.getTime()-Date.parse(fresh.receipt.observedAt);
      if(day(dispatchTime)!==startedDay){reason='business_day_changed';return;}
      if(dispatchAge<0||dispatchAge>PROOF_MAX_AGE_MS){reason='proof_expired';return;}
      if(codeMetadata.validUntilMs-dispatchTime.getTime()<MIN_CODE_REMAINING_MS||
        codeMetadata.validUntilMs-dispatchTime.getTime()>30_000){reason='totp_expired';return;}
      const entry={origin:ORIGIN,accountKey:'site-default',profileBinding:state.binding.profileBinding,
        businessDate:startedDay,state:'pending',attemptedAt:dispatchTime.toISOString()};
      journal.attempts.push(entry);
      try{writeRecoveryState(state.root,journal);}catch{reason='recovery_state_unavailable';return;}
      // Persist before dispatch. A crash or ambiguous response cannot cause a
      // second authentication POST from another task or another process today.
      attempted=true;reason='authentication_unknown';
      try{
        const authentication=await context.request.post(AUTH,{multipart:{two_step_code:code},
          headers:{'X-Requested-With':'XMLHttpRequest',Origin:ORIGIN,Referer:HOME},
          maxRedirects:0,maxRetries:0,ignoreHTTPSErrors:false,timeout:15_000});
        const status=authentication.status();
        if(authentication.url()!==AUTH||status>=300&&status<400)reason='authentication_redirected';
        else if(status!==200)reason='authentication_http_error';
        else{
          let body;try{body=await authentication.json();}catch{reason='authentication_response_invalid';}
          if(body!==undefined){
            if(!body||typeof body!=='object'||Array.isArray(body))reason='authentication_response_invalid';
            else if(body.ret===0&&body.msg==='ok'){accepted=true;reason='authentication_accepted';}
            else reason='authentication_rejected';
          }
        }
      }catch{reason='authentication_unknown';}
      entry.state=accepted?'accepted':reason==='authentication_rejected'?'rejected':'unknown';
      entry.finishedAt=dateClock().toISOString();entry.reason=reason;
      // Failure to finalize leaves the durable pending guard in place.
      try{writeRecoveryState(state.root,journal);}catch{}
    };
    const consume=(code,codeMetadata)=>{
      if(!accepting||callbackUsed)return Promise.resolve();
      callbackUsed=true;pending=submit(code,codeMetadata);return pending;
    };
    let providerResult;
    try{providerResult=await withTotp({root:state.root,origin:ORIGIN,binding:state.binding,config:state.config,consume,clock});}
    catch{ /* Raw vault errors and provider return values never escape. */ }
    finally{accepting=false;}
    if(pending)await pending;
    if(!attempted&&reason==='totp_unavailable')reason=providerFailure(providerResult);
    if(!accepted)return metadata(reason,attempted,accepted);
    if(day(dateClock())!==startedDay)return metadata('business_day_changed',attempted,accepted);
    const after=await passive();
    if(!after.receipt||after.accountId!==before.accountId||!await bind())
      return metadata('authentication_accepted_readback_unavailable',attempted,accepted);
    return {...metadata('authentication_accepted',attempted,accepted),readbackReceipt:after.receipt};
  }catch{return metadata(accepted?'authentication_accepted_readback_unavailable':attempted?'authentication_unknown':'recovery_unavailable',attempted,accepted);}
  finally{
    if(closeContext)try{await closeContext();}catch{}
    if(lock)try{await release(lock);}catch{}
    for(const [key,value] of savedEnvironment)process.env[key]=value;
  }
}

export function piggoPasswordFormReviewed(form){
  return form?.sameOrigin===true&&form.actionPath==='/takelogin.php'&&form.method==='POST'&&form.sameWindow===true&&
    form.basePresent===false&&form.fieldsReviewed===true&&form.usernameFilled===true&&form.passwordFilled===true&&
    form.otpEmpty===true&&form.logoutChecked===false&&/^[a-f0-9]{64}$/.test(form.usernameHash??'');
}

export function piggoPasswordLoginEnabled(config,origin=ORIGIN){
  const opt=config?.nativePtTwoFactorRecovery?.[origin];
  return origin===ORIGIN&&opt?.enabled===true&&opt.reviewed===true&&opt.provider==='bitwarden'&&opt.allowPasswordLogin===true;
}

export async function guardPiggoPasswordAutofill(page,origin=ORIGIN){
  if(![ORIGIN,'https://www.uhddolby.com'].includes(origin))throw Error('Password autofill origin rejected');
  await page.route('**/*',async route=>{
    const request=route.request();let target;try{target=new URL(request.url());}catch{return route.abort('blockedbyclient');}
    if(target.origin===origin&&(!['GET','HEAD'].includes(request.method())||
      ['/takelogin.php','/attendance.php'].includes(target.pathname)))return route.abort('blockedbyclient');
    return route.continue();
  });
}

export async function inspectPiggoPasswordForm(page){
  if(page.url()!==ORIGIN+'/login.php')return null;
  try{return await page.evaluate(async origin=>{
    const visible=element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&rect.width>0&&rect.height>0;};
    const forms=[...document.forms].filter(form=>form.querySelector('input[name="username"]')&&form.querySelector('input[type="password"]'));
    if(forms.length!==1)return null;
    const form=forms[0],field=name=>{const fields=[...form.querySelectorAll('input')].filter(input=>input.name===name);return fields.length===1?fields[0]:null;};
    const username=field('username'),password=field('password'),otp=field('two_step_code'),secret=field('secret'),logout=field('logout');
    if(!username||!password||!otp||!secret||username.type!=='text'||password.type!=='password'||otp.type!=='text'||secret.type!=='hidden'||
      ![username,password,otp].every(element=>visible(element)&&!element.disabled&&!element.readOnly))return null;
    let target;try{target=new URL(form.action,location.href);}catch{return null;}
    const fieldsReviewed=[...form.elements].every(element=>['username','password','two_step_code','secret','logout'].includes(element.name)||
      ['button','submit','reset'].includes(element.type));
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(username.value.normalize('NFKC').trim().toLowerCase()));
    return {sameOrigin:target.origin===origin&&!target.username&&!target.password&&!target.search&&!target.hash,actionPath:target.pathname,
      method:form.method.toUpperCase(),sameWindow:!form.target||form.target==='_self',basePresent:!!document.querySelector('base[href]'),fieldsReviewed,
      usernameFilled:!!username.value,passwordFilled:!!password.value,otpEmpty:!otp.value,logoutChecked:logout?.checked===true,
      usernameHash:[...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('')};
  },ORIGIN);}catch{return null;}
}

export async function recoverPiggoPasswordLogin({root,origin,page,profile,profileProof,submit,clock=()=>new Date(),
  gate=runNativePtGate,inspectForm=inspectPiggoPasswordForm,prepare,withTotp,
  readHeader=readNativePtApiHeaderInContext,acquire=acquireRunLock,release=releaseRunLock}={}){
  if(origin!==ORIGIN)return {handled:false};
  let state,lock,attempted=false,accepted=false,reason='recovery_unavailable',route,otp;
  const outcome=authenticated=>({handled:true,status:authenticated?'logged_in':'needs_attention',
    ...(!authenticated?{failureCode:'two_factor_required'}:{}),nativeTwoFactorRecovery:{phase:'password_login',attempted,accepted,reason}});
  try{
    const config=read(path.join(root,'config/config.json'));
    if(!piggoPasswordLoginEnabled(config,origin))return {handled:false};
    const binding=nativePtReadBinding(config,{origin:ORIGIN,accountKey:'site-default'},{root,isolated:true});
    state=settings(root,origin,binding.profileBinding);
    if(!state||canonical(profile??'')!==canonical(binding.profile)||typeof profileProof!=='function'||typeof submit!=='function'){
      reason='configuration_invalid';return outcome(false);
    }
    await validateControllerLease(root);
    const runner=read(path.join(root,'tmp/run.lock'));
    if(!Number.isSafeInteger(runner.pid)||runner.pid<=0||typeof runner.nonce!=='string')throw Error('runner');
    process.kill(runner.pid,0);
    lock=await acquire(path.join(root,'tmp/piggo-password-login.lock'));
    const dateClock=()=>nowDate(clock),startedDay=day(dateClock());
    const bind=async()=>{
      const value=await gate({root,origin:ORIGIN,url:HOME,profile:binding.profile,mainProfile:false,phase:'bind',clock:dateClock});
      return value?.managed===true&&value.allow===true&&value.accountKey==='site-default'&&value.profileBinding===binding.profileBinding&&
        sameConfiguration(state)&&day(dateClock())===startedDay&&await profileProof();
    };
    if(!await bind()){reason='scope_unavailable';return outcome(false);}
    const form=await inspectForm(page);
    if(!piggoPasswordFormReviewed(form)){reason='login_form_unreviewed';return outcome(false);}
    const verify=()=>readHeader({root,origin:ORIGIN,context:piggoNativePassiveContext(page),expectedProfileBinding:binding.profileBinding,profileProof,clock:dateClock,gate});
    const register=async value=>{
      const receipt=receiptFor(value,state,dateClock());
      if(!receipt)return false;
      const saved=await gate({root,origin:ORIGIN,url:HOME,profile:binding.profile,mainProfile:false,phase:'readback',receipt,clock:dateClock});
      return saved?.allow===true&&saved.receiptAccepted===true;
    };
    const before=await verify();
    if(await register(before)){reason='already_authenticated';return outcome(true);}
    let journal=readRecoveryState(root);
    if(attemptedToday(journal,binding,startedDay,'password_login')){reason='daily_recovery_limit';return outcome(false);}
    if(!prepare||!withTotp){
      const provider=await import('./bitwarden-totp.mjs');
      prepare??=provider.prepareBitwardenTotp;withTotp??=provider.withBitwardenTotp;
    }
    const ready=await prepare({root,origin:ORIGIN,binding,config:state.config});
    if(ready?.ready!==true){reason=providerFailure(ready);return outcome(false);}
    const renewed=await inspectForm(page);
    if(!piggoPasswordFormReviewed(renewed)||renewed.usernameHash!==form.usernameHash||!await bind()){
      reason='login_form_changed';return outcome(false);
    }
    let callbackUsed=false,accepting=true,pending,provided;
    const consumeCode=async(code,metadata)=>{
      const latest=await inspectForm(page);
      if(!piggoPasswordFormReviewed(latest)||latest.usernameHash!==form.usernameHash||!await bind()){
        reason='login_form_changed';return;
      }
      await validateControllerLease(root);
      const at=dateClock();
      if(!/^\d{6}$/.test(code)||!Number.isFinite(metadata?.validUntilMs)||metadata.validUntilMs-at.getTime()<MIN_CODE_REMAINING_MS||
        metadata.validUntilMs-at.getTime()>30_000){reason='totp_expired';return;}
      journal=readRecoveryState(root);
      if(attemptedToday(journal,binding,startedDay,'password_login')){reason='daily_recovery_limit';return;}
      let posts=0;
      route=async requestRoute=>{
        const request=requestRoute.request();let target;try{target=new URL(request.url());}catch{return requestRoute.abort();}
        if(!['GET','HEAD'].includes(request.method())){
          if(!attempted||request.method()!=='POST'||target.href!==ORIGIN+'/takelogin.php'||posts>=1)return requestRoute.abort('blockedbyclient');
          posts++;return requestRoute.continue();
        }
        if(target.origin===ORIGIN&&['/attendance.php','/takelogin.php'].includes(target.pathname))return requestRoute.abort('blockedbyclient');
        return requestRoute.continue();
      };
      await page.route('**/*',route);
      const entry={origin:ORIGIN,accountKey:'site-default',profileBinding:binding.profileBinding,businessDate:startedDay,
        phase:'password_login',state:'pending',attemptedAt:dateClock().toISOString()};
      journal.attempts.push(entry);writeRecoveryState(root,journal);attempted=true;reason='authentication_unknown';
      try{
        // Filling an OTP can itself trigger a site's input listener. Persist
        // first and let the firewall admit at most one authentication POST.
        const responseWait=typeof page.waitForResponse==='function'?page.waitForResponse(response=>
          response.url()===ORIGIN+'/takelogin.php'&&response.request().method()==='POST',{timeout:20000}).catch(()=>null):null;
        otp=page.locator('input[name="two_step_code"]');await otp.fill(code);
        if(!await bind()||metadata.validUntilMs-dateClock().getTime()<MIN_CODE_REMAINING_MS)throw Error('expired authentication scope');
        if(posts===0)await submit();
        if(responseWait)await responseWait;
        await page.waitForLoadState('domcontentloaded',{timeout:20000}).catch(()=>{});
        for(let read=0;read<3;read++){
          const verified=await verify();
          if(posts===1&&await register(verified)){accepted=true;reason='authentication_accepted';break;}
          if(read<2&&typeof page.waitForTimeout==='function')await page.waitForTimeout(350);
        }
      }catch{/* Preserve one unknown authentication; never publish raw form or provider errors. */}
      entry.state=accepted?'accepted':'unknown';entry.finishedAt=dateClock().toISOString();
      try{writeRecoveryState(root,journal);}catch{}
    };
    try{provided=await withTotp({root,origin:ORIGIN,binding,config:state.config,clock:()=>dateClock().getTime(),consume:(code,metadata)=>{
      if(!accepting||callbackUsed)return Promise.resolve();
      callbackUsed=true;pending=consumeCode(code,metadata);return pending;
    }});}catch{/* Provider errors cannot replace the outcome of an already dispatched authentication. */}
    finally{accepting=false;}
    if(pending)await pending;
    if(!attempted&&reason==='recovery_unavailable')reason=providerFailure(provided);
    return outcome(accepted);
  }catch{return outcome(false);}
  finally{
    if(route&&!attempted)try{await page.unroute('**/*',route);}catch{}
    if(otp&&page.url()===ORIGIN+'/login.php')try{
      if(typeof otp.evaluate==='function')await otp.evaluate(element=>{element.value='';});else await otp.fill('');
    }catch{}
    if(lock)try{await release(lock);}catch{}
  }
}
