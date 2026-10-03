import {ptFailureMessages as messages,ptRetryCauses} from './checkin-contract.generated.mjs';
export function ptDiagnostic(result={}){
  const maintenance=result.failureCode==='site_maintenance'||result.siteCondition==='site_maintenance'||
    /维护通知|数据恢复|全量恢复/.test(result.reason??'');
  const failureCode=Object.hasOwn(messages,result.failureCode)?result.failureCode:
    maintenance?'site_maintenance':Object.hasOwn(messages,result.retryCause)?result.retryCause:
    result.status==='login_required'?'login_required':result.status==='interactive_challenge'?'interactive_challenge':
    result.status==='error'?'network_error':'authoritative_status_unavailable';
  const retryCause=ptRetryCauses.includes(result.retryCause)?result.retryCause:undefined;
  const underlying=result.underlyingFailureCode!==failureCode&&Object.hasOwn(messages,result.underlyingFailureCode??'')
    ?result.underlyingFailureCode:null;
  return {failureCode,...(retryCause?{retryCause}:{}),...(maintenance?{siteCondition:'site_maintenance'}:{}),
    ...(underlying?{underlyingFailureCode:underlying}:{}),
    summary:messages[failureCode]+(underlying?'；'+messages[underlying]:'')+
      (maintenance&&failureCode==='submission_outcome_unknown'?'；站点当前正在维护':'')};
}
