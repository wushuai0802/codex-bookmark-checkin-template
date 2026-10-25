import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {prepareBitwardenTotp,withBitwardenTotp} from './bitwarden-totp.mjs';
import {validateSiteTwoFactorScope} from './two-factor-scope.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {readHddolbyHeader,hddolbyDailyStatusProof} from './hddolby-readonly.mjs';
import {nativeProviderFailure} from './pt-native-diagnostic.mjs';

const origin='https://www.hddolby.com',adapterId='hddolby-nexus-stepup-v1';
const origins=new Set([origin,'https://www.uhddolby.com']);
const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const result=(reason,attempted=false,accepted=false)=>({twoFactorRecovery:{reason,attempted,accepted}});
const authenticationPath='/take2fa.php';

export function hddolbyTwoFactorFormReviewed(form){
  const fields=form?.fields;
  return form?.sameOrigin===true&&form.path===authenticationPath&&form.method==='POST'&&
    form.sameWindow===true&&
    ['/attendance.php','/index.php'].includes(form.returntoPath)&&form.returntoUnsafe===false&&
    form.passwordPresent===false&&form.visible===true&&Array.isArray(fields)&&
    fields.filter(f=>f.name==='2fa'&&f.type==='text'&&f.visible===true&&f.enabled===true).length===1&&
    fields.filter(f=>f.name==='type'&&f.type==='hidden').length===1&&
    fields.filter(f=>f.name==='returnto'&&f.type==='hidden').length===1&&
    fields.every(f=>['2fa','type','returnto',''].includes(f.name))&&
    fields.filter(f=>f.type==='submit'&&f.visible===true&&f.enabled===true).length===1;
}

export async function inspectHddolbyTwoFactorForm(page){
  const origin=new URL(page.url()).origin;
  if(!origins.has(origin))return null;
  const forms=await page.locator('form').evaluateAll((forms,expected)=>forms.map(form=>{
    const visible=e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
    // Nexus table markup can place controls outside the form's DOM subtree.
    // The browser's form owner, rather than ancestry, determines submission.
    const controls=[...form.elements].filter(e=>e.tagName==='INPUT'||e.tagName==='BUTTON'||e.tagName==='SELECT');
    let sameOrigin=false,path='',returntoPath='',returntoUnsafe=true;
    try{const action=new URL(form.action||location.href);sameOrigin=action.origin===expected&&!action.username&&!action.password&&!document.querySelector('base[href]');
      path=action.pathname;if(action.search||action.hash)sameOrigin=false;}catch{}
    try{const returns=controls.filter(e=>e.name==='returnto'),raw=returns.length===1?returns[0].value:null;
      const target=new URL(raw||'',expected);returntoPath=target.pathname;
      returntoUnsafe=!raw||target.origin!==expected||!!target.username||!!target.password||!!target.search||!!target.hash;}catch{}
    return {sameOrigin,path,method:form.method.toUpperCase(),returntoPath,returntoUnsafe,
      visible:controls.some(e=>e.type!=='hidden'&&visible(e)),sameWindow:!form.target||form.target==='_self',passwordPresent:controls.some(e=>e.type==='password'),
      fields:controls
        .map(e=>({name:e.name,type:e.type,visible:visible(e),enabled:!e.disabled}))};
  }),origin);
  return forms.length===1&&hddolbyTwoFactorFormReviewed(forms[0])?forms[0]:null;
}

// Use the existing Chrome network/session. APIRequestContext does not inherit
// Windows' system proxy, so the passive reader uses tightly bounded browser
// GETs instead of copying cookies to another client or disabling TLS checks.
export function hddolbyPassiveContext(page){
  const origin=new URL(page.url()).origin;
  if(!origins.has(origin))throw Error('Passive origin rejected');
  return {newPage:()=>page.context().newPage(),request:{get:async(url)=>{
    const target=new URL(url),current=new URL(page.url());
    if(current.origin!==origin||target.origin!==origin||target.search||target.hash||
      !['/index.php','/log.php'].includes(target.pathname))throw Error('Passive origin rejected');
    const value=await page.evaluate(async target=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
      try{
        const response=await fetch(target,{method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal});
        const body=await response.text();
        if(body.length>2_000_000)throw Error('Passive body too large');
        return {url:response.url,status:response.status,date:response.headers.get('date'),body};
      }finally{clearTimeout(timer);}
    },target.href);
    if(value.url!==target.href)throw Error('Passive redirect rejected');
    return {url:()=>value.url,status:()=>value.status,headers:()=>({date:value.date}),text:async()=>value.body};
  }}};
}

function readJournal(file){
  if(!fs.existsSync(file))return {schemaVersion:1,attempts:[]};
  if(fs.statSync(file).size>1_048_576)throw Error('State rejected');
  const journal=JSON.parse(fs.readFileSync(file,'utf8'));
  if(journal?.schemaVersion!==1||!Array.isArray(journal.attempts)||journal.attempts.length>4096||
    journal.attempts.some(a=>!origins.has(a?.origin)||a.accountKey!=='site-default'||
      !/^[a-f0-9]{64}$/.test(a.profileBinding??'')||!['pending','accepted','rejected','unknown'].includes(a.state)||
      !Number.isFinite(Date.parse(a.attemptedAt))||day(a.attemptedAt)!==a.businessDate))throw Error('State rejected');
  return {schemaVersion:1,attempts:journal.attempts.map(a=>({origin:a.origin,accountKey:'site-default',profileBinding:a.profileBinding,
    businessDate:a.businessDate,state:a.state,attemptedAt:a.attemptedAt,
    ...(Number.isFinite(Date.parse(a.finishedAt))?{finishedAt:a.finishedAt}:{})}))};
}
function writeJournal(file,journal){
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(temp,JSON.stringify(journal),{mode:0o600});fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

export async function recoverHddolbyTwoFactor({page,root,config={},clock=Date.now,
  validate=validateSiteTwoFactorScope,inspect=inspectHddolbyTwoFactorForm,read=readHddolbyHeader,
  prepare=prepareBitwardenTotp,withTotp=withBitwardenTotp,
  acquire=acquireRunLock,release=releaseRunLock,passive=hddolbyPassiveContext}={}){
  let origin;
  try{origin=new URL(page.url()).origin;}catch{return result('challenge_invalid');}
  if(!origins.has(origin))return result('challenge_invalid');
  const optIn=config.siteTwoFactorRecovery?.[origin];
  if(optIn?.enabled!==true||optIn.reviewed!==true||optIn.provider!=='bitwarden'||optIn.adapterId!==adapterId)
    return result('disabled');
  if(!/^\d{1,20}$/.test(String(optIn.expectedAccountId??'')))return result('configuration_invalid');
  let scope,authLock,attempted=false,accepted=false,input,authRoute,authPosts=0,acceptingAuth=false;
  const now=()=>new Date(clock());
  try{
    const current=new URL(page.url());
    if(current.origin!==origin||current.pathname!==authenticationPath||current.username||current.password)
      return result('challenge_invalid');
    scope=await validate({root,origin,config,profile:config.automationUserDataDir,clock,adapterId});
    if(!scope)return result('scope_unavailable');
    const startedDay=day(now()),file=path.join(root,'data/bitwarden/hddolby-authentication.json');
    authLock=await acquire(file+'.lock');
    const readStatus=()=>read(passive(page),{origin,now:now(),expectedAccountId:optIn.expectedAccountId});
    let before=await readStatus();
    if(!hddolbyDailyStatusProof(before,now()))return result('passive_proof_unavailable');
    if(before.status==='already_signed')return {...result('already_signed'),readback:before};
    let journal=readJournal(file);
    const alreadyTried=()=>journal.attempts.some(a=>a.origin===origin&&a.profileBinding===scope.binding.profileBinding&&a.businessDate===startedDay);
    if(alreadyTried())return result('daily_recovery_limit');
    const form=await inspect(page);
    if(!hddolbyTwoFactorFormReviewed(form))return result('protocol_unverified');
    if(!await scope.assertCurrent()||day(now())!==startedDay)return result('scope_unavailable');
    const providerArgs={root,origin,binding:scope.binding,config};
    const prepared=await prepare(providerArgs);
    if(prepared?.ready!==true)return result(nativeProviderFailure(prepared));
    before=await readStatus();
    if(!hddolbyDailyStatusProof(before,now()))return result('passive_proof_unavailable');
    if(before.status==='already_signed')return {...result('already_signed'),readback:before};
    let reason='totp_unavailable',used=false,active=true,pending;
    const consume=async(code,metadata)=>{
      if(typeof code!=='string'||!/^\d{6}$/.test(code)||!Number.isFinite(metadata?.validUntilMs)||
        metadata.validUntilMs-now().getTime()<3000||metadata.validUntilMs-now().getTime()>30_000)return;
      const fresh=await readStatus();
      if(!hddolbyDailyStatusProof(fresh,now())||fresh.status!=='not_signed'){reason='passive_proof_unavailable';return;}
      const freshForm=await inspect(page);
      if(!hddolbyTwoFactorFormReviewed(freshForm)||freshForm.returntoPath!==form.returntoPath){reason='protocol_unverified';return;}
      if(!await scope.assertCurrent()||day(now())!==startedDay){reason='scope_unavailable';return;}
      journal=readJournal(file);if(alreadyTried()){reason='daily_recovery_limit';return;}
      if(metadata.validUntilMs-now().getTime()<3000){reason='totp_expired';return;}
      input=page.locator('input[name="2fa"]:visible');
      const submit=page.locator('input[type="submit"]:visible, button[type="submit"]:visible');
      if(await input.count()!==1||await submit.count()!==1){reason='protocol_unverified';return;}
      const owned=locator=>locator.evaluate((element,expected)=>{
        const form=document.forms.length===1?document.forms[0]:null;
        return !!form&&element.form===form&&form.method.toUpperCase()==='POST'&&form.action===expected+'/take2fa.php'&&
          (!form.target||form.target==='_self')&&!document.querySelector('base[href]');
      },origin);
      if(!await owned(input)||!await owned(submit)){reason='protocol_unverified';return;}
      if(metadata.validUntilMs-now().getTime()<3000||day(now())!==startedDay||!await scope.assertCurrent()){reason='totp_expired';return;}
      journal=readJournal(file);if(alreadyTried()){reason='daily_recovery_limit';return;}
      const entry={origin,accountKey:'site-default',profileBinding:scope.binding.profileBinding,businessDate:startedDay,
        state:'pending',attemptedAt:now().toISOString()};
      journal.attempts.push(entry);writeJournal(file,journal);
      // Persist before filling: a page handler may submit on input. Fence the
      // exact same-origin authentication POST to one dispatch in either case.
      attempted=true;reason='authentication_unknown';acceptingAuth=true;
      authRoute=async route=>{
        const request=route.request();let url;try{url=new URL(request.url());}catch{return route.abort('blockedbyclient');}
        if(!['GET','HEAD'].includes(request.method())){
          if(!acceptingAuth||request.method()!=='POST'||url.href!==origin+authenticationPath||authPosts>=1)return route.abort('blockedbyclient');
          authPosts++;return route.fallback();
        }
        if(url.origin===origin&&url.pathname==='/attendance.php'&&authPosts===0)return route.abort('blockedbyclient');
        return route.fallback();
      };
      await page.route('**/*',authRoute);
      const responsePromise=page.waitForResponse(response=>{
        try{const url=new URL(response.url());return response.request().method()==='POST'&&url.origin===origin&&
          url.pathname===authenticationPath&&!url.search&&!url.hash;}catch{return false;}
      },{timeout:20_000}).catch(()=>null);
      let filled=false;
      try{await input.fill(code);filled=true;}catch{/* An input-triggered navigation may detach the field; await its response below. */}
      if(filled&&authPosts===0){
        try{
          const currentForm=await inspect(page);
          if(authPosts===0){
            const validForm=hddolbyTwoFactorFormReviewed(currentForm)&&currentForm.returntoPath===form.returntoPath&&
              await owned(input)&&await owned(submit);
            if(authPosts===0&&!validForm)reason='protocol_unverified';
            else if(authPosts===0){
              const current=metadata.validUntilMs-now().getTime()>=3000&&day(now())===startedDay&&await scope.assertCurrent();
              if(authPosts===0&&!current)reason='totp_expired';
              else if(authPosts===0)await submit.click({timeout:15_000}).catch(()=>{});
            }
          }
        }catch{/* A form disappearing after the input event does not lose a possible authentication response. */}
      }
      const response=await responsePromise;
      if(response){
        if(response.status()>=300&&response.status()<400){
          const headers=await response.allHeaders(),location=headers.location;
          let target;try{target=new URL(location??'',origin);}catch{}
          accepted=!!location&&target?.origin===origin&&!target.username&&!target.password&&!target.search&&!target.hash&&
            target.pathname===form.returntoPath;
          if(accepted)reason='authentication_accepted';
        }else if(response.status()===200){
          const body=await response.text().catch(()=> '');
          if(/(?:验证|驗證|认证|認證|code).{0,25}(?:错误|錯誤|失败|失敗|无效|無效|invalid|incorrect)|invalid.{0,20}(?:code|2fa)/i.test(body))
            reason='authentication_rejected';
        }
      }
      entry.state=accepted?'accepted':reason==='authentication_rejected'?'rejected':'unknown';
      entry.finishedAt=now().toISOString();writeJournal(file,journal);
      await page.waitForLoadState('domcontentloaded',{timeout:15_000}).catch(()=>{});
    };
    try{const supplied=await withTotp({...providerArgs,clock,consume:(code,metadata)=>{
      if(!active||used)return Promise.resolve();used=true;pending=consume(code,metadata);return pending;
    }});if(!used&&supplied?.ready!==true)reason=nativeProviderFailure(supplied);}
    finally{active=false;if(pending)await pending;}
    if(!accepted)return result(reason,attempted,accepted);
    if(day(now())!==startedDay||!await scope.assertCurrent())return result('business_day_changed',attempted,accepted);
    const after=await readStatus();
    if(!hddolbyDailyStatusProof(after,now()))return result('authentication_accepted_readback_unavailable',attempted,accepted);
    return {...result('authentication_accepted',attempted,accepted),readback:after};
  }catch{return result(accepted?'authentication_accepted_readback_unavailable':attempted?'authentication_unknown':'recovery_unavailable',attempted,accepted);}
  finally{
    acceptingAuth=false;
    if(input)await input.fill('',{timeout:1000}).catch(()=>{});
    if(authRoute)await page.unroute('**/*',authRoute).catch(()=>{});
    if(authLock)await release(authLock).catch(()=>{});
    if(scope)await scope.release().catch(()=>{});
  }
}
