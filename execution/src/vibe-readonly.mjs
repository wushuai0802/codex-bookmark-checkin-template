const origin='https://new.sharedchat.cc';
const safePaths=new Set(['/list/','/frontend-api/getme','/frontend-api/vibe-code/quota']);

export function classifyVibeReadOnly(identity,quota,now=new Date()){
  if(identity?.code!==1||!/^\d{1,32}$/.test(String(identity.data?.id??''))||quota?.code!==1)return null;
  const subscription=quota.data?.codex?.subscriptions,expires=Date.parse(subscription?.expireTime??'');
  const expired=subscription?.isActive===false&&Number.isFinite(expires)&&expires<now.getTime();
  const expiry=expired?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(expires)):null;
  // An expired or active subscription is not a dated daily claim receipt.
  // Do not clear the old submission quarantine from either observation.
  return {reason:expired?`只读接口确认 Codex 权益已于 ${expiry} 过期；未提供今日领取回执，历史提交仍待核验`:
    subscription?.isActive===true?'只读接口显示套餐有效，但未提供今日领取回执；历史提交仍待核验':
    '账号已登录，但只读接口未提供今日领取回执；历史提交仍待核验',
    evidence:{source:'vibe_entitlement_status',authoritative:false,accountId:String(identity.data.id),
      confirmedAt:now.toISOString(),businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),
      statusSignal:expired?'expired_subscription':'daily_claim_unverified',dailyRewardVerified:false,
      ...(expiry?{entitlementExpiresOn:expiry}:{})}};
}

export async function observePendingVibeClaim(config,{launch,now=()=>new Date()}={}){
  let context;
  try{
    context=await launch({...config,ptPassiveReadOnly:true});
    await context.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url());
      return request.method()==='GET'&&url.origin===origin&&safePaths.has(url.pathname)&&!url.search
        ?route.continue():route.abort('blockedbyclient');
    });
    const page=await context.newPage();
    await page.goto(origin+'/list/',{waitUntil:'domcontentloaded',timeout:15000});
    const values=await page.evaluate(async()=>{
      const read=async endpoint=>{
        const response=await fetch(endpoint,{method:'GET',credentials:'include',redirect:'error',signal:AbortSignal.timeout(8000)});
        if(response.status!==200)return null;
        return response.json();
      };
      const me=await read('/frontend-api/getme');
      if(me?.code!==1)return null;
      const quota=await read('/frontend-api/vibe-code/quota');
      return {identity:{code:me.code,data:{id:me.data?.id}},quota:{code:quota?.code,data:{codex:{subscriptions:quota?.data?.codex?.subscriptions?
        {isActive:quota.data.codex.subscriptions.isActive,expireTime:quota.data.codex.subscriptions.expireTime}:null}}}};
    });
    return values?classifyVibeReadOnly(values.identity,values.quota,now()):null;
  }catch{return null;}
  finally{await context?.close().catch(()=>{});}
}
