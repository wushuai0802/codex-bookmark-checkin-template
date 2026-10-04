import {ptOriginAliases} from './checkin-contract.generated.mjs';

export function canonicalPtOrigin(value){
  try{
    const url=new URL(value);
    if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)return null;
    return ptOriginAliases[url.origin]??url.origin;
  }catch{return null;}
}

// Configuration membership is separate from observed success and account identity.
// Legacy reports keep the existing completion gate until the exporter is upgraded.
export function harvestSiteAssignment(report,origin){
  const canonical=canonicalPtOrigin(origin);
  if(!canonical||!Array.isArray(report?.sites))return {owner:'unknown',site:null};
  const matches=report.sites.filter(site=>canonicalPtOrigin(site?.origin)===canonical);
  if(matches.length>1)return {owner:'ambiguous',site:null};
  const site=matches[0]??null;
  if(typeof site?.checkinEnabled==='boolean')return {owner:site.checkinEnabled?'harvest':'execution',site};
  if(!site&&report.checkinInventoryComplete===true)return {owner:'execution',site:null};
  if(report.checkinInventoryComplete!==undefined||site&&Object.hasOwn(site,'checkinEnabled'))return {owner:'unknown',site};
  return {owner:'legacy',site};
}

export function harvestTaskCompleted(report,businessDate,now=new Date()){
  const completion=report?.taskCompletion,started=Date.parse(completion?.startedAt),ended=Date.parse(completion?.completedAt);
  const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
  return completion?.status==='completed'&&Number.isInteger(completion.resultId)&&
    Number.isFinite(started)&&Number.isFinite(ended)&&started<=ended&&ended<=now.getTime()+60_000&&
    dayAt(started)===businessDate&&dayAt(ended)===businessDate&&
    (completion.activeTaskCount===undefined||completion.activeTaskCount===0);
}

export function harvestTaskFailed(report,businessDate,now=new Date()){
  const completion=report?.taskCompletion,started=Date.parse(completion?.startedAt),ended=Date.parse(completion?.completedAt);
  const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
  return completion?.status==='failed'&&Number.isInteger(completion.resultId)&&
    Number.isFinite(started)&&Number.isFinite(ended)&&started<=ended&&ended<=now.getTime()+60_000&&
    dayAt(started)===businessDate&&dayAt(ended)===businessDate&&
    (completion.activeTaskCount===undefined||completion.activeTaskCount===0);
}
