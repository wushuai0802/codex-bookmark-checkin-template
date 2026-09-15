import {classifyEvidence,redactText} from './contracts.mjs';

const typedSources=new Set([
  'page_text','api','usage_log','new_api_checkin_calendar','new_api_checkin_status',
  'new_api_checkin_action','new_api_captcha','oauth_api_status','oauth_api_action',
  'oauth_api_action_status','oauth_reward_log','pt_page','anyrouter_status',
  'anyrouter_log','vibe_entitlement_status','sign_in_response',
  'sign_in_already_claimed_contract'
]);

function validDay(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);}
function hasStructuredEvidence(raw,source,businessDate){
  const dayMatches=raw.businessDate===businessDate||raw.checkinDate===businessDate||raw.recordDate===businessDate||raw.claimDate===businessDate;
  if(['api','page_text'].includes(source))return Boolean(raw.createdAt||raw.confirmedAt);
  if(source==='usage_log')return Boolean(raw.accountId&&raw.createdAt);
  if(source==='new_api_checkin_calendar')return Boolean((raw.accountId||raw.userId)&&dayMatches&&(
    raw.quotaAwarded==null||Number.isFinite(Number(raw.quotaAwarded))
  ));
  if(source==='new_api_checkin_status')return Boolean((raw.accountId||raw.userId)&&dayMatches&&(raw.outcome||raw.statusSignal));
  if(source==='new_api_checkin_action')return Boolean((raw.accountId||raw.userId)&&dayMatches&&(raw.outcome||raw.statusSignal||raw.rewardAmount!=null));
  if(source==='new_api_captcha')return Number.isFinite(Number(raw.quotaAwarded))&&Number(raw.quotaAwarded)>0&&(dayMatches||!raw.businessDate);
  if(['oauth_api_status','oauth_api_action_status','oauth_api_action'].includes(source))return Boolean((raw.accountId||raw.userId)&&(dayMatches||Number.isFinite(raw.actionBalance)&&Number.isFinite(raw.reward)));
  if(source==='oauth_reward_log')return Boolean(raw.accountId&&Number.isFinite(Number(raw.rewardAmount))&&(raw.createdAt||dayMatches));
  if(source==='pt_page')return Boolean((raw.accountId||raw.userId)&&dayMatches&&raw.statusSignal);
  if(['anyrouter_status','anyrouter_log'].includes(source))return Boolean(raw.accountId&&dayMatches&&(raw.statusSignal||Number.isFinite(Number(raw.rewardAmount))));
  if(source==='vibe_entitlement_status')return Boolean((raw.accountId||raw.userId)&&dayMatches&&(raw.outcome||raw.claimDate||raw.dailyRewardVerified===true));
  if(source==='sign_in_already_claimed_contract')return Boolean(dayMatches||raw.rewardAmount!=null);
  if(source==='sign_in_response')return false;
  return false;
}
export function normalizeEvidence(result,{businessDate,referenceAt,expectedId}={}){
  const raw=result?.evidence&&typeof result.evidence==='object'?result.evidence:{};
  const source=classifyEvidence(result),rawSource=typeof raw.source==='string'&&/^[a-z_]{1,64}$/.test(raw.source)?raw.source:'none';
  const success=['signed','already_signed'].includes(result?.status),structuredLegacy=hasStructuredEvidence(raw,rawSource,businessDate),legacySignedResponse=rawSource==='sign_in_response'&&raw.authoritative===true;
  const at=raw.createdAt??raw.confirmedAt??result?.confirmedAt??referenceAt,parsed=Date.parse(at),reference=Date.parse(referenceAt);
  const day=Number.isFinite(parsed)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(parsed)):null,account=raw.accountId??raw.userId??result?.accountId,conflict=expectedId&&account&&String(expectedId)!==String(account);
  let verification='not_applicable';
  if(result?.missingResult)verification='not_started';
  else if(result?.reconciliationConflict)verification='identity_conflict';
  else if(!raw.source)verification='missing_evidence';
  else if(source==='none')verification='unsupported_evidence';
  else if(conflict)verification='identity_conflict';
  else if(raw.authoritative===false)verification='non_authoritative';
  else if(success&&(day!==businessDate||!Number.isFinite(reference)||parsed>reference+60_000||(raw.checkinDate&&raw.checkinDate!==businessDate)))verification='wrong_business_date';
  else if(success)verification=typedSources.has(rawSource)&&(raw.authoritative===true&&(structuredLegacy||legacySignedResponse))?'verified':'unverified_source';
  else if(result?.status==='not_available'){
    const original=rawSource==='cached_confirmation'?raw.originalSource:rawSource;
    const feature=['new_api_checkin_status','new_api_checkin_action'].includes(original)&&raw.outcome==='message_not_enabled'
      ||original==='vibe_entitlement_status'&&['claim_not_enabled','claim_not_configured','entitlement_active'].includes(raw.outcome)
      ||original==='pt_page'&&raw.statusSignal==='maintenance';
    const validTime=Number.isFinite(parsed)&&Number.isFinite(reference)&&parsed<=reference+60_000;
    const cachedAgeOk=rawSource!=='cached_confirmation'||(raw.confirmedAt&&reference-parsed<=168*3600000);
    verification=raw.authoritative===true&&feature&&(validTime||validDay(raw.businessDate))&&cachedAgeOk?'feature_unavailable':'unverified_unavailable';
  }
  return {source,rawSource,originalSource:typeof raw.originalSource==='string'&&/^[a-z_]{1,64}$/.test(raw.originalSource)?raw.originalSource:null,authoritative:verification==='verified'||verification==='feature_unavailable',verification,summary:redactText(result?.reason??''),redacted:true};
}
