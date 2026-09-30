import crypto from 'node:crypto';
import path from 'node:path';
import {configuredIsolatedOAuthSiteProfiles,configForIsolatedOAuthSite} from './isolated-site-profiles.mjs';
import {configuredOAuthSessionProfiles,configForOAuthSession} from './oauth-session-profiles.mjs';
import {configForOAuthExecutionAccount} from './oauth-execution-binding.mjs';

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
export function ptReadPolicy(origin,config={}){
  const policy=config.ptReadOnlyPolicies?.[origin]??(origin==='https://open.cd'?{
    reviewed:true,mode:'safe_history_page',url:origin+'/index.php',selector:'body',openCdHeader:true
  }:null);
  const unsafe=()=>{const e=Error('PT read-only capability is not reviewed for this site');e.code='PT_READONLY_UNSAFE';return e;};
  if(!policy||policy.reviewed!==true||policy.mode!=='safe_history_page'||typeof policy.selector!=='string'||
    !policy.selector||policy.selector.length>150)throw unsafe();
  let url;try{url=new URL(policy.url);}catch{throw unsafe();}
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash||
     /attendance|check[-_]?in|sign[_-]?(?:in|out)|logout|delete|submit|confirm|claim/i.test(decodeURIComponent(url.pathname))||
     [...url.searchParams].some(([key,value])=>!['id','page'].includes(key)||!/^\d{1,12}$/.test(value)))throw unsafe();
  return {...policy,url:url.href};
}

export async function installPtReadFirewall(context,policy){
  // JS and service workers are disabled at context creation. Allow a single
  // approved main document GET; block scripts, POST, XHR, popups and redirects.
  let consumed=false;
  await context.route('**/*',async route=>{
    const request=route.request();
    let allowed=false;
    try{allowed=!consumed&&request.method()==='GET'&&request.url()===policy.url&&
      request.resourceType()==='document'&&request.isNavigationRequest()&&
      request.frame()===request.frame().page().mainFrame();}catch{/* deny unbound requests */}
    if(!allowed)return route.abort('blockedbyclient');
    consumed=true;return route.continue();
  });
}
