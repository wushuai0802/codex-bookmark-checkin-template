import {ptReadPolicies,nativePtHeaderOrigins} from './checkin-contract.generated.mjs';
const canonical=origin=>String(origin??'').replace(/^https:\/\/www\./,'https://');
export function ptCapabilities(origin,policy=ptReadPolicies[origin]){
  const native=nativePtHeaderOrigins.some(value=>canonical(value)===canonical(origin));
  let read=Boolean(policy);
  if(read&&policy!==ptReadPolicies[origin]){
    try{const url=new URL(policy.url);
      read=policy.reviewed===true&&policy.mode==='safe_history_page'&&typeof policy.selector==='string'&&Boolean(policy.selector)&&policy.selector.length<=150&&
        url.protocol==='https:'&&url.origin===origin&&!url.username&&!url.password&&!url.hash&&
        [...url.searchParams].every(([key,value])=>['id','page'].includes(key)&&/^\d{1,12}$/.test(value))&&
        !/attendance|check[-_]?in|sign[_-]?(?:in|out)|logout|delete|submit|confirm|claim/i.test(decodeURIComponent(url.pathname));
    }catch{read=false;}
  }
  return {read,guardedSubmit:read&&(policy.dailyHeader===true||policy.hddolbyHeader===true||policy.openCdHeader===true||
    policy.selfProfileHeader===true||policy.nativeMainChrome===true||policy.nativeIsolatedChrome===true||native)};
}
export function sitePtCapabilities(site){
  const value=site?.capabilities;
  return value&&typeof value.read==='boolean'&&typeof value.guardedSubmit==='boolean'
    ?{read:value.read,guardedSubmit:value.read&&value.guardedSubmit}:ptCapabilities(site?.origin);
}
