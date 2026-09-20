import {defineAdapter} from './adapter-contract.mjs';
import {createCookieJar,parseRouteJson,requestWithEsa,resolveAnyRouterRoute} from './anyrouter-route.mjs';

const REQUEST_TIMEOUT_MS=15_000;

function pageFor(context){
  if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');
  return context.page;
}
function endpoint(origin,value,fallback,name){
  const url=new URL(value||fallback,origin);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error('invalid AnyRouter '+name+' endpoint');
  return url.pathname+url.search;
}
function boundedInteger(value,fallback,min,max){
  const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;
}
function safeText(value,max=180){return typeof value==='string'?value.replace(/[\r\n\t]+/g,' ').slice(0,max):'';}
function booleanValue(value){
  if(value===true||value===false)return value;
  if(value===1||value==='1'||(typeof value==='string'&&value.toLowerCase()==='true'))return true;
  if(value===0||value==='0'||(typeof value==='string'&&value.toLowerCase()==='false'))return false;
  return null;
}
function payloadOf(body){return body?.data&&typeof body.data==='object'?body.data:body??{};}
function rows(body){
  const payload=payloadOf(body);
  if(Array.isArray(payload))return payload;
  for(const value of [payload?.items,payload?.records,payload?.logs,payload?.list,body?.items,body?.records])if(Array.isArray(value))return value;
  return null;
}
function epoch(value){
  const number=Number(value);
  if(Number.isFinite(number))return number>10_000_000_000?number/1000:number;
  const parsed=Date.parse(String(value??''));return Number.isFinite(parsed)?parsed/1000:null;
}
function sameDay(value,day){
  const stamp=epoch(value);
  return stamp!=null&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(stamp*1000))===day;
}
function dayBounds(day){
  const start=Date.parse(String(day)+'T00:00:00+08:00')/1000;
  return {start,end:start+86400};
}
function responseCause(response){
  if(response?.status===401)return'auth_expired';
  if(response?.status===403)return'challenge_required';
  if(response?.status===429)return'rate_limited';
  if(!response?.status||response.status>=500)return'unreachable';
  return'invalid_response';
}
function sameOrigin(response,origin){
  if(!response?.url)return true;
  try{return new URL(response.url).origin===origin;}catch{return false;}
}

async function storageIds(page,keys,scanAll){
  const result=await page.evaluate(({keys,scanAll})=>{
    const ids=[];
    const extract=value=>value?.id??value?.user?.id??value?.state?.user?.id??value?.data?.id??value?.data?.user?.id??null;
    const read=(storage,key)=>{try{const raw=storage.getItem(key),id=extract(JSON.parse(raw||'null'));if(/^\d{1,20}$/.test(String(id??'')))ids.push(String(id));if(key==='uid'&&/^\d{1,20}$/.test(String(raw??'')))ids.push(String(raw));}catch{}};
    for(const storage of [localStorage,sessionStorage]){
      if(scanAll){for(let index=0;index<storage.length;index+=1){const key=storage.key(index);if(key)read(storage,key);}}
      else for(const key of keys)read(storage,key);
    }
    return [...new Set(ids)];
  },{keys,scanAll});
  return Array.isArray(result)?result:Array.isArray(result?.ids)?result.ids:Array.isArray(result?.storageIds)?result.storageIds:[];
}

export function createAnyRouterExecutionAdapter({origin,rule={}}={}){
  const site=new URL(origin).origin;
  const selfPath=endpoint(site,rule.selfPath,'/api/user/self','self');
  const statusPath=endpoint(site,rule.statusPath,'/api/status','status');
  const signInPath=endpoint(site,rule.signInPath,'/api/user/sign_in','sign_in');
  const logPath=endpoint(site,rule.logPath,'/api/log/self','log');
  const logType=Number.isInteger(Number(rule.logType))?Number(rule.logType):4;
  const rewardAmount=Number.isFinite(Number(rule.rewardAmount))?Number(rule.rewardAmount):25;
  const logSuccessText=safeText(rule.logSuccessText||'每日签到成功，增加额度',120);
  const dynamicRule=rule.dynamicRoute&&typeof rule.dynamicRoute==='object'?rule.dynamicRoute:null;
  if(dynamicRule&&site!=='https://anyrouter.top')throw Error('dynamic AnyRouter routes require anyrouter.top');
  const keys=Array.isArray(rule.userStorageKeys)?rule.userStorageKeys.map(value=>String(value).trim()).filter(Boolean):['user','user_info','userInfo','current_user'];
  if(keys.length===0||keys.length>12)throw Error('invalid AnyRouter userStorageKeys');
  const scanAll=rule.scanAllStorage===true;
  const maxLogPages=boundedInteger(rule.maxLogPages,3,1,5);
  const verifyAttempts=boundedInteger(rule.verifyAttempts,4,1,6);
  const verifyDelayMs=boundedInteger(rule.verifyDelayMs,500,100,5000);
  const allowUndatedStatus=rule.allowUndatedStatus===true;
  let routePromise=null,routeJar=null;

  async function browserRequest(context,path,options={}){
    return pageFor(context).evaluate(async({path,options,timeoutMs})=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await fetch(path,{credentials:'include',redirect:'error',...options,headers:{Accept:'application/json',...(options.headers||{})},signal:controller.signal});
        const text=await response.text();let body=null;try{body=JSON.parse(text);}catch{}
        return{status:response.status,url:response.url,body,text:text.slice(0,400)};
      }catch(error){return{status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}
      finally{clearTimeout(timer);}
    },{path,options,timeoutMs:REQUEST_TIMEOUT_MS});
  }
  async function request(context,path,options={}){
    if(!dynamicRule)return browserRequest(context,path,options);
    if(!routePromise)routePromise=resolveAnyRouterRoute(dynamicRule);
    const route=await routePromise;
    if(!route)return {status:0,url:'',body:null,networkError:true,routeUnavailable:true};
    if(!routeJar){
      let cookies=[];try{cookies=await pageFor(context).context().cookies(site);}catch{}
      routeJar=createCookieJar(cookies);
    }
    const response=await requestWithEsa(route,path,{...options,timeoutMs:Math.min(REQUEST_TIMEOUT_MS,Number(dynamicRule.timeoutMs)||REQUEST_TIMEOUT_MS)},routeJar);
    return {...response,body:parseRouteJson(response)};
  }
  async function readIdentity(context,expected){
    const id=String(expected??'');if(!/^\d{1,20}$/.test(id))return null;
    const ids=await storageIds(pageFor(context),keys,scanAll);if(ids.some(value=>value!==id))return null;
    const self=await request(context,selfPath,{headers:{'New-Api-User':id}});
    const user=self?.body?.data?.user??self?.body?.data??self?.body?.user;
    if(self?.status!==200||!sameOrigin(self,site)||self?.body?.success!==true||String(user?.id??'')!==id)return null;
    const username=user?.username??user?.name??user?.display_name;
    return {userId:id,username:typeof username==='string'?username.slice(0,80):null,origin:site};
  }
  async function readRewardStatus(context,identity,businessDate){
    const bounds=dayBounds(businessDate),userId=String(identity?.userId??'');
    for(let index=0;index<maxLogPages;index+=1){
      const query=new URL(logPath,site);
      query.searchParams.set('p',String(index));query.searchParams.set('page_size','100');query.searchParams.set('type',String(logType));
      query.searchParams.set('start_timestamp',String(bounds.start));query.searchParams.set('end_timestamp',String(bounds.end));
      const response=await request(context,query.pathname+query.search,{headers:{'New-Api-User':userId}});
      if(!sameOrigin(response,site))return {state:'unknown',reason:'cross_origin_redirect'};
      if(response?.status!==200||response.networkError)return {state:'unknown',reason:responseCause(response)};
      const items=rows(response.body);if(!items||response.body?.success===false||payloadOf(response.body)?.success===false)return {state:'unknown',reason:'invalid_response'};
      const match=items.find(item=>{
        const created=epoch(item?.created_at??item?.createdAt??item?.date);
        const amount=Number(String(item?.content??'').match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]);
        const itemId=item?.user_id??item?.userId??item?.account_id??item?.accountId;
        return Number(item?.type)===logType&&created!=null&&created>=bounds.start&&created<bounds.end
          &&(itemId==null||String(itemId)===userId)&&String(item?.content??'').includes(logSuccessText)
          &&Number.isFinite(amount)&&Math.abs(amount-rewardAmount)<0.000001;
      });
      if(match){
        const created=epoch(match.created_at??match.createdAt??match.date);
        return {state:'already_done',evidence:{authoritative:true,source:'anyrouter_log',businessDate,accountId:userId,rewardAmount,createdAt:created==null?null:new Date(created*1000).toISOString(),statusSignal:'reward_log'}};
      }
      if(items.length<100)break;
    }
    return {state:'not_signed',evidence:{authoritative:true,source:'anyrouter_log',businessDate,accountId:userId,statusSignal:'reward_absent'}};
  }
  async function readStatus(context,identity,businessDate){
    const month=String(businessDate??'').slice(0,7),path=statusPath+(statusPath.includes('?')?'&':'?')+'month='+encodeURIComponent(month);
    const response=await request(context,path,{headers:{'New-Api-User':String(identity?.userId??'')}});
    if(!sameOrigin(response,site))return {state:'unknown',reason:'cross_origin_redirect'};
    if(response?.routeUnavailable)return {state:'unknown',reason:'route_unavailable'};
    if(response?.status!==200||response.networkError)return {state:'unknown',reason:responseCause(response)};
    const body=response.body,payload=payloadOf(body);
    if(body?.success===false||payload?.success===false){
      const message=String(body?.message??payload?.message??'');
      if(/未启用|未啟用|not enabled/i.test(message))return {state:'not_available',reason:'feature_disabled',evidence:{authoritative:true,source:'anyrouter_status',businessDate,accountId:String(identity?.userId??''),outcome:'message_not_enabled'}};
      return {state:'unknown',reason:'invalid_response'};
    }
    const checked=booleanValue(payload?.stats?.checked_in_today??payload?.stats?.checkedInToday??payload?.checked_in_today??payload?.checkedInToday);
    const all=rows(body)??[],today=all.filter(item=>sameDay(item?.checkin_date??item?.checkinDate??item?.date??item?.created_at,businessDate));
    if(today.some(item=>{const id=item?.user_id??item?.userId??item?.account_id??item?.accountId;return id!=null&&String(id)!==String(identity?.userId);}))return {state:'unknown',reason:'identity_mismatch'};
    const dated=allowUndatedStatus||today.length>0||sameDay(payload?.checkin_date??payload?.checkinDate??payload?.last_checkin_date??payload?.lastCheckinDate,businessDate);
    if(checked===true&&dated)return {state:'already_done',evidence:{authoritative:true,source:'anyrouter_status',businessDate,accountId:String(identity?.userId),statusSignal:'checked_in_today'}};
    if(checked===false&&today.length===0)return readRewardStatus(context,identity,businessDate);
    return readRewardStatus(context,identity,businessDate);
  }

  return defineAdapter({id:'anyrouter.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context}={}){return readIdentity(context,expectedIdentity);},
    async read_status({identity,businessDate,context}={}){return readStatus(context,identity,businessDate);},
    async submit_once({identity,context}={}){
      const response=await request(context,signInPath,{method:'POST',headers:{'New-Api-User':String(identity?.userId??''),'Content-Type':'application/json'},body:'{}'});
      if(!sameOrigin(response,site))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
      if(response?.routeUnavailable)return {state:'rejected',reason:'route_unavailable',actionMayHaveHappened:false};
      if(response?.networkError||response?.status>=500)return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};
      if(response?.status===401)return {state:'rejected',reason:'auth_expired',actionMayHaveHappened:false};
      if(response?.status===403)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
      if(response?.status===429)return {state:'rejected',reason:'rate_limited',actionMayHaveHappened:false};
      const message=safeText(response?.body?.message??response?.body?.msg??response?.text);
      if(response?.status>=200&&response?.status<300&&(response?.body?.success===true||/签到成功|簽到成功|已签到|已簽到|already/i.test(message)))return {state:'accepted',response:{status:response.status}};
      if(response?.status>=200&&response?.status<300)return {state:'unknown',reason:'submit_response_ambiguous',actionMayHaveHappened:true};
      return {state:'rejected',reason:'invalid_response',actionMayHaveHappened:false};
    },
    async verify({identity,businessDate,context}={}){
      for(let attempt=0;attempt<verifyAttempts;attempt+=1){
        const status=await readStatus(context,identity,businessDate);
        if(status.state==='already_done'){
          const final=await readIdentity(context,String(identity?.userId??''));
          if(final?.userId===String(identity?.userId??'')&&final.origin===site)return {state:'confirmed',evidence:status.evidence};
          return {state:'unknown',reason:'identity_mismatch'};
        }
        if(status.state==='unknown'&&!['status_date_contract_missing','calendar_date_contract_missing','unreachable','route_unavailable'].includes(status.reason))return status;
        if(attempt<verifyAttempts-1)await pageFor(context).waitForTimeout?.(verifyDelayMs);
      }
      return {state:'unknown',reason:'submission_not_visible'};
    },
    classify_error(error){const status=Number(error?.status),text=String(error?.message??error);if(status===401)return'auth_expired';if(status===403||/esa|captcha|验证|驗證|challenge/i.test(text))return'challenge_required';if(status===429||/429|rate/i.test(text))return'rate_limited';if(status>=500||!status)return'unreachable';return'unknown';}
  });
}
