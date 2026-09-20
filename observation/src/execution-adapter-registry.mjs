import {createNewApiExecutionAdapter} from './new-api-execution-adapter.mjs';
import {createOAuthRewardExecutionAdapter} from './oauth-reward-execution-adapter.mjs';
import {createPtExecutionAdapter} from './pt-execution-adapter.mjs';
import {createAnyRouterExecutionAdapter} from './anyrouter-execution-adapter.mjs';
import {createOAuthApiExecutionAdapter} from './oauth-api-execution-adapter.mjs';
import {createVibeEntitlementExecutionAdapter} from './vibe-entitlement-execution-adapter.mjs';
import {createNewApiCaptchaExecutionAdapter} from './new-api-captcha-execution-adapter.mjs';

const factories=new Map([
  ['new-api.execute.v1',createNewApiExecutionAdapter],
  ['oauth-reward.execute.v1',createOAuthRewardExecutionAdapter],
  ['pt-native.execute.v1',createPtExecutionAdapter],
  ['anyrouter.execute.v1',createAnyRouterExecutionAdapter],
  ['oauth-api.execute.v1',createOAuthApiExecutionAdapter],
  ['vibe-entitlement.execute.v1',createVibeEntitlementExecutionAdapter],
  ['new-api-captcha.execute.v1',createNewApiCaptchaExecutionAdapter]
]);

const ptOrigins=new Set(['https://audiences.me','https://ourbits.club','https://p.t-baozi.cc','https://piggo.me','https://www.hdkyl.in','https://ubits.club','https://muyuan.do']);

function normalizedOrigin(value){return new URL(String(value)).origin;}
function siteRule(config,key,origin){const value=config?.[key]?.[origin];return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function configuredOriginRule(config,key,origin){return siteRule(config,key,origin);}
function pathRule(config,key,origin){const value=config?.[key];if(!Array.isArray(value))return{};const item=value.find(entry=>{try{return new URL(String(entry?.url??entry)).origin===origin;}catch{return false;}});return item&&typeof item==='object'?item:{};}

// Resolve only credential-free adapter metadata. Profile paths, cookies and
// passwords are deliberately excluded from this boundary.
export function executionRuleForProfile({profile,config={},adapterRule={}}={}){
  const binding=executionBindingForOrigin({origin:profile.origin,config});
  const rule={...binding.adapterRule,...adapterRule};
  if(binding.adapterId!=='oauth-reward.execute.v1')return rule;
  const primary=Object.entries(config.oauthAccountIdentities??{}).map(([origin,account])=>({...account,origin}));
  const matches=[...primary,...(config.supplementalOAuthAccounts??[])].filter(account=>account.origin===profile.origin&&account.accountKey===profile.accountKey);
  if(matches.length>1)throw Error('ambiguous OAuth account binding');
  const account=matches[0];
  if(account&&String(account.accountId)!==String(profile.expectedIdentity))throw Error('OAuth account identity mismatch');
  const provider=profile.provider??rule.provider??account?.provider;
  if(account?.provider&&provider&&account.provider.toLowerCase()!==provider.toLowerCase())throw Error('OAuth provider binding mismatch');
  return {...rule,provider,upstreamProvider:rule.upstreamProvider??profile.upstreamProvider??account?.upstreamProvider??null};
}

export function executionBindingForOrigin({origin,config={},strict=false}={}){
  const site=normalizedOrigin(origin);
  if(site==='https://agentrouter.org'){
    const raw=configuredOriginRule(config,'oauthReloginCheckinRules',site);
    return {adapterId:'oauth-reward.execute.v1',adapterRule:{selfPath:raw.selfPath??'/api/user/self',logPath:raw.logPath??'/api/log/self',logType:raw.logType??4,successText:raw.successText??'每日签到成功，增加额度',rewardAmount:raw.rewardAmount??25,forceLogout:raw.forceLogout!==false,logoutPath:raw.logoutPath??'/api/user/logout',logoutPagePath:raw.logoutPagePath??'/console',loginPath:config.oauthLoginUrls?.[site]??'/login',provider:raw.provider??config.automaticOAuthProviders?.[site]??null,upstreamProvider:raw.upstreamProvider??config.oauthUpstreamProviders?.[site]??null,nativeBrowser:raw.nativeBrowser===true,userStorageKeys:raw.userStorageKeys,scanAllStorage:raw.scanAllStorage,maxLogPages:raw.maxLogPages,verificationWaitMs:raw.verificationWaitMs,challengeWaitMs:raw.challengeWaitMs,oauthWaitMs:raw.oauthWaitMs}};
  }
  if(site==='https://anyrouter.top'){
    const raw=configuredOriginRule(config,'newApiSignInRules',site),dynamic=configuredOriginRule(config,'dynamicOriginRoutes',site);
    return {adapterId:'anyrouter.execute.v1',adapterRule:{selfPath:raw.selfPath??'/api/user/self',statusPath:raw.statusPath??'/api/status',signInPath:raw.signInPath??'/api/user/sign_in',logPath:raw.logPath??'/api/log/self',logType:raw.logType??4,rewardAmount:raw.rewardAmount??25,logSuccessText:raw.logSuccessText??'每日签到成功，增加额度',emptySuccessMeansAlreadySigned:raw.emptySuccessMeansAlreadySigned===true,dynamicRoute:dynamic&&typeof dynamic==='object'?dynamic:null,userStorageKeys:raw.userStorageKeys}};
  }
  if(site==='https://x666.me'){
    const raw=config.oauthApiCheckinRules?.['https://up.x666.me']??config.oauthApiCheckinRules?.[site]??{};
    return {adapterId:'oauth-api.execute.v1',adapterRule:{serviceOrigin:raw.serviceOrigin??'https://up.x666.me',allowedServiceOrigins:[...(raw.allowedServiceOrigins??[]),'https://up.x666.me'],pagePath:raw.pagePath??'/api/auth/login',identityPath:raw.identityPath??'/api/user/self',statusPath:raw.statusPath??'/api/checkin/status',actionPath:raw.actionPath??'/api/checkin/spin',userIdHeader:raw.userIdHeader??'New-Api-User',userStorageKeys:raw.userStorageKeys,allowUndatedCanSpinFalse:raw.allowUndatedCanSpinFalse!==false}};
  }
  if(site==='https://new.sharedchat.cc'){
    const raw=configuredOriginRule(config,'quotaRequestRules',site);
    return {adapterId:'vibe-entitlement.execute.v1',adapterRule:{identityPath:raw.identityPath??'/frontend-api/getme',statusPath:raw.statusPath??'/frontend-api/vibe-code/quota',claimStatusPath:raw.claimStatusPath??null,pagePath:raw.pagePath??'/list/',claimEnabled:raw.claimEnabled===true,minimumReasonLength:raw.minimumReasonLength??10,reason:raw.reason??null,claimSelectors:raw.claimSelectors??null,submitSelectors:raw.submitSelectors??null}};
  }
  if(site==='https://ai.venlacy.com'||site==='https://api.42w.shop'){
    const standard=configuredOriginRule(config,'newApiSignInRules',site),credential=configuredOriginRule(config,'protectedCredentialApiLoginRules',site);
    return {adapterId:'new-api.execute.v1',adapterRule:{selfPath:standard.selfPath??credential.selfPath??'/api/user/self',statusPath:standard.statusPath??'/api/user/checkin',signInPath:standard.signInPath??'/api/user/checkin',authRefreshPath:credential.authRefreshPath??(site==='https://ai.venlacy.com'?'/api/user/auth/refresh':null),rewardAmount:standard.rewardAmount??null,responseSuccessText:standard.responseSuccessText??null,emptySuccessMeansAlreadySigned:standard.emptySuccessMeansAlreadySigned===true,userStorageKeys:standard.userStorageKeys}};
  }
  if(site==='https://muyuan.do'){
    const standard=configuredOriginRule(config,'newApiSignInRules',site),credential=configuredOriginRule(config,'protectedCredentialApiLoginRules',site);
    return {adapterId:'new-api.execute.v1',adapterRule:{selfPath:standard.selfPath??credential.selfPath??'/api/user/self',statusPath:standard.statusPath??'/api/user/checkin',signInPath:standard.signInPath??'/api/user/checkin',authRefreshPath:credential.authRefreshPath??'/api/user/auth/refresh',rewardAmount:standard.rewardAmount??null,userStorageKeys:standard.userStorageKeys}};
  }
  if(site==='https://jianzhile.vip'){
    const raw=configuredOriginRule(config,'newApiCaptchaRules',site),standard=configuredOriginRule(config,'newApiSignInRules',site),credential=configuredOriginRule(config,'protectedCredentialApiLoginRules',site);
    return {adapterId:'new-api-captcha.execute.v1',adapterRule:{captchaPath:raw.captchaPath??'/api/user/checkin/captcha',checkinPath:raw.checkinPath??'/api/user/checkin',selfPath:standard.selfPath??credential.selfPath??'/api/user/self',statusPath:standard.statusPath??raw.checkinPath??'/api/user/checkin',authRefreshPath:credential.authRefreshPath??'/api/user/auth/refresh',maxAttempts:raw.maxAttempts??6,responseSuccessText:standard.responseSuccessText??null,userStorageKeys:standard.userStorageKeys??raw.userStorageKeys}};
  }
  if(ptOrigins.has(site)){
    const target=pathRule(config,'nativeChallengePreflight',site),waf=pathRule(config,'nativeWafPreflightUrls',site);
    return {adapterId:'pt-native.execute.v1',adapterRule:{url:target.url??waf.url??'/attendance.php',identityPath:target.identityPath??waf.identityPath??target.url??waf.url??'/attendance.php',allowUndatedStatus:(target.allowUndatedStatus??waf.allowUndatedStatus)===true,buttonImpliesNotSigned:(target.buttonImpliesNotSigned??waf.buttonImpliesNotSigned)!==false,passiveOnly:(target.passiveOnly??waf.passiveOnly)===true,actionSelectors:target.actionSelectors??waf.actionSelectors,identitySelectors:target.identitySelectors??waf.identitySelectors,statusSelectors:target.statusSelectors??waf.statusSelectors,challengeSelectors:target.challengeSelectors??waf.challengeSelectors,captchaImageSelectors:target.captchaImageSelectors??waf.captchaImageSelectors,captchaInputSelectors:target.captchaInputSelectors??waf.captchaInputSelectors,captchaSubmitSelectors:target.captchaSubmitSelectors??waf.captchaSubmitSelectors}};
  }
  const standard=configuredOriginRule(config,'newApiSignInRules',site),credential=configuredOriginRule(config,'protectedCredentialApiLoginRules',site);
  if(strict&&!Object.keys(standard).length&&!Object.keys(credential).length)return {adapterId:null,adapterRule:{},blockedReason:'origin_not_registered'};
  return {adapterId:'new-api.execute.v1',adapterRule:{selfPath:standard.selfPath??credential.selfPath??'/api/user/self',statusPath:standard.statusPath??'/api/user/checkin',signInPath:standard.signInPath??'/api/user/checkin',authRefreshPath:credential.authRefreshPath??null,rewardAmount:standard.rewardAmount??null,userStorageKeys:standard.userStorageKeys}};
}

export function executionAdapterDefinitions(){
  return [
    {id:'new-api.execute.v1',family:'标准 New API',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false},
    {id:'oauth-reward.execute.v1',family:'OAuth 奖励日志',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false,exclusiveSessionMutation:true},
    {id:'pt-native.execute.v1',family:'PT 原生签到',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false,imageCaptchaSupported:true},
    {id:'anyrouter.execute.v1',family:'AnyRouter 动态线路',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false,routeProbeRequired:true},
    {id:'oauth-api.execute.v1',family:'OAuth 状态接口',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false},
    {id:'vibe-entitlement.execute.v1',family:'Vibe 权益领取',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false,manualReviewRequired:true},
    {id:'new-api-captcha.execute.v1',family:'New API 图片验证码',status:'implemented',requires:['identity','read_status','submit_once','verify'],canaryReady:false,manualChallengeSupported:true}
  ];
}

export function createExecutionAdapter({adapterId,origin,rule}={}){
  const factory=factories.get(adapterId);if(!factory)throw Error('execution adapter unavailable: '+adapterId);return factory({origin,rule});
}

export function adapterBindingForSite({origin,familyId}={}){
  const site=normalizedOrigin(origin);
  if(site==='https://anyrouter.top')return {origin:site,adapterId:'anyrouter.execute.v1',canaryReady:false};
  if(site==='https://x666.me')return {origin:site,adapterId:'oauth-api.execute.v1',canaryReady:false};
  if(site==='https://new.sharedchat.cc')return {origin:site,adapterId:'vibe-entitlement.execute.v1',canaryReady:false};
  if(site==='https://ai.venlacy.com'||site==='https://api.42w.shop')return {origin:site,adapterId:'new-api.execute.v1',canaryReady:false};
  if(site==='https://muyuan.do')return {origin:site,adapterId:'new-api.execute.v1',canaryReady:false};
  if(site==='https://jianzhile.vip')return {origin:site,adapterId:'new-api-captcha.execute.v1',canaryReady:false};
  if(ptOrigins.has(site))return {origin:site,adapterId:'pt-native.execute.v1',canaryReady:false};
  if(familyId==='new-api-calendar.v1')return {origin:site,adapterId:'new-api.execute.v1',canaryReady:false};
  if(familyId==='oauth-reward-log.v1')return {origin:site,adapterId:'oauth-reward.execute.v1',canaryReady:false};
  if(familyId==='native-pt.v1')return {origin:site,adapterId:'pt-native.execute.v1',canaryReady:false};
  if(familyId==='anyrouter-route.v1')return {origin:site,adapterId:'anyrouter.execute.v1',canaryReady:false};
  if(familyId==='oauth-status.v1')return {origin:site,adapterId:'oauth-api.execute.v1',canaryReady:false};
  if(familyId==='generic-discovery.v1'&&site==='https://new.sharedchat.cc')return {origin:site,adapterId:'vibe-entitlement.execute.v1',canaryReady:false};
  return {origin:site,adapterId:null,canaryReady:false,blockedReason:'family_not_implemented'};
}
