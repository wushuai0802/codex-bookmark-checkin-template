// Only observed challenge evidence is a challenge failure. An unavailable
// reader says nothing about whether the remote check-in already succeeded.
export function safeNativeSecurityDiagnostic(value) {
  const keys=['verificationRoute','otpInputPresent','scopedOtpInputPresent','passwordInputPresent','sameOrigin','pageContentAvailable','waf'];
  if(!value||keys.some(key=>typeof value[key]!=='boolean'))return null;
  const allowed=new Set(['remote_login_text','secondary_recovery_link','secondary_code_text','explicit_secondary_prompt','verification_route','scoped_secondary_input']);
  return {...Object.fromEntries(keys.map(key=>[key,value[key]])),
    matchedRules:[...new Set((Array.isArray(value.matchedRules)?value.matchedRules:[]).filter(rule=>allowed.has(rule)))]};
}

const nativeRecoveryReasons=new Set(['disabled','configuration_invalid','challenge_invalid','lease_unavailable','execution_busy',
  'scope_unavailable','recovery_state_invalid','passive_proof_unavailable','already_signed','daily_recovery_limit',
  'totp_unavailable','protocol_unverified','account_changed','authentication_accepted','authentication_unknown',
  'authentication_rejected','authentication_redirected','authentication_http_error','authentication_response_invalid',
  'authentication_accepted_readback_unavailable','business_day_changed','recovery_unavailable','provider_busy',
  ...['disabled','origin_not_allowed','profile_mismatch','invalid_configuration','runtime_unavailable','entrypoint_unavailable',
    'session_missing','session_invalid','session_unavailable','server_mismatch','vault_locked','vault_unauthenticated',
    'vault_state_invalid','cli_status_failed','cli_status_invalid','vault_sync_failed','totp_read_failed','totp_invalid',
    'totp_near_rotation','clock_invalid','clock_unstable','totp_wait_failed','totp_consumer_failed','helper_failed',
    'helper_output_invalid'].map(reason=>'provider_'+reason)]);

export function safeNativeTwoFactorRecovery(value) {
  return value&&typeof value.attempted==='boolean'&&typeof value.accepted==='boolean'&&nativeRecoveryReasons.has(value.reason)
    ?{attempted:value.attempted,accepted:value.accepted,reason:value.reason}:null;
}

function recoveryMessage(recovery) {
  return recovery&&['provider_session_missing','provider_session_invalid','provider_session_unavailable','provider_vault_locked',
    'provider_vault_unauthenticated'].includes(recovery.reason)
    ?'二级验证辅助凭据需要重新解锁，请在签到项目的专用 Bitwarden 客户端完成授权；签到结果继续只读核验'
    :null;
}

export function nativeUnconfirmedSubmission(preflight) {
  if(!preflight||['signed','already_signed','not_available'].includes(preflight.status)||
    !['submissionAttempted','clicked','checkinClicked','checkinClickAttempted'].some(key=>preflight[key]===true))return null;
  const security=safeNativeSecurityDiagnostic(preflight.nativeSecurityDiagnostic);
  const recovery=safeNativeTwoFactorRecovery(preflight.nativeTwoFactorRecovery);
  const underlying=preflight.failureCode==='two_factor_required'||preflight.underlyingFailureCode==='two_factor_required';
  return {status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,
    reason:recoveryMessage(recovery)??(preflight.failureCode==='submission_outcome_unknown'&&preflight.reason?preflight.reason:'原生签到可能已提交，先只读核验，禁止自动重放'),
    inspectionStatus:preflight.inspectionStatus||preflight.status,
    ...(underlying?{underlyingFailureCode:'two_factor_required'}:{}),
    ...(preflight.attentionKind==='trusted_device_initialization'?{attentionKind:'trusted_device_initialization',retryableLoginRecovery:false}:{}),
    ...(security?{nativeSecurityDiagnostic:security}:{}),
    ...(recovery?{nativeTwoFactorRecovery:recovery}:{}),
    ...(preflight.url?{url:preflight.url}:{}),...(preflight.nativeGate===true?{nativeGate:true}:{}),
    ...(typeof preflight.profileBinding==='string'&&/^[a-f0-9]{64}$/.test(preflight.profileBinding)?{profileBinding:preflight.profileBinding}:{}),
    ...(preflight.accountKey==='site-default'?{accountKey:'site-default'}:{}),
    ...(preflight.diagnosticStage?{diagnosticStage:preflight.diagnosticStage}:{}),
    ...(preflight.postActionReadbackAttempted===true?{postActionReadbackAttempted:true}:{})};
}

export function nativePreflightFailure(preflight) {
  const recovery=safeNativeTwoFactorRecovery(preflight?.nativeTwoFactorRecovery);
  const inspectionStatus = preflight?.failureCode || preflight?.inspectionStatus || "missing";
  const challenge = !preflight?.failureCode && (
    preflight?.status === "managed_challenge" ||
    preflight?.inspectionStatus === "managed_challenge"
  );
  return {
    retryCause: challenge ? "managed_challenge_timeout" : "native_readback_unavailable",
    reason: recoveryMessage(recovery)??(preflight?.reason || (challenge
      ? "无调试原生 Chrome 仍停留在安全验证页"
      : "自动验收未取得页面结果，签到状态尚未确认")),
    inspectionStatus,
    ...(preflight?.failureCode ? { failureCode: preflight.failureCode } : {}),
    ...(preflight?.diagnosticStage ? { diagnosticStage: preflight.diagnosticStage } : {}),
    ...(recovery?{nativeTwoFactorRecovery:recovery}:{}),
  };
}
