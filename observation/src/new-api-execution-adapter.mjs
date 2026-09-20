import {defineAdapter} from './adapter-contract.mjs';

const REQUEST_TIMEOUT_MS=15_000;
const DEFAULT_REFRESH_TTL_MS=5*60_000;
const MAX_REFRESH_TTL_MS=15*60_000;
let authCache=new WeakMap();

const responseCause=response=>response?.status===401?'auth_expired'
  :response?.status===403?'challenge_required'
  :response?.status===429?'rate_limited'
  :!response?.status||response.status>=500?'unreachable':'invalid_response';

function pageFor(context){
  if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');
  return context.page;
}

function responseMatchesOrigin(response,origin){
  if(!response?.url)return true;
  try{return new URL(response.url).origin===origin;}catch{return false;}
}

function validQuotaAward(value){
  if(typeof value==='number')return Number.isFinite(value)&&value>=0;
  if(typeof value!=='string'||value.length===0||value.trim()!==value)return false;
  if(!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))return false;
  return Number.isFinite(Number(value))&&Number(value)>=0;
}

function boundedInteger(value,fallback,min,max){
  const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;
}

function safeShort(value,max=160){
  return typeof value==='string'?value.replace(/[\r\n\t]+/g,' ').slice(0,max):'';
}

function booleanValue(value){
  if(value===true||value===false)return value;
  if(value===1||value==='1'||(typeof value==='string'&&value.toLowerCase()==='true'))return true;
  if(value===0||value==='0'||(typeof value==='string'&&value.toLowerCase()==='false'))return false;
  return null;
}

function dateInShanghai(value){
  if(value==null)return null;
  const text=String(value).trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(text)){const [year,month,day]=text.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day)return text;return null;}
  const numeric=Number(value);
  if(Number.isFinite(numeric)){
    const date=new Date(numeric>10_000_000_000?numeric:numeric*1000);
    if(Number.isFinite(date.getTime()))return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);
  }
  const parsed=Date.parse(text);
  return Number.isFinite(parsed)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(parsed)):null;
}

function rowsFrom(body){
  const payload=body?.data&&typeof body.data==='object'?body.data:body;
  if(Array.isArray(payload))return payload;
  for(const value of [payload?.stats?.records,payload?.records,payload?.items,payload?.list,payload?.data?.stats?.records,payload?.data?.records,body?.records,body?.items])if(Array.isArray(value))return value;
  return [];
}

function userFrom(body){return body?.data?.user??body?.data??body?.user??body??null;}

function identityKeys(rule){
  const raw=rule.userStorageKeys??rule.storageKeys??['user','user_info','userInfo','current_user'];
  if(!Array.isArray(raw)||raw.length===0||raw.length>12||raw.some(key=>typeof key!=='string'||!key.trim()||key.length>100||/[\r\n]/.test(key)))throw Error('invalid userStorageKeys');
  return [...new Set(raw.map(key=>key.trim()))];
}

function ruleFor(origin,rule={}){
  const base=new URL(origin);
  const resolve=(value,name)=>{
    const url=new URL(value||`/api/user/${name}`,base.origin);
    if(url.protocol!=='https:'||url.origin!==base.origin||url.username||url.password||url.hash)throw Error(`invalid ${name} endpoint`);
    return `${url.pathname}${url.search}`;
  };
  const rewardAmount=rule.rewardAmount==null?null:Number(rule.rewardAmount);
  if(rewardAmount!=null&&(!Number.isFinite(rewardAmount)||rewardAmount<0))throw Error('invalid rewardAmount');
  return {
    selfPath:resolve(rule.selfPath,'self'),statusPath:resolve(rule.statusPath,'checkin'),signInPath:resolve(rule.signInPath,'checkin'),
    authRefreshPath:rule.authRefreshPath?resolve(rule.authRefreshPath,'auth_refresh'):null,
    userStorageKeys:identityKeys(rule),scanAllStorage:rule.scanAllStorage===true,allowVisibleIdentity:rule.allowVisibleIdentity===true,
    rewardAmount,requireReward:rule.requireReward!==false,responseSuccessText:safeShort(rule.responseSuccessText??'',120),
    emptySuccessMeansAlreadySigned:rule.emptySuccessMeansAlreadySigned===true,
    verifyAttempts:boundedInteger(rule.verifyAttempts,4,1,6),verifyDelayMs:boundedInteger(rule.verifyDelayMs,500,100,5000)
  };
}

async function storageIds(page,keys,scanAll,allowVisible,authRefreshPath=null){
  return page.evaluate(({keys,scanAll,allowVisible})=>{
    const ids=[];
    const extract=value=>value?.id??value?.user?.id??value?.state?.user?.id??value?.data?.id??value?.data?.user?.id??null;
    const read=(storage,key)=>{try{const raw=storage.getItem(key);if(key==='uid'&&/^\d{1,20}$/.test(String(raw??'')))ids.push(String(raw));const id=extract(JSON.parse(raw||'null'));if(/^\d{1,20}$/.test(String(id??'')))ids.push(String(id));}catch{}};
    for(const storage of [localStorage,sessionStorage]){
      if(scanAll){for(let index=0;index<storage.length;index+=1){const key=storage.key(index);if(key)read(storage,key);}}
      else for(const key of keys)read(storage,key);
    }
    if(allowVisible){const match=String(document.body?.innerText||'').match(/(?:ID|UID|用户(?:ID)?|會員(?:ID)?|会员(?:ID)?)\s*[:：#]?\s*(\d{1,20})/i);if(match)ids.push(match[1]);}
    return [...new Set(ids)];
  },{keys,scanAll,allowVisible,authRefreshPath});
}

function cacheFor(page,userId,origin,refreshPath){
  let cache=authCache.get(page);
  if(!cache||cache.userId!==String(userId)||cache.origin!==String(origin)||cache.refreshPath!==String(refreshPath??'')){cache={userId:String(userId),origin:String(origin),refreshPath:String(refreshPath??''),token:null,expiresAt:0,promise:null};authCache.set(page,cache);}
  return cache;
}

function invalidateAuthCache(page){const cache=authCache.get(page);if(cache){cache.token=null;cache.expiresAt=0;cache.promise=null;}}

async function refreshToken(context,{path,userId,origin}={}){
  const page=pageFor(context),cache=cacheFor(page,userId,origin,path),now=Date.now();
  if(cache.token&&cache.expiresAt>now+15_000)return {token:cache.token};
  if(cache.promise)return cache.promise;
  try{
    cache.promise=page.evaluate(async({path,userId,timeoutMs})=>{
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const response=await fetch(path,{method:'POST',credentials:'include',redirect:'error',headers:{Accept:'application/json'},signal:controller.signal});
        const body=await response.json().catch(()=>null),bundle=body?.data&&typeof body.data==='object'?body.data:body;
        const token=bundle?.access_token??bundle?.accessToken??bundle?.token??null,refreshId=bundle?.user?.id??bundle?.id??null;
        const expiresIn=Number(bundle?.expires_in??bundle?.expiresIn??body?.expires_in??body?.expiresIn);
        return {status:response.status,url:response.url,success:body?.success===true||bundle?.success===true,token:typeof token==='string'?token:'',refreshId:refreshId==null?null:String(refreshId),expiresIn};
      }catch(error){return {status:0,url:'',success:false,token:'',refreshId:null,networkError:true,timedOut:error?.name==='AbortError'};}
      finally{clearTimeout(timer);}
    },{path,userId:String(userId??''),timeoutMs:REQUEST_TIMEOUT_MS}).then(result=>{
      if(!responseMatchesOrigin(result,origin))return {response:{...result,crossOrigin:true}};
      if(result.refreshId!=null&&result.refreshId!==String(userId))return {response:{...result,identityMismatch:true}};
      if(result.status!==200||result.success!==true||!result.token||result.token.length>4096||/[\r\n]/.test(result.token))return {response:{status:result.status,url:result.url,networkError:result.networkError,timedOut:result.timedOut,authRefreshFailed:true}};
      const ttl=Number.isFinite(result.expiresIn)&&result.expiresIn>0?Math.max(30_000,Math.min(MAX_REFRESH_TTL_MS,result.expiresIn*1000)):DEFAULT_REFRESH_TTL_MS;
      cache.token=result.token;cache.expiresAt=Date.now()+ttl;return {token:result.token};
    }).catch(error=>({response:{status:0,url:'',networkError:true,error:safeShort(error?.message,80)}})).finally(()=>{cache.promise=null;});
    return await cache.promise;
  }catch(error){cache.promise=null;return {response:{status:0,url:'',networkError:true,error:safeShort(error?.message,80)}};}
}

async function requestInPage(context,{path,method='GET',userId,origin,authRefreshPath=null,allowRefresh=true,body=null}={}){
  const page=pageFor(context);
  let activeToken='';
  if(authRefreshPath){const refreshed=await refreshToken(context,{path:authRefreshPath,userId,origin});if(!refreshed?.token)return refreshed?.response??{status:0,url:'',body:null,networkError:true,authRefreshFailed:true};activeToken=refreshed.token;}
  const call=async bearer=>page.evaluate(async({path,method,userId,token,body})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
    try{const headers={Accept:'application/json','New-Api-User':String(userId??'')};if(token)headers.Authorization=`Bearer ${token}`;if(method!=='GET'&&body!=null)headers['Content-Type']='application/json';const response=await fetch(path,{method,credentials:'include',redirect:'error',headers,body:method==='GET'?undefined:(body==null?undefined:JSON.stringify(body)),signal:controller.signal});const text=await response.text();let parsedBody=null;try{parsedBody=JSON.parse(text);}catch{}return {status:response.status,url:response.url,body:parsedBody,text:text.slice(0,400)};}
    catch(error){return {status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}
    finally{clearTimeout(timer);}
  },{path,method,userId:String(userId??''),token:bearer,body});
  let response=await call(activeToken);
  if(allowRefresh&&authRefreshPath&&method==='GET'&&response?.status===401){invalidateAuthCache(page);const retry=await refreshToken(context,{path:authRefreshPath,userId,origin});if(retry?.token)response=await call(retry.token);}
  return response;
}

function identityResponse(response,expected,origin,ids){
  const user=userFrom(response?.body);
  if(response?.status!==200||!responseMatchesOrigin(response,origin)||(ids.length>0&&(ids.length!==1||ids[0]!==String(expected)))||user?.id==null||String(user.id)!==String(expected))return null;
  const username=user.username??user.name??user.display_name;
  return {userId:String(user.id),username:typeof username==='string'?username.slice(0,80):null,origin};
}

// Workers call this at an explicit profile/context boundary; tokens are never
// persisted and cannot bleed into the next account.
export function clearNewApiAuthCache(){authCache=new WeakMap();return true;}

export function createNewApiExecutionAdapter({origin,rule={}}={}){
  const siteOrigin=new URL(origin).origin,paths=ruleFor(siteOrigin,rule);
  return defineAdapter({id:'new-api.execute.v1',origin:siteOrigin,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context={}}={}){
      const expected=String(expectedIdentity??'');if(!/^\d{1,20}$/.test(expected))return null;
      const page=pageFor(context),rawIds=await storageIds(page,paths.userStorageKeys,paths.scanAllStorage,paths.allowVisibleIdentity,paths.authRefreshPath);
      // Keep compatibility with injected test/browser shims that return the
      // old combined {storageIds, body} probe shape.
      if(!Array.isArray(rawIds)&&rawIds?.body){
        return identityResponse(rawIds,expected,siteOrigin,Array.isArray(rawIds.storageIds)?rawIds.storageIds:[]);
      }
      const ids=Array.isArray(rawIds)?rawIds:(Array.isArray(rawIds?.storageIds)?rawIds.storageIds:[]);
      if(ids.some(id=>id!==expected))return null;
      if(paths.authRefreshPath){const response=await requestInPage(context,{path:paths.selfPath,userId:expected,origin:siteOrigin,authRefreshPath:paths.authRefreshPath});return identityResponse(response,expected,siteOrigin,ids);}
      const response=await page.evaluate(async({path,userId})=>{
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
        try{const result=await fetch(path,{credentials:'include',redirect:'error',headers:{Accept:'application/json','New-Api-User':userId},signal:controller.signal});return {status:result.status,url:result.url,body:await result.json().catch(()=>null)};}
        catch(error){return {status:0,url:'',body:null,networkError:true,timedOut:error?.name==='AbortError'};}
        finally{clearTimeout(timer);}
      },{path:paths.selfPath,userId:expected});
      return identityResponse(response,expected,siteOrigin,ids);
    },
    async read_status({identity,businessDate,context={}}={}){
      const userId=String(identity?.userId??'');if(!/^\d{1,20}$/.test(userId))return {state:'unknown',reason:'identity_missing'};
      const month=String(businessDate??'').slice(0,7),response=await requestInPage(context,{path:`${paths.statusPath}?month=${encodeURIComponent(month)}`,userId,origin:siteOrigin,authRefreshPath:paths.authRefreshPath});
      if(response?.authIdentityMismatch)return {state:'unknown',reason:'identity_mismatch'};
      if(!responseMatchesOrigin(response,siteOrigin))return {state:'unknown',reason:'cross_origin_redirect'};
      if(response?.status!==200)return {state:'unknown',reason:responseCause(response)};
      const payload=response.body?.data&&typeof response.body.data==='object'?response.body.data:response.body??{},stats=payload.stats??{},records=rowsFrom(response.body);
      if(payload.enabled===false||payload.checkin_enabled===false)return {state:'not_available',reason:'feature_disabled',evidence:{authoritative:true,source:'new_api_checkin_status',businessDate,accountId:userId,outcome:'message_not_enabled',confirmedAt:new Date().toISOString()}};
      if(response.body?.success===false||payload.success===false){
        const message=String(response.body?.message??payload.message??'');
        if(/未启用|未啟用|not enabled/i.test(message))return {state:'not_available',reason:'feature_disabled',evidence:{authoritative:true,source:'new_api_checkin_status',businessDate,accountId:userId,outcome:'message_not_enabled',confirmedAt:new Date().toISOString()}};
        return {state:'unknown',reason:'invalid_response'};
      }
      if(!Array.isArray(records))return {state:'unknown',reason:'invalid_response'};
      const today=records.filter(record=>dateInShanghai(record?.checkin_date??record?.checkinDate??record?.date??record?.created_at)===businessDate);
      if(today.some(record=>{const id=record?.user_id??record?.userId??record?.account_id??record?.accountId;return id!=null&&String(id)!==userId;}))return {state:'unknown',reason:'identity_mismatch'};
      const checked=booleanValue(stats.checked_in_today??stats.checkedInToday??payload.checked_in_today??payload.checkedInToday);
      const award=today.map(record=>record?.quota_awarded??record?.quotaAwarded??record?.reward??record?.amount).find(validQuotaAward);
      if(checked===true&&today.length>0){
        if(paths.requireReward&&!validQuotaAward(award))return {state:'unknown',reason:'reward_missing'};
        return {state:'already_done',evidence:{authoritative:true,source:'new_api_checkin_calendar',businessDate,accountId:userId,quotaAwarded:validQuotaAward(award)?Number(award):null,statusSignal:'checked_in_today'}};
      }
      if(checked===false&&today.length===0)return {state:'not_signed',evidence:{authoritative:true,source:'new_api_checkin_calendar',businessDate,accountId:userId,statusSignal:'not_checked_in'}};
      return {state:'unknown',reason:'calendar_date_contract_missing'};
    },
    async submit_once({identity,context={}}={}){
      const userId=String(identity?.userId??'');let response;
      try{response=await requestInPage(context,{path:paths.signInPath,method:'POST',userId,origin:siteOrigin,authRefreshPath:paths.authRefreshPath,allowRefresh:false});}catch{return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};}
      if(response?.authIdentityMismatch)return {state:'rejected',reason:'identity_mismatch',actionMayHaveHappened:false};
      if(!responseMatchesOrigin(response,siteOrigin))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
      const message=safeShort(response?.body?.message??response?.body?.msg??response?.text??'');
      if(response?.status===401)return {state:'rejected',reason:'auth_expired',actionMayHaveHappened:false};
      if(response?.status===403)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
      if(response?.status===429)return {state:'rejected',reason:'rate_limited',actionMayHaveHappened:false};
      if(response?.networkError||response?.status>=500)return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};
      const payload=response?.body?.data&&typeof response.body.data==='object'?response.body.data:response?.body??{},success=response?.body?.success===true||payload?.success===true;
      if(response?.status>=200&&response?.status<300&&!success)return {state:'unknown',reason:'submit_response_ambiguous',actionMayHaveHappened:true};
      if(response?.status>=200&&response?.status<300&&success){
        if(paths.responseSuccessText&&message&&!message.includes(paths.responseSuccessText)&&!paths.emptySuccessMeansAlreadySigned)return {state:'unknown',reason:'submit_response_ambiguous',actionMayHaveHappened:true};
        if(/验证码(?:错误|已失效)|驗證碼(?:錯誤|已失效)|captcha/i.test(message))return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
        return {state:'accepted',response:{status:response.status,message}};
      }
      if(/已签到|已簽到|already/i.test(message))return {state:'accepted',response:{status:response?.status,message}};
      return {state:'rejected',reason:responseCause(response),actionMayHaveHappened:false};
    },
    async verify({identity,businessDate,context={}}={}){
      for(let attempt=0;attempt<paths.verifyAttempts;attempt+=1){
        const status=await this.read_status({identity,businessDate,context});
        if(status.state==='already_done'){
          const final=await this.identity({expectedIdentity:String(identity?.userId??''),context});
          if(final?.userId===String(identity?.userId??'')&&final.origin===siteOrigin)return {state:'confirmed',evidence:status.evidence};
          return {state:'unknown',reason:'identity_mismatch'};
        }
        if(status.state==='unknown'&&!['calendar_date_contract_missing','reward_missing','unreachable'].includes(status.reason))return status;
        if(attempt<paths.verifyAttempts-1)await pageFor(context).waitForTimeout?.(paths.verifyDelayMs);
      }
      return {state:'unknown',reason:'submission_not_visible'};
    },
    classify_error(error){return responseCause({status:Number(error?.status)});}
  });
}

export async function requestNewApiAuthenticated(context,{origin,rule={},path,method='GET',userId,body=null,extraHeaders={}}={}){
  const siteOrigin=new URL(origin).origin,paths=ruleFor(siteOrigin,rule),url=new URL(path,siteOrigin);
  if(url.protocol!=='https:'||url.origin!==siteOrigin||url.username||url.password||url.hash)throw Error('invalid New API request endpoint');
  let token='';
  if(paths.authRefreshPath){const refreshed=await refreshToken(context,{path:paths.authRefreshPath,userId,origin:siteOrigin});if(!refreshed?.token)return refreshed?.response??{status:0,url:'',body:null,networkError:true,authRefreshFailed:true};token=refreshed.token;}
  return pageFor(context).evaluate(async({path,method,userId,token,body,extraHeaders})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
    try{
      const headers={Accept:'application/json','New-Api-User':String(userId??''),...(extraHeaders&&typeof extraHeaders==='object'?extraHeaders:{})};
      if(token)headers.Authorization=`Bearer ${token}`;if(method!=='GET'&&body!=null&&!headers['Content-Type'])headers['Content-Type']='application/json';
      const response=await fetch(path,{method,credentials:'include',redirect:'error',headers,body:method==='GET'?undefined:(body==null?undefined:JSON.stringify(body)),signal:controller.signal});
      const text=await response.text();let parsed=null;try{parsed=JSON.parse(text);}catch{}
      return {status:response.status,url:response.url,body:parsed,text:text.slice(0,400)};
    }catch(error){return {status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}
    finally{clearTimeout(timer);}
  },{path:url.pathname+url.search,method,userId:String(userId??''),token,body,extraHeaders});
}
