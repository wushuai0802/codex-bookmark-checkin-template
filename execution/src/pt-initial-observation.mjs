import {ptReadPolicy,readPtPublicAvailability,classifyPtPassivePage} from './pt-read-policy.mjs';
import {ptFailureMessages} from './checkin-contract.generated.mjs';

// Use the bound context's cookie jar for one reviewed GET. Parse its server HTML
// on a blank page; scripts, action URLs and redirects are never navigated.
export async function initialPtObservation(page,target,config,{now=new Date(),get=null,fetchPage}={}){
  try{
    const policy=ptReadPolicy(target.origin,config);
    if(policy.nativeMainChrome||policy.selfProfileHeader)return null;
    if(policy.publicAvailabilityUrl){
      const availability=await readPtPublicAvailability(target.origin,policy,{...(fetchPage?{fetchPage}:{})});
      if(availability)return {...availability,reason:ptFailureMessages.site_maintenance,submissionAttempted:false,
        operationMode:'safe_history_page',readSafety:'reviewed_passive',url:policy.publicAvailabilityUrl};
    }
    const response=await (get??((url,options)=>page.context().request.get(url,options)))(policy.url,
      {maxRedirects:0,failOnStatusCode:false,timeout:8000});
    if(response.status()!==200||response.url()!==policy.url)return null;
    const serverDate=Date.parse(response.headers?.().date??'');
    const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
    if(Number.isFinite(serverDate)&&(dayAt(serverDate)!==dayAt(now)||serverDate>now.getTime()+60_000))return null;
    const html=await response.text();if(html.length>500000)return null;
    const safeTags=new Set(['html','head','body','div','span','p','a','ul','ol','li','table','tbody','thead','tr','td','th','b','strong','i','em','font','br','header','nav','section','article','main']);
    const inert=html.replace(/<(?:script|style|iframe|object|embed)\b[\s\S]*?<\/(?:script|style|iframe|object|embed)>/gi,'')
      .replace(/<\/?([A-Za-z][A-Za-z0-9:_-]*)\b([^>]*)>/g,(tag,name,attributes)=>{
        name=name.toLowerCase();if(!safeTags.has(name))return '';
        if(tag.startsWith('</'))return '</'+name+'>';
        const keep=[...attributes.matchAll(/(?:^|\s)(id|class|href)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi)]
          .filter(match=>name==='a'||match[1].toLowerCase()!=='href').map(match=>match[1]+'='+match[2]).join(' ');
        return '<'+name+(keep?' '+keep:'')+'>';
      });
    const parsed=await page.evaluate(({html,selector,origin})=>{
      const document=new DOMParser().parseFromString(html,'text/html');
      const region=document.querySelector(selector);if(!region)return null;
      const path=a=>{try{const url=new URL(a.getAttribute('href'),origin);return url.origin===origin?url.pathname:'';}catch{return '';}};
      const all=[...document.querySelectorAll('a[href]')];
      const authenticated=all.some(a=>/^\/(?:logout|logoff)\.php$/.test(path(a)))&&
        all.some(a=>path(a)==='/usercp.php')&&all.some(a=>path(a)==='/userdetails.php'&&/[?&]id=\d+/.test(a.getAttribute('href')));
      return {bodyText:region.textContent,authenticated,
        controls:[...region.querySelectorAll('a[href]')].map(a=>({text:a.textContent.trim(),path:path(a)}))};
    },{html:inert,selector:policy.selector,origin:target.origin});
    if(!parsed?.authenticated)return null;
    const result=classifyPtPassivePage({origin:target.origin,url:policy.url,policy,...parsed,httpStatus:200,now});
    if(result.status!=='already_signed'||result.evidence?.authoritative!==true)return null;
    return {...result,reason:'已登录的只读首页确认今日已签到',submissionAttempted:false,
      operationMode:'safe_history_page',readSafety:'reviewed_passive',url:policy.url};
  }catch{return null;}
}
