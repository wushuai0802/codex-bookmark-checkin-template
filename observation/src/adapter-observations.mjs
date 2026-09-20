import {displayIdentity,shortLabel} from './display-identity.mjs';
const statuses=new Set(['signed','not_signed','not_available','unknown','entitlement_active','skipped']);
export function publicAdapterObservations(input){
  if(!input||input.mode!=='observe_only'||!Array.isArray(input.results))return null;
  const results=input.results.slice(0,1000).flatMap(row=>{
    try{
      if(row.mutationCount!==0)return [];
      const site=new URL(row.bookmarkOrigin??row.origin);
      if(site.protocol!=='https:'||site.username||site.password||site.origin!==(row.bookmarkOrigin??row.origin))return [];
      return [{origin:site.origin,accountKey:shortLabel(row.accountKey),adapter:shortLabel(row.adapter),status:statuses.has(row.status)?row.status:'unknown',cause:shortLabel(row.cause),
        identity:displayIdentity(row.identity??{}),observedAt:shortLabel(row.observedAt),requestCount:Number.isInteger(row.requestCount)?row.requestCount:0,
        durationMs:Number.isFinite(row.durationMs)?Math.max(0,row.durationMs):null,mutationCount:0,
        authoritative:row.evidence?.authoritative===true&&row.mutationCount===0,source:shortLabel(row.evidence?.source)}];
    }catch{return [];}
  });
  return {mode:'observe_only',generatedAt:shortLabel(input.generatedAt),finishedAt:shortLabel(input.finishedAt),results,counts:{total:results.length,confirmed:results.filter(r=>r.authoritative).length,blocked:results.filter(r=>r.status==='unknown'||r.status==='skipped').length}};
}
