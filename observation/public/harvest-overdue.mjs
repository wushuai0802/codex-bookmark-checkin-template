import {harvestOverdueDefaults,harvestOverdueCodes,siteFaultCodes} from './checkin-contract.generated.mjs';
import {harvestWindowActive} from './harvest-window.mjs';

export const harvestDay=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));
export function harvestOverdueAt(value=harvestOverdueDefaults.at){
  if(typeof value!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)||value>harvestOverdueDefaults.latestAt)
    throw Error('harvestOverdueAt must be HH:mm, no later than '+harvestOverdueDefaults.latestAt);
  return value;
}
export function harvestDeadlinePassed(now=Date.now(),at){
  return now>=Date.parse(harvestDay(now)+'T'+harvestOverdueAt(at)+':00+08:00');
}
export function currentHarvestReport(report,now=Date.now()){
  const at=Date.parse(report?.generatedAt??'');
  return report?.schemaVersion===1&&report.source==='harvest'&&Array.isArray(report.sites)&&
    Number.isFinite(at)&&at<=now+60_000&&now-at<=30*60_000&&
    report.businessDate===harvestDay(now)&&harvestDay(at)===report.businessDate;
}

// Dated observation context, never an account binding or permission to write.
export function harvestOverdue(site,ptStatus,now=Date.now()){
  const context=ptStatus?.harvestAvailability,observation=site?.harvestObservation;
  if(!context||ptStatus.businessDate!==harvestDay(now)||!harvestDeadlinePassed(now,context.overdueAt)||
    site?.harvestManaged!==true||site.disabledByConfig===true||observation?.checkinEnabled!==true||
    harvestWindowActive(ptStatus.harvestWindow,now))return null;
  const dated=value=>Number.isFinite(Date.parse(value??''))&&Date.parse(value)<=now+60_000&&harvestDay(value)===harvestDay(now);
  const values=[site.effective,...(site.observations??[])].filter(Boolean);
  if(values.some(item=>item.fresh===true&&dated(item.observedAt)&&(
    ['signed','already_signed'].includes(item.status)&&item.authoritative===true||
    item.status==='not_available'||item.siteCondition==='site_maintenance'||siteFaultCodes.includes(item.failureCode)||
    ['site_maintenance','site_migration','bookmark_origin_changed','entitlement_expired','upstream_unavailable','rate_limit'].includes(item.failureCode))))return null;
  // A recorded daily Harvest result already has its established failure/recheck
  // path. This rule covers missing results, including an unavailable observer.
  if(observation.businessDate===harvestDay(now)&&observation.hasTodayReceipt===true)return null;
  const available=context.available===true&&dated(context.observedAt)&&now-Date.parse(context.observedAt)<=30*60_000;
  return {reasonCode:available?harvestOverdueCodes.incomplete:harvestOverdueCodes.unavailable,
    canTakeOver:site.capabilities?.read===true&&site.capabilities?.guardedSubmit===true&&site.fallbackEnabled===true};
}
