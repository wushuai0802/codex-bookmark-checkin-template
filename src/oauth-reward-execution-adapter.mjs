import {defineAdapter} from './adapter-contract.mjs';

const REQUEST_TIMEOUT_MS=15_000;
const PROVIDER_BUTTON_WAIT_MS=5_000;

function pageFor(context){if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');return context.page;}
function boundedInteger(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}
function safeText(value,max=180){return typeof value==='string'?value.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';}
function endpoint(origin,value,fallback,name){const url=new URL(value||fallback,origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error(`invalid OAuth ${name} endpoint`);return `${url.pathname}${url.search}`;}
function responseCause(response){if(response?.status===401)return'auth_expired';if(response?.status===403)return'challenge_required';if(response?.status===429)return'rate_limited';if(!response?.status||response.status>=500)return'unreachable';return'invalid_response';}
function responseOriginOk(response,origin){if(!response?.url)return true;try{return new URL(response.url).origin===origin;}catch{return false;}}
function epochSeconds(value){if(typeof value==='number'&&Number.isFinite(value))return value>10_000_000_000?value/1000:value;if(typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value))return epochSeconds(Number(value));const parsed=Date.parse(String(value??''));return Number.isFinite(parsed)?parsed/1000:null;}
function rowsFrom(body){const payload=body?.data&&typeof body.data==='object'?body.data:body;if(Array.isArray(payload))return payload;for(const value of [payload?.items,payload?.records,payload?.logs,payload?.list,body?.items,body?.records])if(Array.isArray(value))return value;return null;}
function identityKeys(rule){const raw=rule.userStorageKeys??['user','current_user'];if(!Array.isArray(raw)||raw.length>12||raw.some(key=>typeof key!=='string'||!key.trim()||key.length>100||/[\r\n]/.test(key)))throw Error('invalid OAuth userStorageKeys');return [...new Set(raw.map(key=>key.trim()))];}
function dayBounds(day){const start=Date.parse(`${day}T00:00:00+08:00`)/1000;return {start,end:start+86400};}

async function request(context,{path,method='GET',headers={},body=null}={}){
  return pageFor(context).evaluate(async({path,method,headers,body,timeoutMs})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(path,{method,credentials:'include',redirect:'error',headers,body,signal:controller.signal});const text=await response.text();let parsed=null;try{parsed=JSON.parse(text);}catch{}return {status:response.status,url:response.url,body:parsed,text:text.slice(0,500)};}catch(error){return {status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}finally{clearTimeout(timer);}}, {path,method,headers,body,timeoutMs:REQUEST_TIMEOUT_MS});
}

async function navigate(page,url,options={}){
  if(typeof page?.goto!=='function')return false;
  try{await page.goto(url,options);return true;}catch{return false;}
}

async function storageIds(page,keys,scanAll,expected){
  return page.evaluate(({keys,scanAll,expected})=>{const ids=[],extract=value=>value?.id??value?.user?.id??value?.state?.user?.id??value?.data?.id??value?.data?.user?.id??null,read=(storage,key)=>{try{const raw=storage.getItem(key),id=extract(JSON.parse(raw||'null'));if(/^\d{1,20}$/.test(String(id??'')))ids.push(String(id));if(key==='uid'&&/^\d{1,20}$/.test(String(raw??'')))ids.push(String(raw));}catch{}};for(const storage of [localStorage,sessionStorage]){if(scanAll){for(let index=0;index<storage.length;index+=1){const key=storage.key(index);if(key)read(storage,key);}}else for(const key of keys)read(storage,key);}return [...new Set(ids)];},{keys,scanAll,expected});
}

function matchingReward(items,{logType,successText,rewardAmount,start,end,userId}){
  if(!Array.isArray(items))return null;
  return items.find(item=>{const created=epochSeconds(item?.created_at??item?.createdAt??item?.date),content=String(item?.content??''),amount=Number(content.match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]);return Number(item?.type)===logType&&created!=null&&created>=start&&created<end&&(item?.user_id==null||String(item.user_id)===String(userId))&&content.includes(successText)&&Number.isFinite(amount)&&Math.abs(amount-rewardAmount)<0.000001;})??null;
}

export function createOAuthRewardExecutionAdapter({origin,rule={}}={}){
  const site=new URL(origin).origin,selfPath=endpoint(site,rule.selfPath,'/api/user/self','self'),logPath=endpoint(site,rule.logPath,'/api/log/self','log'),logoutPath=endpoint(site,rule.logoutPath,'/api/user/logout','logout'),logoutPagePath=endpoint(site,rule.logoutPagePath,'/console','logout page'),loginPath=endpoint(site,rule.loginPath,'/login','login');
  const successText=safeText(rule.successText||'每日签到成功，增加额度',120),rewardAmount=Number.isFinite(Number(rule.rewardAmount))?Number(rule.rewardAmount):25,logType=Number.isInteger(Number(rule.logType))?Number(rule.logType):4,provider=safeText(rule.provider||'LinuxDO',40),keys=identityKeys(rule),scanAll=rule.scanAllStorage===true,maxLogPages=boundedInteger(rule.maxLogPages,3,1,5),verificationWaitMs=boundedInteger(rule.verificationWaitMs,1000,12_000,30_000),forceLogout=rule.forceLogout!==false;
  const userHeader=userId=>({'New-Api-User':String(userId??'')});

  async function readIdentity(context,expected){
    const id=String(expected??'');if(!/^\d{1,20}$/.test(id))return null;const page=pageFor(context);let probe;try{probe=await storageIds(page,keys,scanAll,id);}catch{probe=null;}if(probe?.challenge)return {blockedReason:'challenge_required',origin:site};let ids=Array.isArray(probe)?probe:(Array.isArray(probe?.storageIds)?probe.storageIds:[]);if(probe?.body){const user=probe.body?.data?.user??probe.body?.data??probe.body?.user;if(probe.status===200&&user?.id!=null&&String(user.id)===id)return {userId:id,username:typeof(user.username??user.name??user.display_name)==='string'?String(user.username??user.name??user.display_name).slice(0,80):null,origin:site};}if(ids.some(value=>value!==id))return null;
    const response=await request(context,{path:selfPath,headers:{Accept:'application/json',...userHeader(id)}}),user=response?.body?.data?.user??response?.body?.data??response?.body?.user;
    if(/aliyun_waf_|滑动验证|访问验证|verify you are human/i.test(String(response?.text??'')))return {blockedReason:'challenge_required',origin:site};
    if(response?.status!==200||!responseOriginOk(response,site)||user?.id==null||String(user.id)!==id)return null;const username=user.username??user.name??user.display_name;return {userId:id,username:typeof username==='string'?username.slice(0,80):null,origin:site};
  }

  async function logStatus({identity,businessDate,context}){
    const {start,end}=dayBounds(businessDate),userId=String(identity?.userId??'');
    for(let pageIndex=0;pageIndex<maxLogPages;pageIndex+=1){
      const query=new URL(logPath,`${site}/`);query.searchParams.set('p',String(pageIndex));query.searchParams.set('page_size','100');query.searchParams.set('type',String(logType));query.searchParams.set('start_timestamp',String(start));query.searchParams.set('end_timestamp',String(end));
      const response=await request(context,{path:query.pathname+query.search,headers:{Accept:'application/json',...userHeader(userId)}});
      if(!responseOriginOk(response,site))return {state:'unknown',reason:'cross_origin_redirect'};
      if(response?.status!==200||response.networkError)return {state:'unknown',reason:responseCause(response)};
      const items=rowsFrom(response.body);if(!items)return {state:'unknown',reason:'invalid_response'};
      const match=matchingReward(items,{logType,successText,rewardAmount,start,end,userId});if(match)return {state:'already_done',evidence:{authoritative:true,source:'oauth_reward_log',businessDate,accountId:userId,rewardAmount,createdAt:new Date(epochSeconds(match.created_at??match.createdAt)*1000).toISOString()}};
      if(items.length<100)break;
    }
    return {state:'not_signed',evidence:{authoritative:true,source:'oauth_reward_log',businessDate,accountId:userId}};
  }

  async function clickProvider(context){
    const page=pageFor(context),labels=[`使用 ${provider} 继续`,`使用 ${provider} 登录`,`使用 ${provider} 登入`,provider];let button=null;
    async function visible(locator){
      if(!locator)return false;
      if(typeof locator.waitFor==='function')await locator.waitFor({state:'visible',timeout:PROVIDER_BUTTON_WAIT_MS}).catch(()=>{});
      return await locator.count().catch(()=>0)===1&&await locator.isVisible().catch(()=>false);
    }
    for(const label of labels){const candidate=page.getByRole?.('button',{name:label,exact:true});if(await visible(candidate)){button=candidate;break;}const text=page.getByText?.(label,{exact:true});if(await visible(text)){button=text;break;}}
    if(!button)return {state:'unknown',reason:'oauth_provider_button_missing'};
    let popup=null,popupWait=null;try{popupWait=page.waitForEvent?.('popup',{timeout:5000});await button.click({timeout:10_000});}catch{return {state:'unknown',reason:'oauth_provider_click_failed'};}if(popupWait)popup=await popupWait.catch(()=>null);
    const authPage=popup||page;await authPage.waitForLoadState?.('domcontentloaded',{timeout:15_000}).catch(()=>{});
    let host='';try{host=new URL(authPage.url()).hostname;}catch{}
    const providerDefaults=/github/i.test(provider)?['github.com']:['connect.linux.do','linux.do'];
    const allowedHosts=Array.isArray(rule.providerHosts)&&rule.providerHosts.length?rule.providerHosts.map(value=>String(value).toLowerCase()):[...providerDefaults,new URL(site).hostname];
    if(host&& !allowedHosts.some(value=>host===value||host.endsWith(`.${value}`)))return {state:'unknown',reason:'oauth_provider_origin_untrusted'};
    if(host){for(const label of ['授权','允许','Authorize','Allow']){const candidate=authPage.getByRole?.('button',{name:label,exact:true})||authPage.getByText?.(label,{exact:true});if(candidate&&await candidate.count().catch(()=>0)===1&&await candidate.isVisible().catch(()=>false)){await candidate.click({timeout:10_000}).catch(()=>{});break;}}}
    await authPage.waitForURL?.(url=>{try{return new URL(url).origin===site;}catch{return false;}},{timeout:60_000}).catch(()=>{});
    try{if(new URL(authPage.url()).origin===site)context.page=authPage;}catch{}
    await pageFor(context).waitForTimeout?.(verificationWaitMs);return {state:'triggered'};
  }

  return defineAdapter({id:'oauth-reward.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context}={}){return readIdentity(context,expectedIdentity);},
    async read_status({identity,businessDate,context}={}){return logStatus({identity,businessDate,context});},
    async submit_once({identity,context}={}){
      const page=pageFor(context);
      if(forceLogout){
        if(!await navigate(page,new URL(site+logoutPagePath).href,{waitUntil:'domcontentloaded',timeout:20_000}))return {state:'unknown',reason:'logout_page_unavailable',actionMayHaveHappened:false};
        if(logoutPath){
          const logout=await request(context,{path:logoutPath,method:'GET',headers:{Accept:'application/json',...userHeader(identity?.userId)}});
          if((logout?.status!==200&&logout?.status!==401&&logout?.status!==403)||logout?.body?.success===false)return {state:'unknown',reason:'logout_not_confirmed',actionMayHaveHappened:false};
        }
      }
      try{await page.goto(new URL(loginPath,`${site}/`).href,{waitUntil:'domcontentloaded',timeout:30_000});}catch{return {state:'unknown',reason:'login_page_unavailable',actionMayHaveHappened:false};}
      const flow=await clickProvider(context);if(flow.state!=='triggered')return {state:'unknown',reason:flow.reason,actionMayHaveHappened:false};
      const verified=await readIdentity(context,String(identity?.userId??''));if(!verified)return {state:'unknown',reason:'oauth_login_not_verified',actionMayHaveHappened:true};return {state:'accepted',response:{oauthRelogin:true,provider}};
    },
    async verify({identity,businessDate,context}={}){for(let attempt=0;attempt<3;attempt+=1){const status=await logStatus({identity,businessDate,context});if(status.state==='already_done'){const final=await readIdentity(context,String(identity?.userId??''));if(final?.userId===String(identity?.userId??'')&&final.origin===site)return {state:'confirmed',evidence:status.evidence};return {state:'unknown',reason:'identity_mismatch'};}if(status.state==='unknown'&&!['unreachable'].includes(status.reason))return status;if(attempt<2)await pageFor(context).waitForTimeout?.(1000*(attempt+1));}return {state:'unknown',reason:'reward_log_not_visible'};},
    classify_error(error){const status=Number(error?.status),text=String(error?.message??error);if(status===401)return'auth_expired';if(status===403||/captcha|验证|驗證|challenge/i.test(text))return'challenge_required';if(status===429||/429|rate/i.test(text))return'rate_limited';if(status>=500||!status)return'unreachable';return'unknown';}
  });
}
