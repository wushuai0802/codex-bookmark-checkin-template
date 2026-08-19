export function isTargetOAuthCallback(responseUrl, origin, provider) {
  try {
    const url = new URL(responseUrl);
    const providerSlug = String(provider || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return Boolean(providerSlug)
      && url.origin === new URL(origin).origin
      && url.pathname.toLowerCase() === `/api/oauth/${providerSlug}`;
  } catch {
    return false;
  }
}

export function extractSafeOAuthCallbackEvidence(body, httpStatus = 0) {
  const value = body && typeof body === "object" ? body : {};
  const data = value.data && typeof value.data === "object" ? value.data : {};
  const user = data.user && typeof data.user === "object"
    ? data.user
    : (value.user && typeof value.user === "object" ? value.user : {});
  const rawUserId = user.id ?? data.id ?? value.id ?? null;
  const rawCheckedIn = data.checked_in ?? user.checked_in ?? value.checked_in ?? null;
  const errorText = [value.message, value.error, data.message, data.error]
    .filter((item) => typeof item === "string")
    .join(" ");
  const errorCategory = value.success === true
    ? null
    : /state|状态参数|狀態參數/i.test(errorText)
      ? "state_rejected"
      : /redirect|回调地址|回調地址/i.test(errorText)
        ? "redirect_uri_rejected"
        : /429|too many|rate.?limit|请求次数|請求次數|频率|頻率/i.test(errorText)
          ? "rate_limited"
          : /trust|level|资格|資格|用户组|用戶組|not allowed|forbidden/i.test(errorText)
            ? "account_ineligible"
            : /code|token|exchange|oauth/i.test(errorText)
              ? "code_exchange_failed"
              : /login|session|登录|登入|会话|會話/i.test(errorText)
                ? "session_rejected"
                : "callback_rejected";
  return {
    httpStatus: Number(httpStatus) || 0,
    success: value.success === true,
    userId: rawUserId == null || !/^\d+$/.test(String(rawUserId)) ? null : String(rawUserId),
    checkedIn: typeof rawCheckedIn === "boolean" ? rawCheckedIn : null,
    errorCategory,
  };
}
