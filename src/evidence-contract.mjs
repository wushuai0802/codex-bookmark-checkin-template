import {classifyEvidence,redactText} from './contracts.mjs';
const typedSources=new Set(['page_text','api','usage_log','new_api_checkin_calendar','new_api_checkin_status','new_api_checkin_action','new_api_captcha','oauth_api_action_status','sign_in_response','sign_in_already_claimed_contract']);
export function normalizeEvidence(result,{businessDate,referenceAt,expectedId}={}) {
  const raw=result.evidence??{};
  const source=classifyEvidence(result);
  const rawSource=typeof raw.source==='string'&&/^[a-z_]{1,64}$/.test(raw.source)?raw.source:'none';
  const success=['signed','already_signed'].includes(result.status);
  // Compatibility only for documented structured legacy adapters. A naked
  // source label plus a success string is not evidence.
  const structuredLegacy = (['api','page_text'].includes(rawSource) && Boolean(raw.createdAt||raw.confirmedAt))
    || (rawSource==='usage_log' && Boolean(raw.accountId) && Boolean(raw.createdAt))
    || (rawSource==='new_api_captcha' && Number.isFinite(raw.quotaAwarded) && raw.quotaAwarded>0)
    || (rawSource==='oauth_api_action_status' && Number.isFinite(raw.actionBalance) && Number.isFinite(raw.reward));
  const at=raw.createdAt??raw.confirmedAt??result.confirmedAt??referenceAt;
  const parsed=Date.parse(at),reference=Date.parse(referenceAt);
  const day=Number.isFinite(parsed)?new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(parsed)):null;
  const account=raw.accountId??result.accountId;
  const conflict=expectedId&&account&&String(expectedId)!==String(account);
  let verification='not_applicable';
  if(result.missingResult)verification='not_started';
  else if(result.reconciliationConflict)verification='identity_conflict';
  else if(!raw.source)verification='missing_evidence';
  else if(source==='none')verification='unsupported_evidence';
  else if(conflict)verification='identity_conflict';
  else if(raw.authoritative===false)verification='non_authoritative';
  else if(success && (day!==businessDate || !Number.isFinite(reference) || parsed>reference+60_000 || (raw.checkinDate&&raw.checkinDate!==businessDate)))verification='wrong_business_date';
  else if(success)verification=typedSources.has(rawSource)&&(raw.authoritative===true||structuredLegacy)?'verified':'unverified_source';
  else if(result.status==='not_available') {
    const original=rawSource==='cached_confirmation'?raw.originalSource:rawSource;
    const feature=['new_api_checkin_status','new_api_checkin_action'].includes(original)&&raw.outcome==='message_not_enabled';
    const validTime=Number.isFinite(parsed)&&Number.isFinite(reference)&&parsed<=reference+60_000;
    const cachedAgeOk=rawSource!=='cached_confirmation'||(raw.confirmedAt&&reference-parsed<=168*3600000);
    verification=raw.authoritative===true&&feature&&validTime&&cachedAgeOk?'feature_unavailable':'unverified_unavailable';
  }
  return {source,rawSource,originalSource:typeof raw.originalSource==='string'&&/^[a-z_]{1,64}$/.test(raw.originalSource)?raw.originalSource:null,
    authoritative:verification==='verified'||verification==='feature_unavailable',verification,
    summary:redactText(result.reason??''),redacted:true};
}
