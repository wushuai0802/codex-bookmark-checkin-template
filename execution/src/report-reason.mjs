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
  return { ...result, reason: "主 Chrome 回退返回了不可读结果，已保留状态并安排复核" };
}

export function normalizeResultReasons(results) {
  return (results ?? []).map(normalizeResultReason);
}
