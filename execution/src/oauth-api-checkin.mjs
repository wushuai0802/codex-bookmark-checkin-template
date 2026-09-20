function sameOriginEndpoint(origin, value, field) {
  let url;
  try { url = new URL(String(value), `${origin}/`); } catch { throw new Error(`${field} 无效`); }
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password || url.hash) {
    throw new Error(`${field} 必须属于目标 HTTPS origin`);
  }
  return url.href;
}

export function configuredOAuthApiCheckinRule(requestedOrigin, config = {}) {
  const origin = new URL(requestedOrigin).origin;
  const raw = config.oauthApiCheckinRules?.[origin];
  if (!raw) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`OAuth API 签到规则无效：${origin}`);
  }
  return {
    statusUrl: sameOriginEndpoint(origin, raw.statusPath, `OAuth API 签到状态地址 ${origin}`),
    actionUrl: sameOriginEndpoint(origin, raw.actionPath, `OAuth API 签到动作地址 ${origin}`),
  };
}

/**
 * Check and, when needed, perform an OAuth-backed daily action. The helper
 * returns terminal success only from the site's authenticated status/action
 * endpoints; page copy and click completion are intentionally ignored.
 */
export async function tryOAuthApiCheckin(page, requestedOrigin, config = {}) {
  const origin = new URL(requestedOrigin).origin;
  const rule = configuredOAuthApiCheckinRule(origin, config);
  if (!rule) return null;

  const outcome = await page.evaluate(async ({ statusUrl, actionUrl }) => {
    const finiteNumber = (value) => {
      if (value == null || String(value).trim() === "") return null;
      const number = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
      return Number.isFinite(number) ? number : null;
    };
    const payloadOf = (body) => body?.data && typeof body.data === "object" ? body.data : body;
    const readBalance = (body) => {
      const payload = payloadOf(body);
      return finiteNumber(payload?.new_balance ?? payload?.current_balance ?? payload?.balance ?? payload?.quota);
    };
    const readReward = (body) => {
      const payload = payloadOf(body);
      return finiteNumber(payload?.reward ?? payload?.reward_quota ?? payload?.quota_awarded ?? payload?.quota);
    };
    const readCanSpin = (body) => {
      const payload = payloadOf(body);
      if (typeof payload?.can_spin === "boolean") return payload.can_spin;
      if (typeof payload?.canSpin === "boolean") return payload.canSpin;
      return null;
    };
    const request = async (url, method) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      }).catch(() => null);
      if (!response) return { code: "network_error" };
      const body = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) return { code: "login_required" };
      const message = String(body?.message ?? payloadOf(body)?.message ?? "");
      if (response.status === 429 || /too many|rate.?limit|请求次数过多|操作过于频繁|频率限制/i.test(message)) {
        return { code: "rate_limited", status: response.status, message };
      }
      return {
        code: "response",
        status: response.status,
        ok: response.ok,
        success: body?.success === true || payloadOf(body)?.success === true,
        canSpin: readCanSpin(body),
        balance: readBalance(body),
        reward: readReward(body),
        message,
        loginMessage: /(?:未登录|请先登录|login required|unauthorized)/i.test(message),
      };
    };

    const before = await request(statusUrl, "GET");
    if (before.code === "login_required" || before.loginMessage) return { code: "login_required" };
    if (before.code === "rate_limited") return { code: "rate_limited" };
    if (before.ok && before.success && before.canSpin === false) {
      return { code: "already_signed", balance: before.balance };
    }
    if (!(before.ok && before.success && before.canSpin === true)) {
      if (/已签到|已簽到|already/i.test(before.message)) return { code: "already_signed", balance: before.balance };
      return { code: "unconfirmed" };
    }

    const action = await request(actionUrl, "POST");
    if (action.code === "login_required" || action.loginMessage) return { code: "login_required" };
    if (action.code === "rate_limited") return { code: "rate_limited" };

    // Treat the action response as an acknowledgement. A bounded status poll
    // confirms the current-day state without repeating the mutating request.
    if (action.ok && action.success) {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const after = await request(statusUrl, "GET");
        if (after.code === "login_required" || after.loginMessage) return { code: "login_required" };
        if (after.code === "rate_limited") return { code: "rate_limited" };
        if (after.ok && after.success && after.canSpin === false) {
          return {
            code: "signed",
            beforeBalance: before.balance,
            actionBalance: action.balance,
            afterBalance: after.balance,
            reward: action.reward,
          };
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // A timeout or duplicate action may race with the server commit. Re-read
    // the authoritative status once before leaving the result unresolved.
    const after = await request(statusUrl, "GET");
    if (after.code === "login_required" || after.loginMessage) return { code: "login_required" };
    if (after.code === "rate_limited") return { code: "rate_limited" };
    if (after.ok && after.success && after.canSpin === false) {
      return { code: "already_signed", balance: after.balance };
    }
    return { code: "submission_outcome_unknown", actionSubmitted: true };
  }, rule);

  if (outcome?.code === "signed") {
    const evidence = { source: "oauth_api_action" };
    if ([outcome.beforeBalance, outcome.actionBalance, outcome.afterBalance, outcome.reward]
      .some((value) => Number.isFinite(value))) {
      evidence.source = "oauth_api_action_status";
      if (Number.isFinite(outcome.beforeBalance)) evidence.beforeBalance = outcome.beforeBalance;
      if (Number.isFinite(outcome.actionBalance)) evidence.actionBalance = outcome.actionBalance;
      if (Number.isFinite(outcome.afterBalance)) evidence.afterBalance = outcome.afterBalance;
      if (Number.isFinite(outcome.reward)) evidence.reward = outcome.reward;
    }
    return {
      status: "signed",
      reason: "OAuth 站点签到接口确认今日签到成功",
      evidence,
    };
  }
  if (outcome?.code === "already_signed") {
    const evidence = { source: "oauth_api_status" };
    if (Number.isFinite(outcome.balance)) evidence.balance = outcome.balance;
    return {
      status: "already_signed",
      reason: "OAuth 站点状态接口确认今日已签到",
      evidence,
    };
  }
  if (outcome?.code === "rate_limited") {
    return {
      status: "deferred",
      retryCause: "rate_limit",
      reason: "OAuth 站点签到接口触发频率限制，已延后低频重试",
    };
  }
  if (outcome?.code === "login_required") {
    return { status: "login_required", reason: "OAuth 站点登录状态失效" };
  }
  if (outcome?.code === "submission_outcome_unknown" && outcome.actionSubmitted === true) {
    return {
      status: "needs_attention",
      reason: "OAuth 签到动作已提交，但状态接口在限定时间内未确认结果",
      failureCode: "submission_outcome_unknown",
      submissionAttempted: true,
      retryable: false,
    };
  }
  return null;
}
