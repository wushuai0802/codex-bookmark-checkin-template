import {defineAdapter} from './adapter-contract.mjs';

const REQUEST_TIMEOUT_MS=15_000;

function pageFor(context){if(!context?.page||typeof context.page.evaluate!=='function')throw Error('isolated page is required');return context.page;}
function endpoint(origin,value,fallback,name){const url=new URL(value||fallback,origin);if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password||url.hash)throw Error(`invalid ${name} endpoint`);return `${url.pathname}${url.search}`;}
function boundedInteger(value,fallback,min,max){const number=Number(value);return Number.isInteger(number)?Math.max(min,Math.min(max,number)):fallback;}
function payloadOf(body){return body?.data&&typeof body.data==='object'?body.data:body??{};}
function idOf(value){return value?.id??value?.uid??value?.user_id??value?.user?.id??value?.data?.id??value?.data?.user?.id??null;}
function dateValue(value){if(value==null)return null;const text=String(value).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(text)){const [year,month,day]=text.split('-').map(Number),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day)return text;return null;}const n=Number(value);if(Number.isFinite(n)){const d=new Date(n>10_000_000_000?n:n*1000);if(Number.isFinite(d.getTime()))return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(d);}const parsed=Date.parse(text);return Number.isFinite(parsed)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(parsed)):null;}
function responseCause(response){if(response?.status===401)return'auth_expired';if(response?.status===403)return'challenge_required';if(response?.status===429)return'rate_limited';if(!response?.status||response.status>=500)return'unreachable';return'invalid_response';}
function sameOrigin(response,origin){if(!response?.url)return true;try{return new URL(response.url).origin===origin;}catch{return false;}}
function selectorList(value,fallback){const list=value==null?fallback:Array.isArray(value)?value:[value];if(list.length>12||list.some(item=>typeof item!=='string'||!item.trim()||item.length>300||/[\r\n]/.test(item)))throw Error('invalid Vibe selectors');return [...new Set(list.map(item=>item.trim()))];}
function booleanValue(value){if(value===true||value===false)return value;if(value===1||value==='1'||(typeof value==='string'&&value.toLowerCase()==='true'))return true;if(value===0||value==='0'||(typeof value==='string'&&value.toLowerCase()==='false'))return false;return null;}

async function request(context,path,options={}){return pageFor(context).evaluate(async({path,options,timeoutMs})=>{const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);try{const response=await fetch(path,{credentials:'include',redirect:'error',...options,headers:{Accept:'application/json',...(options.headers||{})},signal:controller.signal});const text=await response.text();let body=null;try{body=JSON.parse(text);}catch{}return {status:response.status,url:response.url,body,text:text.slice(0,400)};}catch(error){return {status:0,url:'',body:null,text:'',networkError:true,timedOut:error?.name==='AbortError'};}finally{clearTimeout(timer);}}, {path,options,timeoutMs:REQUEST_TIMEOUT_MS});}

function entitlement(payload,now){
  const codex=payload?.codex??payload?.entitlement??payload,subscriptions=codex?.subscriptions??codex?.subscription??payload?.subscriptions;
  if(codex?.isAuth===false||codex?.authenticated===false)return null;
  const list=Array.isArray(subscriptions)?subscriptions:(subscriptions?[subscriptions]:[]),item=list.find(value=>/codex/i.test(String(value?.name??value?.title??value?.plan??' ')))??list[0];
  if(!item)return null;const activeFlag=item.isActive??item.active??item.enabled;const expires=item.expireTime??item.expire_time??item.expiresAt??item.expires_at??item.endTime??item.end_time;const numericExpires=Number(expires),expiresMs=Number.isFinite(numericExpires)?(numericExpires>10_000_000_000?numericExpires:numericExpires*1000):Date.parse(String(expires??''));
  return {active:(booleanValue(activeFlag)===true||activeFlag==null)&&Number.isFinite(expiresMs)&&expiresMs>now,expiresMs};
}

function claimInfo(payload,businessDate){
  const date=dateValue(payload?.claim_date??payload?.claimDate??payload?.daily_claim_date??payload?.dailyClaimDate??payload?.last_claim_date??payload?.lastClaimDate??payload?.checkin_date??payload?.checkinDate);
  const claimed=payload?.daily_claimed??payload?.dailyClaimed??payload?.claimed_today??payload?.claimedToday??payload?.has_claimed_today??payload?.hasClaimedToday;
  const canClaim=payload?.can_claim??payload?.canClaim??payload?.claimable??payload?.canRequest;
  return {date,claimed:booleanValue(claimed)===true||date===businessDate,canClaim:booleanValue(canClaim)===true};
}

export function createVibeEntitlementExecutionAdapter({origin,rule={}}={}){
  const site=new URL(origin).origin,identityPath=endpoint(site,rule.identityPath,'/frontend-api/getme','identity'),statusPath=endpoint(site,rule.statusPath,'/frontend-api/vibe-code/quota','status'),pagePath=endpoint(site,rule.pagePath,'/list/','page'),claimStatusPath=rule.claimStatusPath?endpoint(site,rule.claimStatusPath,'/frontend-api/vibe-code/claim/status','claim status'):null;
  const claimEnabled=rule.claimEnabled===true,minimumReasonLength=Math.max(10,Math.min(240,Number(rule.minimumReasonLength)||10)),verifyAttempts=boundedInteger(rule.verifyAttempts,3,1,5),verifyDelayMs=boundedInteger(rule.verifyDelayMs,500,100,5000),claimSelectors=selectorList(rule.claimSelectors,['button','[role="button"]','a']),submitSelectors=selectorList(rule.submitSelectors,['button','[role="button"]']);
  const reasonFor=(day)=>String(rule.reason||'{date}正常使用服务，申请额度用于开发测试和日常体验，谢谢。').replaceAll('{date}',day);

  async function identity(context,expected){
    const id=String(expected??'');if(!/^\d{1,20}$/.test(id))return null;const response=await request(context,identityPath);if(!sameOrigin(response,site)||response?.status!==200)return null;const body=response.body,payload=payloadOf(body),user=payload?.user??payload;if(!((Number(body?.code)===1||body?.success===true||Number(payload?.code)===1)&&String(idOf(user??body)??'')===id))return null;const username=user?.name??user?.username??user?.nickname;return {userId:id,username:typeof username==='string'?username.slice(0,80):null,origin:site};
  }

  async function readStatus(context,identityValue,businessDate){
    const response=await request(context,statusPath);if(!sameOrigin(response,site))return {state:'unknown',reason:'cross_origin_redirect'};if(response?.status!==200||response.networkError)return {state:'unknown',reason:responseCause(response)};const body=response.body,payload=payloadOf(body);if(body?.code!=null&&Number(body.code)!==1&&body?.success!==true)return {state:'unknown',reason:'entitlement_contract_missing'};
    let claim=claimInfo(payload,businessDate);if(claimStatusPath){const extra=await request(context,claimStatusPath);if(extra?.status===401||extra?.status===403)return {state:'unknown',reason:'auth_expired'};if(extra?.status===200&&sameOrigin(extra,site)){const extraPayload=payloadOf(extra.body),extraClaim=claimInfo(extraPayload,businessDate);claim={date:extraClaim.date??claim.date,claimed:extraClaim.claimed||claim.claimed,canClaim:extraClaim.canClaim||claim.canClaim};}}
    const statusId=idOf(payload?.user??payload?.account??payload);
    if(statusId!=null&&String(statusId)!==String(identityValue?.userId??''))return {state:'unknown',reason:'identity_mismatch'};
    const now=Number.isFinite(Date.parse(context?.now))?Date.parse(context.now):Date.now();const entitlementState=entitlement(payload,now);
    if(claim.claimed)return {state:'already_done',evidence:{authoritative:true,source:'vibe_entitlement_status',businessDate,accountId:String(identityValue?.userId??''),claimDate:claim.date??businessDate,dailyRewardVerified:true}};
    if(claim.canClaim&&claimEnabled)return {state:'not_signed',evidence:{authoritative:true,source:'vibe_entitlement_status',businessDate,accountId:String(identityValue?.userId??''),statusSignal:'can_claim',dailyRewardVerified:false}};
    if(entitlementState?.active)return {state:'not_available',reason:'entitlement_active_not_daily_checkin',evidence:{authoritative:true,source:'vibe_entitlement_status',businessDate,accountId:String(identityValue?.userId??''),outcome:'entitlement_active',expiresAt:new Date(entitlementState.expiresMs).toISOString(),dailyRewardVerified:false}};
    if(!claimEnabled)return {state:'not_available',reason:'claim_not_enabled',evidence:{authoritative:true,source:'vibe_entitlement_status',businessDate,accountId:String(identityValue?.userId??''),outcome:'claim_not_configured',dailyRewardVerified:false}};
    return {state:'unknown',reason:'claim_state_not_proven'};
  }

  async function submitOnce(context,businessDate){
    if(!claimEnabled)return {state:'rejected',reason:'claim_not_enabled',actionMayHaveHappened:false};const page=pageFor(context);try{await page.goto(new URL(pagePath,`${site}/`).href,{waitUntil:'domcontentloaded',timeout:20_000});}catch{return {state:'unknown',reason:'claim_page_unavailable',actionMayHaveHappened:false};}
    try{if(new URL(page.url()).origin!==site)return {state:'rejected',reason:'cross_origin_redirect',actionMayHaveHappened:false};}catch{return {state:'rejected',reason:'invalid_page_origin',actionMayHaveHappened:false};}
    const labels=['领取 Codex 权益','领取Codex权益','领取权益','申请额度','Claim Codex entitlement'];let claim=null;
    for(const selector of claimSelectors){try{const candidates=page.locator(selector),count=await candidates.count();for(let index=0;index<count;index+=1){const item=candidates.nth(index),text=String(await item.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();if(await item.isVisible().catch(()=>false)&&(/领取|領取|申请额度|申請額度|codex.*entitlement/i.test(text)||!['button','[role="button"]','a'].includes(selector))){claim=item;break;}}}catch{}if(claim)break;}
    if(!claim)for(const label of labels){const candidate=page.getByRole?.('button',{name:label,exact:true});if(candidate&&await candidate.count().catch(()=>0)===1&&await candidate.isVisible().catch(()=>false)){claim=candidate;break;}}
    if(!claim)return {state:'rejected',reason:'claim_button_missing',actionMayHaveHappened:false};try{await claim.click({timeout:10_000});}catch{return {state:'unknown',reason:'claim_button_click_failed',actionMayHaveHappened:true};}
    await page.waitForTimeout?.(300);const fields=page.locator('textarea:visible,input[name*="reason" i]:visible,input[name*="remark" i]:visible,input[name*="message" i]:visible,input[placeholder*="理由" i]:visible');if(await fields.count()!==1)return {state:'unknown',reason:'claim_reason_field_missing',actionMayHaveHappened:true};const reason=reasonFor(businessDate);if([...reason].length<minimumReasonLength)return {state:'rejected',reason:'claim_reason_too_short',actionMayHaveHappened:false};await fields.fill(reason);
    let submit=null;for(const selector of submitSelectors){try{const candidates=page.locator(selector),count=await candidates.count();for(let index=0;index<count;index+=1){const item=candidates.nth(index),text=String(await item.innerText().catch(()=>'' )).replace(/\s+/g,' ').trim();if(await item.isVisible().catch(()=>false)&&/领取|領取|提交申请|确认|確認|claim|submit/i.test(text)){submit=item;break;}}}catch{}if(submit)break;}
    if(!submit){const candidate=page.getByRole?.('button',{name:/^(?:领取|領取|提交申请|确认申请|确认提交|提交|确认|Claim)$/i});if(candidate&&await candidate.count().catch(()=>0)===1&&await candidate.isVisible().catch(()=>false))submit=candidate;}
    if(!submit)return {state:'unknown',reason:'claim_submit_button_missing',actionMayHaveHappened:true};try{await submit.click({timeout:10_000});}catch{return {state:'unknown',reason:'claim_submit_failed',actionMayHaveHappened:true};}await page.waitForTimeout?.(1000);const text=String(await page.locator('body').innerText().catch(()=>''));if(/申请成功|领取成功|额度已发放|今日已申请|successfully claimed/i.test(text))return {state:'accepted'};return {state:'unknown',reason:'claim_result_unconfirmed',actionMayHaveHappened:true};
  }

  return defineAdapter({id:'vibe-entitlement.execute.v1',origin:site,capabilities:['identity','read_status','submit_once','verify','classify_error'],
    async identity({expectedIdentity,context}={}){return identity(context,expectedIdentity);},
    async read_status({identity,businessDate,context}={}){return readStatus(context,identity,businessDate);},
    async submit_once({businessDate,context}={}){return submitOnce(context,businessDate);},
    async verify({identity,businessDate,context}={}){for(let attempt=0;attempt<verifyAttempts;attempt+=1){const status=await readStatus(context,identity,businessDate);if(status.state==='already_done')return {state:'confirmed',evidence:status.evidence};if(status.state==='not_available')return status;if(status.state==='unknown'&&!['claim_state_not_proven','unreachable'].includes(status.reason))return status;if(attempt<verifyAttempts-1)await pageFor(context).waitForTimeout?.(verifyDelayMs);}return {state:'unknown',reason:'claim_not_visible'};},
    classify_error(error){const status=Number(error?.status),text=String(error?.message??error);if(status===401)return'auth_expired';if(status===403||/captcha|验证|驗證|challenge/i.test(text))return'challenge_required';if(status===429||/429|rate/i.test(text))return'rate_limited';if(status>=500||!status)return'unreachable';return'unknown';}
  });
}
