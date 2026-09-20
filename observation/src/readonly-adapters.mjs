import {shortLabel} from './display-identity.mjs';
import {shanghaiDate} from './freshness.mjs';

const paths={
  'new-api':['/api/user/self','/api/user/checkin'],
  'reward-log':['/api/user/self','/api/log/self'],
  'linuxdo-wheel':['/api/user/info','/api/checkin/status'],
  'vibe-entitlement':['/frontend-api/getme','/frontend-api/vibe-code/quota']
};
export function readCapabilities(family){
  if(!paths[family])throw Error('unknown read-only adapter');
  return {id:`readonly.${family}.v1`,mode:'observe_only',methods:['GET'],paths:[...paths[family]],canSubmit:false,canRecoverLogin:false};
}
export function validateReadRequest(family,origin,endpoint,method='GET'){
  const url=new URL(endpoint,origin);
  if(method!=='GET'||url.origin!==origin||url.protocol!=='https:'||url.username||url.password||!readCapabilities(family).paths.includes(url.pathname))throw Error('read-only capability denied');
  return url;
}
const failure=(response)=>{
  if(response?.status===429)return 'rate_limit';
  if(response?.status===401)return 'login_required';
  if(response?.status===403)return 'access_challenge';
  if(response?.status===404)return 'platform_or_endpoint_changed';
  if(!response?.status||response.status>=500)return 'upstream_unavailable';
  return 'unsupported_response';
};
export async function observeAccount({family,origin,expectedId,request,now=new Date().toISOString(),rewardText,rewardAmount=25,logType=1}){
  readCapabilities(family);
  const start=Date.now(),day=shanghaiDate(now);
  const base={schemaVersion:1,adapter:`readonly.${family}.v1`,mode:'observe_only',origin,businessDate:day,observedAt:now,mutationCount:0};
  let identity=null,requests=0;
  const done=(status,cause,evidence=null)=>({...base,status,cause,identity,evidence,requestCount:requests,durationMs:Date.now()-start});
  const get=async endpoint=>{
    const url=validateReadRequest(family,origin,endpoint);requests++;
    try{return await request(url.pathname+url.search,{method:'GET',headers:{Accept:'application/json',...(expectedId?{'New-Api-User':String(expectedId)}:{})}});}
    catch{return {status:0,body:null};}
  };
  if(!expectedId||!/^\d{1,20}$/.test(String(expectedId)))return done('unknown','expected_identity_missing');
  const identityPath=paths[family][0],self=await get(identityPath);
  if(self.status!==200)return done('unknown',failure(self));
  let user;
  if(family==='linuxdo-wheel'&&self.body?.success===true)user={id:self.body.linux_do_id,username:self.body.username};
  else if(family==='vibe-entitlement'&&self.body?.code===1)user=self.body.data;
  else if(self.body?.success===true)user=self.body.data?.user??self.body.data;
  if(user?.id==null)return done('unknown','unsupported_identity_response');
  if(String(user.id)!==String(expectedId))return done('unknown','identity_mismatch');
  identity={userId:String(user.id),username:shortLabel(user.username??user.name),idKind:family==='linuxdo-wheel'?'linuxdo':'site',verified:true};
  const proof=(source,extra={})=>({source,authoritative:true,userId:identity.userId,businessDate:day,observedAt:now,...extra});
  if(family==='new-api'){
    const response=await get(`/api/user/checkin?month=${day.slice(0,7)}`),body=response.body;
    if(response.status!==200)return done('unknown',failure(response));
    if(body?.success===false&&/未启用|未開啟|未开启|not enabled/i.test(body.message??''))return done('not_available','feature_disabled',proof('new_api_checkin_status'));
    if(body?.success!==true)return done('unknown','unsupported_status_response');
    if(body.data?.enabled===false)return done('not_available','feature_disabled',proof('new_api_checkin_status'));
    const stats=body.data?.stats,records=stats?.records;
    if(!Array.isArray(records))return done('unknown','calendar_missing');
    const today=records.filter(record=>record.checkin_date===day);
    if(today.some(record=>record.user_id!=null&&String(record.user_id)!==String(expectedId)))return done('unknown','calendar_identity_conflict');
    if(stats.checked_in_today===true&&today.some(record=>record.quota_awarded!=null&&Number.isFinite(Number(record.quota_awarded))&&Number(record.quota_awarded)>=0))return done('signed',null,proof('new_api_checkin_calendar'));
    if(stats.checked_in_today===false&&today.length===0)return done('not_signed',null,proof('new_api_checkin_calendar'));
    return done('unknown','calendar_inconsistent');
  }
  if(family==='reward-log'){
    if(!rewardText||!Number.isFinite(rewardAmount)||rewardAmount<=0)return done('unknown','reward_rule_missing');
    const from=Date.parse(`${day}T00:00:00+08:00`)/1000,to=from+86400;
    for(let page=0;page<3;page++){
      const response=await get(`/api/log/self?p=${page}&page_size=100&type=${logType}&start_timestamp=${from}&end_timestamp=${to}`);
      if(response.status!==200)return done('unknown',failure(response));
      const items=response.body?.data?.items;
      if(response.body?.success!==true||!Array.isArray(items))return done('unknown','reward_log_missing');
      const matching=items.find(item=>{
        const stamp=Number(item.created_at),amount=Number(String(item.content??'').match(/(?:增加额度|新增额度|获得额度)\s*[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]);
        return stamp>=from&&stamp<to&&stamp<=Date.parse(now)/1000&&Number(item.type)===logType
          &&(item.user_id==null||String(item.user_id)===String(expectedId))&&String(item.content??'').includes(rewardText)&&Math.abs(amount-rewardAmount)<0.000001;
      });
      if(matching)return done('signed',null,proof('usage_log',{eventAt:new Date(Number(matching.created_at)*1000).toISOString()}));
      if(items.length<100)return done('unknown','reward_not_found');
    }
    return done('unknown','reward_scan_limit');
  }
  if(family==='linuxdo-wheel'){
    const response=await get('/api/checkin/status');if(response.status!==200)return done('unknown',failure(response));
    const body=response.body;if(body?.success!==true)return done('unknown','unsupported_status_response');
    // Do not infer success from can_spin=false: it can mean disabled/locked.
    const record=body.today_record;
    const recordDay=record?.spin_date??record?.checkin_date??record?.date;
    if(record&&recordDay===day&&(record.linux_do_id==null||String(record.linux_do_id)===String(expectedId)))return done('signed',null,proof('wheel_today_record'));
    return done('unknown',record?'wheel_date_contract_missing':'wheel_record_missing');
  }
  const response=await get('/frontend-api/vibe-code/quota');if(response.status!==200)return done('unknown',failure(response));
  const codex=response.body?.data?.codex,subscription=codex?.subscriptions;
  if(response.body?.code!==1||codex?.isAuth!==true||!subscription)return done('unknown','entitlement_contract_review');
  const expires=Date.parse(subscription.expireTime);
  if(subscription.isActive===true&&Number.isFinite(expires)&&expires>Date.parse(now)){
    // Valid entitlement is NOT proof that a daily sign-in happened now.
    return done('entitlement_active',null,proof('current_entitlement',{expiresAt:new Date(expires).toISOString(),dailyRewardVerified:false}));
  }
  return done('unknown','entitlement_inactive_or_expired');
}
