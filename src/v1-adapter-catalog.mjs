import {normalizeOrigin} from './contracts.mjs';

const knownFamilies=[
  {id:'new-api-calendar.v1',label:'New API 日历',mutation:'POST /api/user/checkin',evidence:['/api/user/self','当日签到日历'],configKeys:['newApiSignInRules','newApiCaptchaRules','protectedCredentialApiLoginRules']},
  {id:'oauth-reward-log.v1',label:'OAuth 奖励日志',mutation:'重登录后日志回读',evidence:['账号身份','当日奖励日志'],configKeys:['oauthReloginCheckinRules']},
  {id:'oauth-status.v1',label:'OAuth 状态接口',mutation:'站点专用接口',evidence:['站点状态','账号身份'],configKeys:['oauthApiCheckinRules']},
  {id:'native-pt.v1',label:'PT 原生浏览器',mutation:'页面签到',evidence:['当日页面证据','账号身份'],configKeys:['nativeChallengePreflight','nativeWafPreflightUrls']},
  {id:'generic-discovery.v1',label:'通用发现',mutation:'按站点规则',evidence:['站点适配规则'],configKeys:[]}
];

function originOf(value){try{return normalizeOrigin(String(value));}catch{return null;}}
function objectHasOrigin(value,origin){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,origin);}
function arrayHasOrigin(value,origin){return Array.isArray(value)&&value.some(item=>originOf(item?.url??item)===origin);}
function arrayHasExactOrigin(value,origin){return Array.isArray(value)&&value.some(item=>String(item).trim()===origin);}
function targetHasAttendance(plan,origin){return (plan?.targets??[]).some(target=>originOf(target?.origin??target?.url)===origin&&/(?:attendance|check[-_]?in|showup|bakatest|daily[-_]?sign)/i.test(String(target?.origin??target?.url??'')));}
function configuredAttendance(config,origin){return ['configuredTargets','nativeChallengePreflight','nativeWafPreflightUrls'].some(key=>Array.isArray(config?.[key])&&config[key].some(item=>{const value=String(item?.url??item);try{return new URL(value).origin===origin&&/(?:attendance|check[-_]?in|showup|bakatest|daily[-_]?sign)/i.test(value);}catch{return false;}}));}

function siteRule(origin,config,plan){
  const keys=Object.entries(config).filter(([key,value])=>objectHasOrigin(value,origin)||arrayHasOrigin(value,origin)).map(([key])=>key).sort();
  const oauthApiRules=config.oauthApiCheckinRules??{};
  const recoveryService=originOf(config.oauthRecoveryTargetOrigins?.[origin]);
  const serviceHasOAuthApi=recoveryService&&Object.keys(oauthApiRules).some(key=>originOf(key)===recoveryService);
  let family;
  if(objectHasOrigin(config.oauthReloginCheckinRules,origin))family=knownFamilies[1];
  else if(objectHasOrigin(oauthApiRules,origin)||serviceHasOAuthApi)family=knownFamilies[2];
  else if(objectHasOrigin(config.newApiSignInRules,origin)||objectHasOrigin(config.newApiCaptchaRules,origin)||objectHasOrigin(config.protectedCredentialApiLoginRules,origin))family=knownFamilies[0];
  else if(arrayHasExactOrigin(config.newApiCheckinOrigins,origin)&&(
    (config.nativeChallengePreflight??[]).some(item=>originOf(item?.url??item)===origin&&item?.passiveOnly===true)
  ))family=knownFamilies[0];
  else if(arrayHasOrigin(config.nativeChallengePreflight,origin)||arrayHasOrigin(config.nativeWafPreflightUrls,origin)||targetHasAttendance(plan,origin)||configuredAttendance(config,origin))family=knownFamilies[3];
  else family=knownFamilies[4];
  return {origin,familyId:family.id,family:family.label,sourceConfigKeys:keys,mutation:family.mutation,requiredEvidence:[...family.evidence],observeOnly:true,v2CanaryReady:false,serviceOrigin:family.id==='oauth-status.v1'?(recoveryService??origin):null};
}

export function buildV1AdapterCatalog({plan,config}={}){
  const origins=[...new Set((plan?.targets??[]).map(target=>originOf(target.origin??target.url)).filter(Boolean))].sort();
  const safeConfig=config&&typeof config==='object'&&!Array.isArray(config)?config:{};
  return {schemaVersion:1,mode:'catalog_only',source:'v1-effective-config',generatedAt:new Date().toISOString(),adapters:knownFamilies.map(definition=>({...definition,observeOnly:true,canaryReady:false})),sites:origins.map(origin=>siteRule(origin,safeConfig,plan)),forbidden:['execute','relogin_without_identity','blind_post_retry','main_chrome_fallback','monitor_only_lease']};
}
