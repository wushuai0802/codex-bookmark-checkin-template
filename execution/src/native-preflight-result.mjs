// Only observed challenge evidence is a challenge failure. An unavailable
// reader says nothing about whether the remote check-in already succeeded.
export function nativePreflightFailure(preflight) {
  const inspectionStatus = preflight?.failureCode || preflight?.inspectionStatus || "missing";
  const challenge = !preflight?.failureCode && (
    preflight?.status === "managed_challenge" ||
    preflight?.inspectionStatus === "managed_challenge"
  );
  return {
    retryCause: challenge ? "managed_challenge_timeout" : "native_readback_unavailable",
    reason: preflight?.reason || (challenge
      ? "无调试原生 Chrome 仍停留在安全验证页"
      : "自动验收未取得页面结果，签到状态尚未确认"),
    inspectionStatus,
    ...(preflight?.failureCode ? { failureCode: preflight.failureCode } : {}),
    ...(preflight?.diagnosticStage ? { diagnosticStage: preflight.diagnosticStage } : {}),
  };
}
