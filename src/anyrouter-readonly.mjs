import {resolveDynamicOriginRoutes} from './origin-routing.mjs';
import {configuredNewApiSignInRule} from './new-api-signin.mjs';
import {requestWithChallenge,parseJson,cookieJar} from './anyrouter-api-checkin.mjs';
export async function observeAnyRouter(page,config={},requestedOrigin='https://anyrouter.top'){
 const origin=new URL(requestedOrigin).origin,rule=configuredNewApiSignInRule(origin,config);if(!rule)return {status:'unknown',cause:'rule_missing',mutationCount:0};
 const routes=await resolveDynamicOriginRoutes(config,{origins:[origin]});if(!routes.length)return {status:'unknown',cause:'dynamic_route_unavailable',mutationCount:0};
 const policy={timeoutMs:10000},jar=cookieJar(await page.context().cookies(origin));
 const configured=String(config.anyRouterUserId??config.anyRouterUserIds?.[origin]??'');
 if(!/^\d+$/.test(configured))return {status:'unknown',cause:'expected_identity_missing',mutationCount:0};
 const route=routes[0],headers={'New-Api-User':configured};
 const self=await requestWithChallenge(route.address,'anyrouter.top','/api/user/self',{requestHeaders:headers},policy,jar),body=parseJson(self),id=String(body?.data?.id??'');
 if(self.status!==200||body?.success!==true||id!==configured)return {status:'unknown',cause:self.status===401||self.status===403?'login_required':'identity_mismatch',mutationCount:0};
 const log=await requestWithChallenge(route.address,'anyrouter.top',`${new URL(rule.logUrl).pathname}?p=0&page_size=100&type=${rule.logType}`,{requestHeaders:headers},policy,jar),logBody=parseJson(log);
 const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
 const found=logBody?.data?.items?.some(item=>String(item.content??'').includes(rule.logSuccessText)&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(Number(item.created_at)*1000))===day);
 return {status:found?'signed':'unknown',cause:found?null:'reward_log_not_found',mutationCount:0,identity:{userId:id,verified:true},evidence:found?{source:'usage_log',authoritative:true,businessDate:day}:null,requestCount:2};
}
