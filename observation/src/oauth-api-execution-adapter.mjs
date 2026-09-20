import {defineAdapter} from './adapter-contract.mjs';

const REQUEST_TIMEOUT_MS=15_000;

function pageFor(context){
  if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');
  return context.page;
}

function boundedInteger(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}

function endpoint(origin,value,fallback,name){
  const url=new URL(value||fallback,`${origin}/`);
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error(`invalid ${name} endpoint`);
  return `${url.pathname}${url.search}`;
}

function serviceOriginOf(site,rule){
  const service=new URL(rule.serviceOrigin||site);
  if(service.protocol!=='https:'||service.username||service.password||service.pathname!=='/'||service.search||service.hash)throw Error('invalid OAuth API service origin');
  if(service.origin!==site){
    const aliases=Array.isArray(rule.allowedServiceOrigins)?rule.allowedServiceOrigins.map(value=>{try{return new URL(String(value)).origin;}catch{return null;}}).filter(Boolean):[];
    if(!aliases.includes(service.origin))throw Error('OAuth API service origin is not allowlisted');
  }
  return service.origin;
}

function responseMatchesOrigin(response,origin){if(!response?.url)return true;try{return new URL(response.url).origin===origin;}catch{return false;}}

function responseCause(response){
  if(response?.status===401)return'auth_expired';if(response?.status===403)return'challenge_required';if(response?.status===429)return'rate_limited';if(!response?.status||response.status>=500)return'unreachable';return'invalid_response';
}
function booleanValue(value){if(value===true||value===false)return value;if(value===1||value==='1'||(typeof value==='string'&&value.toLowerCase()==='true'))return true;if(value===0||value==='0'||(typeof value==='string'&&value.toLowerCase()==='false'))return false;return null;}

function dateValue(value){
  if(value==null)return null;const text=String(value).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(text)){const [year,month,day]=text.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day)return text;return null;}
  const numeric=Number(value);if(Number.isFinite(numeric)){const date=new Date(numeric>10_000_000_000?numeric:numeric*1000);if(Number.isFinite(date.getTime()))return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(date);}
  const parsed=Date.parse(text);return Number.isFinite(parsed)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(parsed)):null;
}

function payloadOf(body){return body?.data&&typeof body.data==='object'?body.data:body??{};}
function idOf(value){return value?.id??value?.user_id??value?.user?.id??value?.data?.id??value?.data?.user?.id??null;}
function recordsOf(body){
  const payload=payloadOf(body),sources=[payload,payload?.data,payload?.result].filter(value=>value&&typeof value==='object'),values=sources.flatMap(value=>[value.records,value.items,value.list,value.history,value.today_record?[value.today_record]:null,value.todayRecord?[value.todayRecord]:null,value.record?[value.record]:null]);
  return values.flatMap(value=>Array.isArray(value)?value:[]);
}

function identityKeys(rule){
  const raw=rule.userStorageKeys??['user','current_user'];
  if(!Array.isArray(raw)||raw.length>12||raw.some(key=>typeof key!=='string'||!key.trim()||key.length>100||/[\r\n]/.test(key)))throw Error('invalid OAuth API userStorageKeys');
  return [...new Set(raw.map(key=>key.trim()))];
}

async function ensureServicePage(context,service,pagePath){
  const page=pageFor(context);let current='';try{current=new URL(page.url()).origin;}catch{}
  if(current!==service){try{await page.goto(new URL(pagePath,`${service}/`).href,{waitUntil:'domcontentloaded',timeout:20_000});}catch{return null;}}
  try{return new URL(page.url()).origin===service?page:null;}catch{return null;}
}

async function request(context,{url,method='GET',headers={},body=null}={}){
  return pageFor(context).evaluate(async({url,method,headers,body,timeoutMs})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{const response=await fetch(url,{method,credentials:'include',redirect:'error',headers,body,signal:controller.signal});const text=await response.text();let parsed=null;try{parsed=JSON.parse(text);}catch{}return {status:response.status,url:response.url,body:parsed,text:text.slice(0,500)};}
    catch(error){return {status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}
    finally{clearTimeout(timer);}
  },{url,method,headers,body,timeoutMs:REQUEST_TIMEOUT_MS});
}

function userIdFromStorage(page,keys,scanAll){
  return page.evaluate(({keys,scanAll})=>{
    const ids=[],extract=value=>value?.id??value?.user_id??value?.user?.id??value?.state?.user?.id??value?.data?.id??value?.data?.user?.id??null;
    const read=(storage,key)=>{try{const raw=storage.getItem(key),id=extract(JSON.parse(raw||'null'));if(/^\d{1,20}$/.test(String(id??'')))ids.push(String(id));if(key==='uid'&&/^\d{1,20}$/.test(String(raw??'')))ids.push(String(raw));}catch{}};
    for(const storage of [localStorage,sessionStorage]){if(scanAll){for(let index=0;index<storage.length;index+=1){const key=storage.key(index);if(key)read(storage,key);}}else for(const key of keys)read(storage,key);}
    return [...new Set(ids)];
  },{keys,scanAll}).then(result=>Array.isArray(result)?result:(Array.isArray(result?.ids)?result.ids:Array.isArray(result?.storageIds)?result.storageIds:[]));
}

export function createOAuthApiExecutionAdapter({origin,rule={}}={}){
  const site=new URL(origin).origin,service=serviceOriginOf(site,rule),pagePath=endpoint(service,rule.pagePath,'/','page'),identityPath=endpoint(service,rule.identityPath,'/api/user/self','identity'),statusPath=endpoint(service,rule.statusPath,'/api/checkin/status','status'),actionPath=endpoint(service,rule.actionPath,'/api/checkin/spin','action');
  const identityHeader=String(rule.userIdHeader||'New-Api-User').trim();if(!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(identityHeader))throw Error('invalid OAuth API identity header');
  const actionBody=typeof rule.actionBody==='string'?rule.actionBody:'{}';
  if(actionBody.length>2000||/[\r\n]/.test(actionBody))throw Error('invalid OAuth API action body');
  const keys=identityKeys(rule),scanAll=rule.scanAllStorage===true,allowUndatedFalse=rule.allowUndatedCanSpinFalse===true,verifyAttempts=boundedInteger(rule.verifyAttempts,4,1,6),verifyDelayMs=boundedInteger(rule.verifyDelayMs,500,100,5000);

  async function readIdentity(context,expectedIdentity){
    const expected=String(expectedIdentity??'');if(!/^\d{1,20}$/.test(expected))return null;const page=await ensureServicePage(context,service,pagePath);if(!page)return null;
    let ids=[];try{ids=await userIdFromStorage(page,keys,scanAll);}catch{}
    if(ids.some(id=>id!==expected))return null;
    const response=await request(context,{url:new URL(identityPath,`${service}/`).href,headers:{Accept:'application/json',[identityHeader]:expected}});
    const user=response?.body?.data?.user??response?.body?.data??response?.body?.user??null;
    if(response?.status!==200||!responseMatchesOrigin(response,service)||String(idOf(user??response?.body)??'')!==expected)return null;
    const username=user?.username??user?.name??user?.display_name;return {userId:expected,username:typeof username==='string'?username.slice(0,80):null,origin:site};
  }

  async function readStatus(context,identity,businessDate){
    const page=await ensureServicePage(context,service,pagePath);if(!page)return {state:'unknown',reason:'service_origin_unavailable'};
    const response=await request(context,{url:new URL(statusPath,`${service}/`).href,headers:{Accept:'application/json',[identityHeader]:String(identity?.userId??'')}});
    if(!responseMatchesOrigin(response,service))return {state:'unknown',reason:'cross_origin_redirect'};
    if(response?.status!==200||response.networkError)return {state:'unknown',reason:responseCause(response)};
    const body=response.body,payload=payloadOf(body);if(body?.success===false||payload?.success===false)return {state:'unknown',reason:'status_rejected'};
    const records=recordsOf(body),today=records.filter(record=>dateValue(record?.spin_date??record?.spinDate??record?.checkin_date??record?.checkinDate??record?.date??record?.created_at)===businessDate);
    if(today.some(record=>{const id=record?.user_id??record?.userId??record?.linux_do_id??record?.account_id??record?.accountId;return id!=null&&String(id)!==String(identity?.userId);})){return {state:'unknown',reason:'identity_mismatch'};}
    const checked=booleanValue(payload?.checked_in_today??payload?.checkedInToday??payload?.stats?.checked_in_today??payload?.stats?.checkedInToday);
    const canSpin=booleanValue(payload?.can_spin??payload?.canSpin);
    const spinDate=dateValue(payload?.spin_date??payload?.spinDate??payload?.last_spin_date??payload?.lastSpinDate);
    const balance=Number(payload?.new_balance??payload?.current_balance??payload?.balance??payload?.quota),reward=Number(payload?.reward??payload?.reward_quota??payload?.quota_awarded);
    if((checked===true&&today.length>0)||(canSpin===false&&today.length>0))return {state:'already_done',evidence:{authoritative:true,source:'oauth_api_status',businessDate,accountId:String(identity?.userId),recordDate:businessDate,balance:Number.isFinite(balance)?balance:null}};
    if(canSpin===true||checked===false&&today.length===0)return {state:'not_signed',evidence:{authoritative:true,source:'oauth_api_status',businessDate,accountId:String(identity?.userId),statusSignal:canSpin===true?'can_spin':'checked_false'}};
    if(canSpin===false&&(spinDate===businessDate||allowUndatedFalse))return {state:'already_done',evidence:{authoritative:true,source:'oauth_api_status',businessDate,accountId:String(identity?.userId),recordDate:spinDate??businessDate,balance:Number.isFinite(balance)?balance:null}};
    return {state:'unknown',reason:'status_date_contract_missing'};
  }

  const adapter=defineAdapter({id:'oauth-api.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context}={}){return readIdentity(context,expectedIdentity);},
    async read_status({identity,businessDate,context}={}){return readStatus(context,identity,businessDate);},
    async submit_once({identity,context}={}){
      const page=await ensureServicePage(context,service,pagePath);if(!page)return {state:'rejected',reason:'service_origin_unavailable',actionMayHaveHappened:false};
      const response=await request(context,{url:new URL(actionPath,`${service}/`).href,method:'POST',headers:{Accept:'application/json',[identityHeader]:String(identity?.userId??''),'Content-Type':'application/json'},body:actionBody});
      if(!responseMatchesOrigin(response,service))return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};
      if(response?.networkError||response?.status>=500)return {state:'unknown',reason:'submit_transport_unknown',actionMayHaveHappened:true};
      if(response?.status===401)return {state:'rejected',reason:'auth_expired',actionMayHaveHappened:false};
      if(response?.status===403)return {state:'rejected',reason:'challenge_required',actionMayHaveHappened:false};
      if(response?.status===429)return {state:'rejected',reason:'rate_limited',actionMayHaveHappened:false};
      const payload=payloadOf(response.body),message=String(response.body?.message??payload?.message??'').replace(/[\r\n\t]+/g,' ').slice(0,180),success=response.body?.success===true||payload?.success===true;
      if(response?.status>=200&&response?.status<300&&(success||/已签到|已簽到|already|成功/i.test(message)))return {state:'accepted',response:{status:response.status,message}};
      if(response?.status>=200&&response?.status<300)return {state:'unknown',reason:'submit_response_ambiguous',actionMayHaveHappened:true};
      return {state:'rejected',reason:'invalid_response',actionMayHaveHappened:false};
    },
    async verify({identity,businessDate,context}={}){
      for(let attempt=0;attempt<verifyAttempts;attempt+=1){const status=await readStatus(context,identity,businessDate);if(status.state==='already_done'){const final=await readIdentity(context,String(identity?.userId??''));if(final?.userId!==String(identity?.userId??''))return {state:'unknown',reason:'identity_mismatch'};return {state:'confirmed',evidence:status.evidence};}if(status.state==='unknown'&&!['status_date_contract_missing','unreachable'].includes(status.reason))return status;if(attempt<verifyAttempts-1)await pageFor(context).waitForTimeout?.(verifyDelayMs);}
      return {state:'unknown',reason:'submission_not_visible'};
    },
    classify_error(error){return responseCause({status:Number(error?.status)});}
  });
  return adapter;
}
