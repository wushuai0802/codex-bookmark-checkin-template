// A shared, bounded transport contract. Never pass browser text or raw errors.
const stages=new Set(['preflight','passive_read','intent_check','submit','readback','complete','transport']);
const codes=new Set(['scope_unavailable','parent_intent_unavailable','fresh_unsigned_required','helper_failed',
  'helper_output_invalid','execution_failed','readback_unavailable','native_result','confirmed','login_required']);
const statuses=new Set(['signed','already_signed','not_signed','login_required','needs_attention','unknown']);
const paths=new Set(['/','/index.php','/login.php','/log.php','/attendance.php','/take2fa.php']);
const factors=new Set(['disabled','configuration_invalid','challenge_invalid','scope_unavailable','passive_proof_unavailable',
  'already_signed','daily_recovery_limit','protocol_unverified','provider_unavailable','totp_unavailable','totp_expired',
  'authentication_unknown','authentication_accepted','authentication_rejected','business_day_changed',
  'authentication_accepted_readback_unavailable','recovery_unavailable']);
const providerFailures=new Set(['disabled','origin_not_allowed','profile_mismatch','invalid_configuration','runtime_unavailable',
  'entrypoint_unavailable','session_missing','session_invalid','session_unavailable','provider_busy','server_mismatch',
  'vault_locked','vault_unauthenticated','vault_state_invalid','cli_status_failed','cli_status_invalid','vault_sync_failed',
  'totp_read_failed','totp_invalid','totp_near_rotation','clock_invalid','clock_unstable','totp_wait_failed',
  'totp_consumer_failed','helper_failed','helper_output_invalid']);
export function nativeProviderFailure(value){
  return value?.ready===false&&providerFailures.has(value.reason)?'provider_'+value.reason:'provider_unavailable';
}
export function projectPtNativeDiagnostic(value){
  if(!value||!stages.has(value.stage)||!codes.has(value.code))return undefined;
  const result={stage:value.stage,code:value.code};
  for(const key of ['durationMs','parentEvidenceAgeMs'])if(Number.isFinite(value[key])&&value[key]>=0)
    result[key]=Math.min(600_000,Math.round(value[key]));
  for(const key of ['attendanceRequestObserved','authenticationRequestObserved','twoFactorAttempted','twoFactorAccepted'])
    if(typeof value[key]==='boolean')result[key]=value[key];
  if(Number.isInteger(value.attendanceResponseStatus)&&value.attendanceResponseStatus>=100&&value.attendanceResponseStatus<=599)
    result.attendanceResponseStatus=value.attendanceResponseStatus;
  if(statuses.has(value.readbackStatus))result.readbackStatus=value.readbackStatus;
  if(paths.has(value.lastPath))result.lastPath=value.lastPath;
  if(factors.has(value.twoFactorReason)||typeof value.twoFactorReason==='string'&&value.twoFactorReason.startsWith('provider_')&&
    providerFailures.has(value.twoFactorReason.slice('provider_'.length)))result.twoFactorReason=value.twoFactorReason;
  return result;
}
