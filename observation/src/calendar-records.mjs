import {redactText} from './contracts.mjs';
import {displayIdentity,shortLabel} from './display-identity.mjs';

export function ptCalendarSummaries(ptStatus){
  if(!Array.isArray(ptStatus?.sites))return null;
  return ptStatus.sites.map(site=>({taskId:site.siteRef,origin:site.origin,accountRef:site.accountRef??null,
    displayName:shortLabel(site.displayName),identity:displayIdentity({label:'本站账号'}),taskKind:'pt',inLegacyPlan:site.inLegacyPlan===true,
    observedStatus:site.effective?.fresh?site.effective.status:'unknown',observedAt:site.effective?.observedAt??null,
    evidence:{source:site.effective?.evidence?.source??'none',authoritative:site.effective?.authoritative===true&&site.effective?.fresh===true,
      summary:redactText(site.effective?.evidence?.summary??''),redacted:true}}));
}
