import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {launchAutomationContext} from './browser.mjs';
import {nativePtReadBinding} from './native-pt-read.mjs';
import {ptReadPolicy,nativeApiHeaderAuthenticated,classifyPtPassivePage} from './pt-read-policy.mjs';
import {accountMetadataForOrigin} from './result-identity.mjs';
import {runNativePtGate} from './native-pt-gate.mjs';
import {acquireRunLock,releaseRunLock} from './run-lock.mjs';
import {classifyPageText} from './detector.mjs';

const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
const controlText=value=>String(value??'').replace(/^[\[【]|[\]】]$/g,'').trim();
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const successful=value=>['signed','already_signed'].includes(value?.status);
const unknown=identity=>({status:'needs_attention',failureCode:'submission_outcome_unknown',nativeGate:true,
  submissionAttempted:true,retryable:false,operationMode:'legacy_checkin',readSafety:'attendance_page_risk',attendanceRisk:true,
  ...identity,reason:'原生 GET 签到可能已提交，保留意图并先只读核验，禁止自动重放'});
const emptyInspection=()=>({currentUrl:'',sameOrigin:false,pageContentAvailable:false,siteBodyLoaded:false,
  authenticated:false,waf:false,loginRoute:false,securityVerification:false,signedControlCount:0,unsignedControlCount:0,
  successControl:'',unsignedControl:'',success:false,successText:false,audiencesDailyHeaderVerified:false});
const unavailable=(identity={},code='authoritative_status_unavailable',inspection=emptyInspection())=>({status:'unconfirmed',failureCode:code,
  nativeGate:true,submissionAttempted:false,...identity,reason:'原生 API 只读回执未满足已审阅的当日账号证据',
  inspection,
  nativeReadback:{stage:'readback',code:'authoritative_evidence_rejected',exitCode:null,durationMs:0,stderrPresent:false,stderrBytes:0}});

function settings(root,origin,{execution=false,url}={}){
  root=path.resolve(root);
  const site=new URL(origin);
  if(site.protocol!=='https:'||site.origin!==origin||site.username||site.password)throw Error('Native API origin rejected');
  if(execution&&origin!=='https://piggo.me')throw Error('Native API execution origin rejected');
  const config=read(path.join(root,'config/config.json')),privatePolicy=config.ptReadOnlyPolicies?.[origin];
  if(privatePolicy?.reviewed!==true||privatePolicy.nativeApiHeaderFallback!==true||
    execution&&privatePolicy.nativeApiExecution!==true)throw Error('Native API private opt-in missing');
  const policy=ptReadPolicy(origin,config);
  if(policy.nativeIsolatedChrome!==true||policy.dailyHeader!==true||policy.mode!=='safe_history_page'||
    policy.url!==origin+'/index.php'||policy.selector!=='#info_block'||policy.actionPath!=='/attendance.php')
    throw Error('Native API policy rejected');
  const target={origin,...accountMetadataForOrigin(origin,config)};
  target.accountKey??='site-default';
  if((config.supplementalOAuthAccounts??[]).some(value=>value.origin===origin))throw Error('Native API account ambiguous');
  const binding=nativePtReadBinding(config,target,{root,isolated:true});
  if(execution){
    const destination=new URL(url);
    const entries=[...(config.nativeWafPreflightUrls??[]),...(config.nativeChallengePreflight??[])]
      .map(value=>typeof value==='string'?{url:value}:value);
    if(destination.href!==origin+'/attendance.php'||destination.username||destination.password||
      !entries.some(value=>value.url===url))throw Error('Native API GET destination unregistered');
  }
  return {root,origin,config,policy,binding,
    identity:{origin,accountKey:binding.accountKey,profileBinding:binding.profileBinding}};
}

async function validateControllerLease(root){
  const integration=read(path.join(root,'data/v2-integration.json'));
  if(integration.executionEngine!=='v1'||!path.isAbsolute(integration.v2ProjectRoot??''))throw Error('Native API controller lease unavailable');
  const {validateEngineLease}=await import(pathToFileURL(path.join(integration.v2ProjectRoot,'src/legacy-engine.mjs')).href);
  validateEngineLease({root:integration.v2ProjectRoot,legacyRoot:root});
}

function responseFresh(response,url,now){
  if(response.url()!==url)return false;
  const headers=response.headers(),value=Object.entries(headers).find(([key])=>key.toLowerCase()==='date')?.[1];
  const at=Date.parse(value??'');
  return Number.isFinite(at)&&day(at)===day(now)&&at<=now.getTime()+60_000&&now.getTime()-at<=5*60_000;
}

async function parsePage(context,html,url,policy){
  if(Buffer.byteLength(html,'utf8')>2_000_000)throw Error('Native API page size rejected');
  let parser;
  try{
    parser=await context.newPage();
    await parser.route('**/*',route=>route.abort('blockedbyclient'));
    await parser.setContent('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;none&#39;; form-action &#39;none&#39;; base-uri &#39;none&#39;">',
      {waitUntil:'domcontentloaded'});
    // The fetched document is parsed off-page. Scripts never enter a live DOM.
    return await parser.evaluate(({html,url,selector,actionPath})=>{
      const dom=new DOMParser().parseFromString(html,'text/html');
      dom.querySelectorAll('script,style,noscript,template,iframe,object,embed').forEach(element=>element.remove());
      const bases=[...dom.querySelectorAll('base[href]')];
      let linkBase=url,baseValid=bases.length<=1;
      if(bases.length===1){
        try{
          const base=new URL(bases[0].getAttribute('href')??'',url);
          baseValid=base.protocol==='https:'&&base.origin===new URL(url).origin&&!base.username&&!base.password&&!base.search&&!base.hash;
          linkBase=base.href;
        }catch{baseValid=false;}
      }
      const headers=[...dom.querySelectorAll(selector)];
      const header=headers.length===1?headers[0]:null;
      const headerText=header?String(header.textContent??'').slice(0,12000):'';
      let authHeaderSemanticText;
      if(new URL(url).origin==='https://audiences.me'&&header&&baseValid){
        // Audiences renders account statistics as icon accessibility labels.
        // Keep their bounded semantics inside the unique account header;
        // tooltips never supply a daily completion signal or affect PigGo.
        const attributes=[header,...header.querySelectorAll('[alt],[title],[aria-label]')].slice(0,400)
          .flatMap(element=>['alt','title','aria-label'].map(name=>String(element.getAttribute(name)??'').slice(0,512))).join(' ');
        const stats=[[/爆米花/,'爆米花'],[/\bH&R\b/,'H&R'],[/上传|上傳|Uploaded/i,'Uploaded'],
          [/下载|下載|Downloaded/i,'Downloaded'],[/分享率|比率|Ratio/i,'Ratio']]
          .filter(([pattern])=>pattern.test(attributes)).map(([,label])=>label);
        authHeaderSemanticText=[headerText,...stats].join(' ');
      }
      const controls=header&&baseValid?[...header.querySelectorAll('a,button,[role="button"]')].flatMap(element=>{
        const text=String(element.textContent??'').trim();
        const tag=String(element.tagName??'').toLowerCase();
        const href=element.getAttribute('href');
        if(!href)return element.matches('button,[role="button"]')?[{text,path:actionPath}]:[];
        try{
          const link=new URL(href,linkBase);
          if(link.origin!==new URL(url).origin||link.username||link.password||link.hash)return [];
          if(link.pathname==='/userdetails.php'){
            const id=link.searchParams.get('id');
            if(new URL(url).origin==='https://audiences.me'&&
              (tag!=='a'||link.searchParams.size!==1||!link.searchParams.has('id')||!/^[1-9][0-9]{0,19}$/.test(id??'')))
              return [{path:link.pathname,tag,invalidIdentity:true}];
            if([...link.searchParams.keys()].some(key=>key!=='id')||!/^\d{1,20}$/.test(id??''))return [];
            return [{text,path:link.pathname,accountId:id,tag}];
          }
          // The account panel uses action=... tabs. This is an authentication
          // fact only; its query is never followed, exported or submitted.
          if(link.pathname==='/usercp.php')return [{text,path:link.pathname}];
          if(link.search)return [];
          return [{text,path:link.pathname,tag}];
        }catch{return [];}
      }):[];
      const hasOtpInput=[...dom.querySelectorAll('input')].some(input=>{
        const type=String(input.getAttribute('type')??'text').toLowerCase();
        if(type==='hidden'||input.getAttribute('hidden')!==null||input.getAttribute('disabled')!==null||input.getAttribute('readonly')!==null)return false;
        // Only inspect the control's labels. Never read its value or token.
        const labels=['name','id','autocomplete','aria-label','placeholder','title']
          .map(attribute=>input.getAttribute(attribute)??'').join(' ');
        return /(?:^|[^a-z])(?:otp|totp|2fa|two[_-]?factor|two[_-]?step|verification[_-]?code|security[_-]?code)(?:$|[^a-z])|one-time-code|(?:二级|二級|两步|兩步|二步|动态|動態|一次性).{0,10}(?:验证码|驗證碼|代码|代碼)/i.test(labels);
      });
      const hasOtpForm=[...dom.querySelectorAll('form[action]')].some(form=>{
        try{
          const action=new URL(form.getAttribute('action')??'',linkBase);
          return action.origin===new URL(url).origin&&!action.username&&!action.password&&
            /^\/(?:take2fa|verify2fa|2fa|otp|totp|two[_-]?factor)(?:\.php)?\/?$/i.test(action.pathname);
        }catch{return false;}
      });
      const hasVerificationHeading=[...dom.querySelectorAll('h1,h2,h3,legend')].some(heading=>
        /^(?:异地登录安全验证|異地登錄安全驗證|二级验证|二級驗證|两步验证|兩步驗證|2FA verification|Two-factor authentication)$/i
          .test(String(heading.textContent??'').trim()));
      return {headerCount:headers.length,baseValid,hasPassword:[...dom.querySelectorAll('input[type="password"]')].length>0,
        hasOtpInput,hasOtpForm,hasVerificationHeading,
        headerText,...(authHeaderSemanticText===undefined?{}:{authHeaderSemanticText}),controls,
        bodyText:String(dom.body?.textContent??'').slice(0,50000)};
    },{html,url,selector:policy.selector,actionPath:policy.actionPath});
  }finally{await parser?.close().catch(()=>{});}
}

function authenticatedSnapshot(snapshot,{origin,policy},url){
  const headerText=String(snapshot?.headerText??''),controls=Array.isArray(snapshot?.controls)?snapshot.controls:[];
  const bodyText=String(snapshot?.bodyText??'');
  const diagnostic=classifyPageText({url,bodyText,hasPassword:snapshot?.hasPassword===true});
  const security=snapshot?.hasOtpInput===true||snapshot?.hasOtpForm===true||snapshot?.hasVerificationHeading===true||
    /(?:请输入|請輸入|请填写|請填寫|需要输入|需要輸入|要求输入|要求輸入).{0,24}(?:验证码|驗證碼|验证代码|驗證代碼|(?:二级|二級|两步|兩步|二步|2FA|TOTP|OTP|动态|動態|一次性).{0,16}(?:代码|代碼|code))|(?:异地登录安全验证|異地登錄安全驗證).{0,30}(?:二级验证代码|二級驗證碼)/i.test(bodyText);
  const challenged=['managed_challenge','interactive_challenge'].includes(diagnostic.status)||
    /正在进行安全检测|当前环境正在被调试|Just a moment|Verify you are human|Cloudflare.*performance and security/i.test(String(snapshot?.bodyText??''));
  const login=snapshot?.hasPassword===true||diagnostic.status==='login_required'||/(?:请输入|請輸入).{0,16}(?:用户名|用戶名|账号|帳號).{0,16}(?:密码|密碼)/.test(bodyText);
  const self=controls.filter(value=>value.path==='/userdetails.php'&&/^\d{1,20}$/.test(value.accountId??''));
  const identities=[...new Set(self.map(value=>value.accountId))];
  const authenticated=snapshot?.headerCount===1&&snapshot.baseValid===true&&!challenged&&!login&&!security&&identities.length===1&&
    nativeApiHeaderAuthenticated({origin,policy,
      headerText:origin==='https://audiences.me'?String(snapshot?.authHeaderSemanticText??headerText):headerText,controls});
  return {authenticated,accountId:authenticated?identities[0]:null,controls,headerText,
    waf:challenged,loginRoute:login,securityVerification:security};
}

function dailyControls(controls,policy){
  const daily=controls.filter(value=>value.path===policy.actionPath).map(value=>controlText(value.text));
  const unsigned=daily.filter(text=>[policy.unsignedText,...(policy.unsignedTexts??[])].includes(text));
  const signed=daily.filter(text=>/^(?:今日|今天)?(?:已签到|已簽到|已经签到|已經簽到)$/.test(text)||
    (policy.signedTexts??[]).includes(text.replace(/\s+/g,''))||policy.signedRewardControl===true&&
    /^(?:签到已得|簽到已得)[0-9,.]+(?:,\s*补签卡:\s*\d+)?$/.test(text));
  return {unsigned,signed};
}

async function fetchPage(context,url,policy,clock){
  const response=await context.request.get(url,{timeout:15000,maxRedirects:0,maxRetries:0,ignoreHTTPSErrors:false,
    failOnStatusCode:false,headers:{'Cache-Control':'no-cache','Pragma':'no-cache'}});
  const now=clock();
  if(!responseFresh(response,url,now))return null;
  if([301,302,303,307,308].includes(response.status())){
    try{
      const next=new URL(response.headers().location,url);
      if(next.protocol==='https:'&&next.origin===new URL(url).origin&&!next.username&&!next.password&&!next.hash&&next.pathname==='/login.php')
        return {rejected:'login_required',now};
    }catch{/* An unreviewed redirect supplies no account or daily evidence. */}
    return null;
  }
  if(response.status()!==200)return null;
  const snapshot=await parsePage(context,await response.text(),url,policy);
  if(day(clock())!==day(now))return null;
  return {snapshot,now};
}

async function readInContext(context,state,clock){
  const page=await fetchPage(context,state.policy.url,state.policy,clock);
  if(!page)return {result:unavailable(state.identity),accountId:null};
  if(page.rejected==='login_required')return {result:{...unavailable(state.identity,'login_required',
    {...emptyInspection(),currentUrl:state.policy.url,sameOrigin:true,loginRoute:true}),status:'login_required'},accountId:null};
  const {snapshot}=page;let {now}=page;
  const auth=authenticatedSnapshot(snapshot,state,state.policy.url);
  const counts=dailyControls(auth.controls,state.policy);
  const audience=state.origin==='https://audiences.me';
  const daily=auth.controls.filter(value=>value.path===state.policy.actionPath);
  const audienceSignedHeader=value=>{
    const text=String(value??'');
    return [...text.matchAll(/(?:^|\s)已签到\s*\+\s*[0-9,.]+/g)].length===1&&
      !/(?:历史|歷史|昨日|昨天|上次|累计|累計).{0,24}已签到/.test(text);
  };
  let ownProfileVerified=!audience;
  if(audience&&auth.authenticated){
    const profileUrl=state.origin+'/userdetails.php?id='+auth.accountId;
    const profile=await fetchPage(context,profileUrl,state.policy,clock);
    if(profile?.snapshot&&day(profile.now)===day(now)){
      const profileAuth=authenticatedSnapshot(profile.snapshot,state,profileUrl);
      const profileCounts=dailyControls(profileAuth.controls,state.policy);
      const profileSigned=profileCounts.signed.length>0||audienceSignedHeader(profileAuth.headerText);
      const indexSigned=counts.signed.length>0||audienceSignedHeader(auth.headerText);
      ownProfileVerified=profileAuth.authenticated&&profileAuth.accountId===auth.accountId&&
        !(counts.unsigned.length>0&&profileSigned)&&!(indexSigned&&profileCounts.unsigned.length>0)&&
        !(profileCounts.signed.length>0&&profileCounts.unsigned.length>0);
      now=profile.now;
    }
  }
  const result=classifyPtPassivePage({origin:state.origin,url:state.policy.url,policy:state.policy,
    bodyText:auth.headerText,controls:auth.controls,authenticated:auth.authenticated,httpStatus:200,now});
  const audienceHeaderVerified=audience&&auth.authenticated&&ownProfileVerified&&daily.length===0&&
    counts.signed.length===0&&counts.unsigned.length===0&&audienceSignedHeader(auth.headerText);
  const uniqueAction=!audience||daily.length===1&&daily[0].tag==='a';
  const positive=ownProfileVerified&&(audienceHeaderVerified||successful(result)&&uniqueAction&&counts.signed.length===1&&counts.unsigned.length===0);
  const negative=ownProfileVerified&&uniqueAction&&result.status==='not_signed'&&counts.unsigned.length===1&&counts.signed.length===0&&
    (!audience||!audienceSignedHeader(auth.headerText));
  const inspection={currentUrl:state.policy.url,sameOrigin:true,pageContentAvailable:snapshot?.headerCount>0,
    siteBodyLoaded:snapshot?.headerCount===1,authenticated:auth.authenticated&&ownProfileVerified,waf:auth.waf,
    loginRoute:auth.loginRoute,securityVerification:auth.securityVerification,signedControlCount:counts.signed.length,
    unsignedControlCount:counts.unsigned.length,successControl:counts.signed.length===1?counts.signed[0]:'',
    unsignedControl:counts.unsigned.length===1?counts.unsigned[0]:'',success:positive,successText:false,audiencesDailyHeaderVerified:audienceHeaderVerified};
  if(!auth.authenticated||(!positive&&!negative)||!audienceHeaderVerified&&result.evidence?.authoritative!==true)
    return {result:unavailable(state.identity,'authoritative_status_unavailable',inspection),accountId:null};
  const evidence={source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:day(now),
    pagePath:'/index.php',statusSignal:negative?'nexus_daily_header_unsigned':'nexus_daily_header_signed',evidenceScope:'site_account_day'};
  const metadata={origin:state.origin,url:state.policy.url,...state.identity,status:negative?'not_signed':'already_signed',
    businessDate:day(now),observedAt:now.toISOString(),submissionAttempted:false,readSafety:'reviewed_passive',
    operationMode:'safe_history_page',evidence};
  return {accountId:auth.accountId,result:{...metadata,nativeGate:true,inspection,
    readbackReceipt:{...metadata,inspection},nativeReadback:{stage:'completed',code:'receipt_accepted',exitCode:0,
      durationMs:0,stderrPresent:false,stderrBytes:0,sameOrigin:true,authenticated:true,waf:false,loginRoute:false,
      siteBodyLoaded:true,pageContentAvailable:true,hasDailySignal:positive,hasSignedControl:positive}}};
}

async function launchBound(state,launch){
  const context=await launch({...state.config,automationUserDataDir:state.binding.profile,ptPassiveReadOnly:true,
    ptReadProxyServer:state.policy.proxyServer,nativePtReadOrigin:state.origin,failureScreenshots:false});
  try{await context.route('**/*',route=>route.abort('blockedbyclient'));return context;}
  catch(error){await context.close().catch(()=>{});throw error;}
}

export async function readNativePtApiHeader({root,origin,launch=launchAutomationContext,clock=()=>new Date(),gate=runNativePtGate}={}){
  let state,context;
  try{
    state=settings(root,origin);
    const bound=await gate({root:state.root,origin,url:state.policy.url,profile:state.binding.profile,mainProfile:false,phase:'bind',clock});
    if(bound.allow!==true||bound.accountKey!==state.identity.accountKey||bound.profileBinding!==state.identity.profileBinding)
      return unavailable(state.identity,'native_readback_unavailable');
    context=await launchBound(state,launch);
    return (await readInContext(context,state,clock)).result;
  }catch{return unavailable(state?.identity,'native_readback_unavailable');}
  finally{await context?.close().catch(()=>{});}
}

export async function readNativePtApiHeaderInContext({root,origin,context,expectedProfileBinding,profileProof,
  clock=()=>new Date(),gate=runNativePtGate}={}){
  let state;
  try{
    state=settings(root,origin);
    if(state.binding.profileBinding!==expectedProfileBinding||typeof profileProof!=='function'||!await profileProof())
      return unavailable(state.identity,'native_readback_unavailable');
    const bound=await gate({root:state.root,origin,url:state.policy.url,profile:state.binding.profile,mainProfile:false,phase:'bind',clock});
    if(bound.allow!==true||bound.profileBinding!==state.identity.profileBinding||bound.accountKey!==state.identity.accountKey)
      return unavailable(state.identity,'native_readback_unavailable');
    const value=(await readInContext(context,state,clock)).result;
    return await profileProof()?value:unavailable(state.identity,'native_readback_unavailable');
  }catch{return unavailable(state?.identity,'native_readback_unavailable');}
}

// A native CDP context's API client does not inherit Chrome's command-line
// proxy. Keep this passive account read inside the verified Chrome session.
export function piggoNativePassiveContext(page){
  const origin='https://piggo.me',url=origin+'/index.php';
  return {newPage:()=>page.context().newPage(),request:{get:async target=>{
    if(new URL(page.url()).origin!==origin||target!==url)throw Error('Passive request rejected');
    const value=await page.evaluate(async destination=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetch(destination,{method:'GET',credentials:'same-origin',redirect:'manual',cache:'no-store',signal:controller.signal});
        const body=await response.text();if(body.length>2_000_000)throw Error('Passive page too large');
        return {url:response.url,status:response.status,date:response.headers.get('date'),body};
      }finally{clearTimeout(timer);}
    },target);
    return {url:()=>value.url,status:()=>value.status,headers:()=>({date:value.date}),text:async()=>value.body};
  }}};
}

function formalCompletion(text,now){
  const patterns=/(?:今日|今天|当日|當日).{0,18}(?:已签到|已簽到|已经签到|已經簽到|签到成功|簽到成功)|(?:已签到|已簽到|已经签到|已經簽到).{0,18}(?:今日|今天|当日|當日)|本次(?:签到|簽到).{0,18}(?:获得|獲得).{0,10}\d/g;
  for(const match of String(text??'').matchAll(patterns)){
    const line=String(text).slice(Math.max(0,match.index-30),Math.min(text.length,match.index+match[0].length+80));
    if(/(?:历史|歷史|昨日|昨天|上次|累计|累計).{0,24}(?:签到|簽到)|未签到|未簽到|签到失败|簽到失敗|说明|說明|示例|教程|签到规则|如果|若|点击|點擊|可以获得|可以獲得|可获得|可獲得|将会|將會/.test(line))continue;
    const dates=[...line.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(value=>value[0]);
    if(dates.some(value=>value!==day(now)))continue;
    return {source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:day(now),
      pagePath:'/attendance.php',statusSignal:'submitted_success_response',evidenceScope:'site_account_day'};
  }
  return null;
}

export async function runNativePtApiCheckin({root,origin,url,launch=launchAutomationContext,clock=()=>new Date(),
  gate=runNativePtGate,validateLease=validateControllerLease,acquire=acquireRunLock,release=releaseRunLock}={}){
  let state,context,lock,attempted=false;
  try{
    state=settings(root,origin,{execution:true,url});
    await validateLease(state.root);
    lock=await acquire(path.join(state.root,'tmp/run.lock'));
    const boundArgs={root:state.root,origin,url,profile:state.binding.profile,mainProfile:false,clock};
    const bound=await gate({...boundArgs,phase:'bind'});
    if(bound.allow!==true||bound.accountKey!==state.identity.accountKey||bound.profileBinding!==state.identity.profileBinding)
      return {...(bound.decision??unavailable(state.identity)),...state.identity,nativeGate:true};
    context=await launchBound(state,launch);
    const before=await readInContext(context,state,clock);
    if(successful(before.result))return before.result;
    if(before.result.status!=='not_signed')return before.result;
    const registered=await gate({...boundArgs,phase:'readback',receipt:before.result.readbackReceipt});
    if(registered.allow!==true)return {...(registered.decision??unavailable(state.identity)),...state.identity,nativeGate:true};
    const decision=await gate({...boundArgs,phase:'inspect'});
    if(decision.allow!==true)return {...(decision.decision??unavailable(state.identity)),...state.identity,nativeGate:true};
    const current=settings(state.root,origin,{execution:true,url});
    if(current.binding.profileBinding!==state.binding.profileBinding||current.policy.proxyServer!==state.policy.proxyServer)
      return unavailable(state.identity);
    await validateLease(state.root);
    const attemptId=crypto.randomUUID(),startedDay=day(clock());
    const started=await gate({...boundArgs,phase:'begin',attemptId,action:'navigation'});
    if(started.allow!==true)return {...(started.decision??unavailable(state.identity)),...state.identity,nativeGate:true};
    attempted=true;
    // The reviewed mature endpoint performs attendance on this single GET.
    // There is no POST discovery, captcha handling, redirect or retry here.
    const completed=await fetchPage(context,url,state.policy,clock);
    if(!completed?.snapshot||day(completed.now)!==startedDay)return unknown(state.identity);
    const after=authenticatedSnapshot(completed.snapshot,state,url);
    const evidence=after.authenticated&&after.accountId===before.accountId?formalCompletion(completed.snapshot.bodyText,completed.now):null;
    if(!evidence)return unknown(state.identity);
    let saved;try{saved=await gate({...boundArgs,phase:'finish',attemptId,status:'signed',evidence});}catch{saved=null;}
    if(saved?.allow!==true||saved.confirmed!==true||saved.confirmationState!=='confirmed')
      return {...unknown(state.identity),confirmationState:'not_persisted'};
    return {origin,url,status:'signed',nativeGate:true,...state.identity,submissionAttempted:true,evidence,
      operationMode:'legacy_checkin',readSafety:'attendance_page_risk',attendanceRisk:true,
      reason:'原生 API 的当次 GET 响应已确认签到完成并持久化'};
  }catch{return attempted?unknown(state?.identity):unavailable(state?.identity,'native_readback_unavailable');}
  finally{await context?.close().catch(()=>{});if(lock)await release(lock).catch(()=>{});}
}
