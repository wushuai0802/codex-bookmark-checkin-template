import crypto from 'node:crypto';
import path from 'node:path';
import {configuredIsolatedOAuthSiteProfiles,configForIsolatedOAuthSite} from './isolated-site-profiles.mjs';
import {configuredOAuthSessionProfiles,configForOAuthSession} from './oauth-session-profiles.mjs';
import {configForOAuthExecutionAccount} from './oauth-execution-binding.mjs';
import {ptPageEvidence,classifyPageText} from './detector.mjs';
import {ptReadPolicies,nativePtHeaderOrigins} from './checkin-contract.generated.mjs';

export function ptExecutionBinding(config,root,target){
  if([config.isolatedOAuthSiteProfiles?.[target.origin],config.oauthSiteSessionBindings?.[target.origin],
    config.oauthExecutionAccountBindings?.[target.origin]].filter(Boolean).length>1)throw Error('conflicting PT profile bindings');
  const accountKey=target.accountKey??'site-default';
  const identities=[...Object.entries(config.oauthAccountIdentities??{}).map(([origin,a])=>({...a,origin})),...(config.supplementalOAuthAccounts??[])];
  const accounts=identities.filter(a=>a.origin===target.origin);
  if(accountKey==='site-default'&&accounts.length)throw Error('PT account binding must be explicit');
  const account=accounts.filter(a=>a.accountKey===accountKey);
  if(accountKey!=='site-default'&&(account.length!==1||!account[0].automationUserDataDir))throw Error('PT account binding is ambiguous');
  let selected=configForIsolatedOAuthSite(config,configuredIsolatedOAuthSiteProfiles(config,root),target.origin);
  selected=configForOAuthSession(selected,configuredOAuthSessionProfiles(config,root),target.origin);
  selected=configForOAuthExecutionAccount(selected,root,target.origin);
  if(account.length){
    const routed=[config.isolatedOAuthSiteProfiles?.[target.origin],config.oauthSiteSessionBindings?.[target.origin],config.oauthExecutionAccountBindings?.[target.origin]].some(Boolean);
    if(routed&&path.resolve(root,selected.automationUserDataDir).toLowerCase()!==path.resolve(root,account[0].automationUserDataDir).toLowerCase())throw Error('PT identity and profile route disagree');
    selected={...selected,automationUserDataDir:account[0].automationUserDataDir};
  }
  const profile=path.resolve(root,selected.automationUserDataDir??'');
  const relative=path.relative(path.resolve(root,'data'),profile);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('PT execution profile must be inside data');
  const key=process.platform==='win32'?profile.toLowerCase():profile;
  return {config:{...selected,automationUserDataDir:profile},profile,accountKey,
    profileBinding:crypto.createHash('sha256').update(key).digest('hex')};
}

// OpenCD index supplies the passive server-rendered header. CAPTCHA submission
// stays in the formal runner. Bookmark folder names never grant capabilities.
export function ptReadProxy(config = {}) {
  if(config.ptPassiveReadOnly!==true||!config.ptReadProxyServer)return undefined;
  const proxy=new URL(config.ptReadProxyServer);
  if(proxy.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(proxy.hostname)||!proxy.port||
    proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash)
    throw Error('PT read proxy must be a credential-free local HTTP proxy');
  return {server:proxy.origin};
}

export function ptReadPolicy(origin,config={}){
  const nativeOrigin=value=>new URL(value).origin.replace(/^https:\/\/www\./,'https://');
  // Registration is validated against the exact current bookmark catalog by
  // the gateway. Passive index capability does not need the mutation allowlist.
  const nativeBound=nativePtHeaderOrigins.some(value=>nativeOrigin(value)===nativeOrigin(origin));
  const policy=config.ptReadOnlyPolicies?.[origin]??(ptReadPolicies[origin]?{
    reviewed:true,mode:'safe_history_page',url:origin+'/index.php',...ptReadPolicies[origin]
  }:nativeBound?{
    reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'#info_block',nativeMainChrome:true
  }:null);
  const unsafe=()=>{const e=Error('PT read-only capability is not reviewed for this site');e.code='PT_READONLY_UNSAFE';return e;};
  if(!policy||policy.reviewed!==true||policy.mode!=='safe_history_page'||typeof policy.selector!=='string'||
    !policy.selector||policy.selector.length>150||policy.loginPath!==undefined&&policy.loginPath!=='/login.php')throw unsafe();
  let url;try{url=new URL(policy.url);}catch{throw unsafe();}
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash||
     /attendance|check[-_]?in|sign[_-]?(?:in|out)|logout|delete|submit|confirm|claim/i.test(decodeURIComponent(url.pathname))||
     [...url.searchParams].some(([key,value])=>!['id','page'].includes(key)||!/^\d{1,12}$/.test(value)))throw unsafe();
  if(policy.hddolbyHeader===true&&(origin!=='https://www.hddolby.com'||url.href!==origin+'/log.php'||
    policy.selector!=='#info_block'||policy.nativeMainChrome||policy.selfProfileHeader))throw unsafe();
  ptReadProxy({ptPassiveReadOnly:true,ptReadProxyServer:policy.proxyServer});
  return {...policy,url:url.href};
}

export async function readPtPublicAvailability(origin,policy,{fetchPage=fetch}={}){
  // This published maintenance page is fetched without an authenticated browser
  // or cookies. It can explain unavailability, never establish account status.
  if(origin!=='https://ptsbao.club'||policy.publicAvailabilityUrl!==origin+'/claim/')return null;
  try{
    const response=await fetchPage(policy.publicAvailabilityUrl,{method:'GET',redirect:'manual',credentials:'omit',signal:AbortSignal.timeout(8000)});
    if(response.status!==200)return null;
    const text=(await response.text()).slice(0,100000).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    if(/维护通知/.test(text)&&/数据恢复与测试阶段.{0,20}暂时无法访问/.test(text))
      return {status:'needs_attention',failureCode:'site_maintenance',siteCondition:'site_maintenance',
        retryCause:'upstream_unavailable',evidence:{source:'page_text',authoritative:false}};
  }catch{/* A failed public read says nothing about the account. */}
  return null;
}

export function classifyPtPassivePage({origin,url,policy,bodyText,controls=[],authenticated=false,httpStatus=200,now=new Date()}){
  const classification=classifyPageText({url,bodyText});
  if(classification.status==='login_required'&&httpStatus===200){
    try{if(new URL(url).origin===origin)return {...classification,submissionAttempted:false};}catch{}
  }
  if(url!==policy.url||httpStatus!==200)return {status:'unknown',failureCode:'network_error'};
  if(classification.status==='login_required')return {...classification,submissionAttempted:false};
  if(classification.retryCause==='upstream_unavailable')return {...classification,
    ...(/数据恢复|全量恢复|维护通知/.test(bodyText)?{failureCode:'site_maintenance'}:{}),submissionAttempted:false};
  if(policy.dailyHeader){
    if(!authenticated)return {status:'unknown',failureCode:'authoritative_status_unavailable'};
    const actions=controls.filter(c=>c.path===policy.actionPath).map(c=>String(c.text).trim().replace(/^[\[【]|[\]】]$/g,''));
    const unsigned=actions.some(text=>[policy.unsignedText,...(policy.unsignedTexts??[])].includes(text));
    // On these reviewed headers the action itself switches from "签到得…"
    // to "签到已得…" after success. A counter elsewhere is not this control.
    const signed=actions.some(text=>/^(?:今日|今天)?(?:已签到|已簽到|已经签到|已經簽到)$/.test(text)||
      (policy.signedTexts??[]).includes(text.replace(/\s+/g,''))||
      policy.signedRewardControl===true&&/^(?:签到已得|簽到已得)[0-9,.]+(?:,\s*补签卡:\s*\d+)?$/.test(text));
    if(unsigned&&signed)return {status:'unknown',failureCode:'authoritative_status_unavailable'};
    if(unsigned||signed)return {status:unsigned?'not_signed':'already_signed',evidence:{source:'pt_page',authoritative:true,
      confirmedAt:now.toISOString(),businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),
      pagePath:new URL(policy.url).pathname,statusSignal:unsigned?'nexus_daily_header_unsigned':'nexus_daily_header_signed'}};
    if(policy.signedTexts?.length)return {status:'unknown',failureCode:'authoritative_status_unavailable'};
  }
  const evidence=ptPageEvidence({origin,url,bodyText,status:'already_signed',now,allowUndatedActionText:false});
  return {status:evidence?'already_signed':'unknown',evidence:evidence?{...evidence,pagePath:new URL(policy.url).pathname}:undefined};
}

export async function readPtPassivePage(page,policy,{origin,now=new Date(),httpStatus=200}={}){
  const bodyText=await page.locator(policy.selector).innerText({timeout:5000}).catch(()=> '');
  // A reviewed server login redirect is rendered at the passive URL. Body
  // text may explain login/maintenance, never supply daily completion proof.
  if(!bodyText&&policy.dailyHeader&&httpStatus===200&&page.url()===policy.url){
    const diagnostic=classifyPageText({url:page.url(),bodyText:await page.locator('body').innerText({timeout:5000}).catch(()=> '')});
    if(diagnostic.status==='login_required'||diagnostic.retryCause==='upstream_unavailable')
      return {...diagnostic,submissionAttempted:false};
  }
  let controls=[],authenticated=false;
  if(policy.dailyHeader){
    controls=await page.locator(policy.selector+' a').evaluateAll(links=>links.map(a=>({text:a.textContent.trim(),path:new URL(a.href).pathname}))).catch(()=>[]);
    authenticated=await page.locator('a').evaluateAll(links=>links.some(a=>/\/(?:logout|logoff)\.php/.test(a.href))&&
      links.some(a=>/\/usercp\.php/.test(a.href))&&links.some(a=>/\/userdetails\.php\?id=\d+/.test(a.href))).catch(()=>false);
  }
  return classifyPtPassivePage({origin,url:page.url(),policy,bodyText,controls,authenticated,httpStatus,now});
}

export async function installPtReadFirewall(context,policy){
  // JS and service workers are disabled at context creation. Allow a single
  // approved main document GET and its reviewed login redirect. Block scripts,
  // POST, XHR, popups and all other redirects, including attendance actions.
  let consumed=false;
  await context.route('**/*',async route=>{
    const request=route.request();
    let allowed=false;
    try{
      const mainDocument=request.method()==='GET'&&request.resourceType()==='document'&&request.isNavigationRequest()&&
        request.frame()===request.frame().page().mainFrame();
      if(mainDocument&&!consumed&&request.url()===policy.url){consumed=true;allowed=true;}
    }catch{/* deny unbound requests */}
    if(!allowed)return route.abort('blockedbyclient');
    // Browser routing may not intercept requests after a server redirect.
    // Fetch each document without automatic redirects before rendering it.
    const deadline=Date.now()+15000;
    try{
      let response=await route.fetch({maxRedirects:0,timeout:15000});
      if(response.status()>=300&&response.status()<400){
        const location=response.headers().location;
        const loginUrl=policy.loginPath==='/login.php'?new URL(policy.loginPath,policy.url).href:null;
        if(!location||!loginUrl||new URL(location,policy.url).href!==loginUrl)return route.abort('blockedbyclient');
        response=await route.fetch({url:loginUrl,maxRedirects:0,timeout:Math.max(1,deadline-Date.now())});
        if(response.status()!==200)return route.abort('blockedbyclient');
      }
      return route.fulfill({response});
    }catch{return route.abort('failed').catch(()=>{});}
  });
}
