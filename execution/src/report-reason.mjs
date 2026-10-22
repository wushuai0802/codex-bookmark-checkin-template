// PowerShell 5.1 can decode a UTF-8 child-process response with the active
// console code page. Only known native-fallback mojibake is normalized.
const NATIVE_FALLBACK_MOJIBAKE = /(?:涓\?|椤甸潰|鏄庣|纭|绛惧埌|鎴愬姛|�)/;

export function normalizeResultReason(result) {
  const reason = String(result?.reason ?? "");
  if (result?.nativePreflight !== true || !NATIVE_FALLBACK_MOJIBAKE.test(reason)) {
    return result;
  }
  if (result.status === "signed") {
    return { ...result, reason: "主 Chrome 页面明确确认签到成功" };
  }
  if (result.status === "already_signed") {
    return { ...result, reason: "主 Chrome 页面明确确认今日已签到" };
  }
  if (result.nativeGate === true && result.failureCode === "submission_outcome_unknown") {
    return { ...result, reason: "原生签到可能已提交，先只读核验，禁止自动重放" };
  }
  if (result.nativeReadback?.code === "invalid_json") {
    return { ...result, reason: "主 Chrome 只读回读返回无效 JSON，已保留诊断并安排复核" };
  }
  if (result.failureCode === "submission_outcome_unknown" || result.submissionAttempted === true) {
    return { ...result, reason: "主 Chrome 签到可能已提交，但尚无权威结果；先只读核验，禁止重放" };
  }
  return { ...result, reason: "主 Chrome 回退未取得权威终态，已保留诊断并安排只读复核" };
}

export function normalizeResultReasons(results) {
  return (results ?? []).map(normalizeResultReason);
}
