// Only a V2 mutation can prove that ownership is safe to transfer. An
// already_done observation may come from V1 or another actor and stays legacy.
const terminalSuccess=new Set(['succeeded']);

export function evaluateOwnershipTransition({v1={runLockActive:false,owner:'legacy-checkin'},v2={},receipt={},now=new Date().toISOString()}={}) {
  const reasons=[];
  if(!Number.isFinite(Date.parse(now))) reasons.push('invalid_time');
  if(v1.owner!=='legacy-checkin') reasons.push('unexpected_v1_owner');
  if(v1.runLockActive===true) reasons.push('v1_runner_active');
  if(v2.owner!=='v2-worker') reasons.push('unexpected_v2_owner');
  if(!terminalSuccess.has(v2.phase)||receipt.authoritative!==true) reasons.push('v2_success_evidence_missing');
  if(v2.phase==='submission_unknown') reasons.push('submission_unknown_requires_reconcile');
  if(reasons.length) return {state:'legacy-checkin',changed:false,reasons,evaluatedAt:new Date(now).toISOString()};
  return {state:'v2-worker',changed:true,reasons:[],previousOwner:'legacy-checkin',effectiveAt:new Date(now).toISOString()};
}

export function rollbackOwnership({v1={owner:'legacy-checkin'},v2={},reason='v2_failure',now=new Date().toISOString()}={}) {
  if(v1.owner!=='legacy-checkin'||v2.owner!=='v2-worker') throw Error('ownership binding invalid');
  if(!String(reason).trim()) throw Error('rollback reason required');
  return {state:'legacy-checkin',changed:true,previousOwner:'v2-worker',reason:String(reason).slice(0,160),effectiveAt:new Date(now).toISOString()};
}
