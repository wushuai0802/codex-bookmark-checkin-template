import {readPtPassivePage} from './pt-read-policy.mjs';

// Reuse the reviewed reader after the passive page loads, before any attendance URL.
export async function initialPtObservation(page,policy,origin,response){
  const observed=await readPtPassivePage(page,policy,{origin,httpStatus:response?.status?.()??0});
  if(!['already_signed','not_signed'].includes(observed.status)||observed.evidence?.authoritative!==true)return null;
  if(observed.status==='not_signed'&&process.env.CHECKIN_PT_FALLBACK_RECHECK!=='1')return null;
  return {...observed,reason:observed.status==='not_signed'?'V1 fallback 预读确认今日尚未签到':'已登录的只读首页确认今日已签到',submissionAttempted:false,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',url:policy.url};
}
