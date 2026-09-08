import { normalizeOrigin } from './contracts.mjs';

const knownFamilies = [
  { id:'new-api-calendar.v1', label:'New API 日历', mutation:'POST /api/user/checkin', evidence:['/api/user/self','当日签到日历'], configKeys:['newApiSignInRules','newApiCaptchaRules','protectedCredentialApiLoginRules'] },
  { id:'oauth-reward-log.v1', label:'OAuth 奖励日志', mutation:'重登录后日志回读', evidence:['账号身份','当日奖励日志'], configKeys:['oauthReloginCheckinRules'] },
  { id:'oauth-status.v1', label:'OAuth 状态接口', mutation:'站点专用接口', evidence:['站点状态','账号身份'], configKeys:['oauthApiCheckinRules'] },
  { id:'native-pt.v1', label:'PT 原生浏览器', mutation:'页面签到', evidence:['当日页面证据','账号身份'], configKeys:['nativeChallengePreflight','nativeWafPreflightUrls'] },
  { id:'generic-discovery.v1', label:'通用发现', mutation:'按站点规则', evidence:['站点适配规则'], configKeys:[] }
];
const siteRule=(origin, config) => {
  const keys=Object.entries(config).filter(([key,value]) => Array.isArray(value) ? value.some(item => { try { return new URL(String(item?.url??item)).origin===origin; } catch { return false; } }) : value && typeof value==='object' && Object.hasOwn(value,origin)).map(([key])=>key);
  const family=knownFamilies.find(definition=>definition.configKeys.some(key=>keys.includes(key)))??knownFamilies.at(-1);
  return { origin, familyId:family.id, family:family.label, sourceConfigKeys:keys.sort(), mutation:family.mutation, requiredEvidence:[...family.evidence], observeOnly:true, v2CanaryReady:false };
};
export function buildV1AdapterCatalog({plan,config}={}) {
  const origins=[...new Set((plan?.targets??[]).map(target=>normalizeOrigin(target.origin)))].sort();
  return { schemaVersion:1, mode:'catalog_only', source:'v1-effective-config', generatedAt:new Date().toISOString(),
    adapters:knownFamilies.map(definition=>({...definition,observeOnly:true,canaryReady:false})),
    sites:origins.map(origin=>siteRule(origin,config??{})),
    forbidden:['execute','relogin_without_identity','blind_post_retry','main_chrome_fallback','monitor_only_lease'] };
}
