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
    const request = async (url, method) => {
      const response = await fetch(url, {
        method,
        credentials: "include",
        headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
      }).catch(() => null);
      if (!response) return { code: "network_error" };
      const body = await response.json().catch(() => null);
      if (response.status === 401 || response.status === 403) return { code: "login_required" };
      return {
        code: "response",
        ok: response.ok,
        success: body?.success === true,
        canSpin: body?.can_spin,
        loginMessage: /(?:未登录|请先登录|login required|unauthorized)/i.test(String(body?.message ?? "")),
      };
    };

    const before = await request(statusUrl, "GET");
    if (before.code === "login_required" || before.loginMessage) return { code: "login_required" };
    if (before.ok && before.success && before.canSpin === false) return { code: "already_signed" };
    if (!(before.ok && before.success && before.canSpin === true)) return { code: "unconfirmed" };

    const action = await request(actionUrl, "POST");
    if (action.code === "login_required" || action.loginMessage) return { code: "login_required" };
    if (action.ok && action.success) return { code: "signed" };

    // A timeout or duplicate action may race with the server commit. Re-read
    // the authoritative status once before leaving the result unresolved.
    const after = await request(statusUrl, "GET");
    if (after.ok && after.success && after.canSpin === false) return { code: "already_signed" };
    return { code: "unconfirmed" };
  }, rule);

  if (outcome?.code === "signed") {
    return {
      status: "signed",
      reason: "OAuth 站点签到接口确认今日签到成功",
      evidence: { source: "oauth_api_action" },
    };
  }
  if (outcome?.code === "already_signed") {
    return {
      status: "already_signed",
      reason: "OAuth 站点状态接口确认今日已签到",
      evidence: { source: "oauth_api_status" },
    };
  }
  if (outcome?.code === "login_required") {
    return { status: "login_required", reason: "OAuth 站点登录状态失效" };
  }
  return null;
}
