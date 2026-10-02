import {readPtPassivePage} from './pt-read-policy.mjs';

// Reuse the reviewed reader after the passive page loads, before any attendance URL.
export async function initialPtObservation(page,policy,origin,response){
  const observed=await readPtPassivePage(page,policy,{origin,httpStatus:response?.status?.()??0});
  if(observed.status!=='already_signed'||observed.evidence?.authoritative!==true)return null;
  return {...observed,reason:'已登录的只读首页确认今日已签到',submissionAttempted:false,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',url:policy.url};
}
