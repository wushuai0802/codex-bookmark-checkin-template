const DEFAULT_LOG_PATH = "/api/log/self";

export function parseObservedBrowserUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

// Only an account-bound missing reward or an explicit session-expired response
// justifies ending the current account session. Keep the guard explicit so
// transient log failures, account mismatches, and challenges cannot log out.
export function shouldForceOAuthRelogin(dailyCheckin, { identityMatches = false } = {}) {
  if (dailyCheckin?.status !== "login_required" || dailyCheckin?.forceOAuthRelogin !== true) return false;
  if (dailyCheckin.reloginReason === "session_expired") return true;
  return identityMatches === true && dailyCheckin.reloginReason === "daily_reward_missing";
}

function sameOriginHttpsUrl(origin, value, field) {
  const expectedOrigin = new URL(origin).origin;
  const resolved = new URL(String(value || "/"), expectedOrigin);
  if (resolved.protocol !== "https:" || resolved.origin !== expectedOrigin || resolved.username || resolved.password) {
    throw new Error(`${field} 必须是目标站点的无凭据 HTTPS 地址`);
  }
  return resolved.href;
}

export function configuredOAuthReloginRule(origin, config = {}) {
  const expectedOrigin = new URL(origin).origin;
  const raw = config.oauthReloginCheckinRules?.[expectedOrigin];
  if (!raw) return null;
  const successText = String(raw.successText || "").trim();
  const rewardAmount = Number(raw.rewardAmount);
  const logType = Number(raw.logType);
  const logoutLabel = String(raw.logoutLabel || "退出").trim();
  if (!successText || successText.length > 120 || /[\r\n]/.test(successText)) {
    throw new Error(`OAuth 重登录签到 successText 无效：${expectedOrigin}`);
  }
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
    throw new Error(`OAuth 重登录签到 rewardAmount 无效：${expectedOrigin}`);
  }
  if (!Number.isInteger(logType) || logType < 0 || logType > 100) {
    throw new Error(`OAuth 重登录签到 logType 无效：${expectedOrigin}`);
  }
  if (!logoutLabel || logoutLabel.length > 40 || /[\r\n]/.test(logoutLabel)) {
    throw new Error(`OAuth 重登录签到 logoutLabel 无效：${expectedOrigin}`);
  }
  return {
    origin: expectedOrigin,
    selfUrl: sameOriginHttpsUrl(expectedOrigin, raw.selfPath || "/api/user/self", "selfPath"),
    logUrl: sameOriginHttpsUrl(expectedOrigin, raw.logPath || DEFAULT_LOG_PATH, "logPath"),
    logPageUrl: sameOriginHttpsUrl(expectedOrigin, raw.logPagePath || "/console/log", "logPagePath"),
    logoutPageUrl: sameOriginHttpsUrl(expectedOrigin, raw.logoutPagePath || "/console", "logoutPagePath"),
    logoutUrl: raw.logoutPath ? sameOriginHttpsUrl(expectedOrigin, raw.logoutPath, "logoutPath") : null,
    successText,
    rewardAmount,
    logType,
    logoutLabel,
    forceLogout: raw.forceLogout === true,
    nativeBrowser: raw.nativeBrowser === true,
    expectedAccountId: String(
      config.oauthExpectedAccountIds?.[expectedOrigin]
      ?? config.oauthAccountIdentities?.[expectedOrigin]?.accountId
      ?? "",
    ).trim(),
    verificationWaitMs: Math.max(1000, Math.min(30000, Number(raw.verificationWaitMs) || 12000)),
  };
}

export async function forceConfiguredOAuthLogout(page, rule, config = {}) {
  await page.goto(rule.logoutPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(config.navigationTimeoutMs) || 20000,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  if (rule.logoutUrl) {
    const result = await page.evaluate(async (logoutUrl) => {
      let response;
      try {
        response = await fetch(logoutUrl, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json" },
        });
      } catch {
        return { state: "request_failed" };
      }
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* response may be empty */ }
      return {
        state: response.ok && body?.success !== false ? "logged_out" : "rejected",
        status: response.status,
      };
    }, rule.logoutUrl);
    if (result?.state === "logged_out" || [401, 403].includes(Number(result?.status))) return true;
    throw new Error("站点同源退出接口未能结束当前登录会话");
  }

  const avatarButton = page.locator('button:has([class*="avatar" i]):visible');
  const avatarCount = await avatarButton.count();
  if (avatarCount === 0) return false;
  if (avatarCount !== 1) throw new Error("无法唯一识别 OAuth 重登录站点的账户菜单");
  await avatarButton.click({ timeout: 5000 });
  await page.waitForTimeout(300);
  const menuItems = page.locator('[role="menuitem"]:visible, li:visible');
  const matchingItems = [];
  for (let index = 0; index < await menuItems.count(); index += 1) {
    const item = menuItems.nth(index);
    const text = String(await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (text === rule.logoutLabel) matchingItems.push(item);
  }
  if (matchingItems.length !== 1) throw new Error("无法唯一识别 OAuth 重登录站点的退出菜单项");
  await matchingItems[0].click({ timeout: 5000 });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await avatarButton.count() === 0) return true;
    await page.waitForTimeout(300);
  }
  throw new Error("站点退出动作没有结束当前登录会话");
}

export async function tryOAuthReloginCheckinStatus(page, origin, config = {}, completedStatus = "already_signed") {
  const rule = configuredOAuthReloginRule(origin, config);
  if (!rule) return null;
  const observed = await page.evaluate(async ({ selfUrl, logUrl, successText, rewardAmount, logType, expectedAccountId }) => {
    const challengeText = /aliyun_waf_|captcha|滑动验证|访问验证|verify you are human|安全验证|安全驗證|cf-app-waf|nc-container|turnstile/i;
    const readJson = async (url, headers = {}) => {
      let response;
      try {
        response = await fetch(url, {
          credentials: "include",
          redirect: "error",
          headers: { Accept: "application/json", ...headers },
        });
      } catch {
        return { status: 0, body: null, text: "", reason: "request_failed" };
      }
      const text = await response.text().catch(() => "");
      let body = null;
      try { body = JSON.parse(text); } catch { /* HTML or an empty body */ }
      if (challengeText.test(text)) return { status: response.status, body, text, reason: "challenge_required" };
      return { status: response.status, body, text };
    };
    const selfResponse = await readJson(selfUrl);
    if (selfResponse.reason === "challenge_required") return { state: "error", reason: "challenge_required" };
    if (selfResponse.status === 401 || selfResponse.status === 403) return { state: "session_expired" };
    if (selfResponse.status === 429) return { state: "error", reason: "http_429" };
    if (selfResponse.status === 0 || selfResponse.reason === "request_failed" || selfResponse.status >= 500) {
      return { state: "error", reason: selfResponse.status >= 500 ? `http_${selfResponse.status}` : "request_failed" };
    }
    const selfUser = selfResponse.body?.data?.user ?? selfResponse.body?.data ?? selfResponse.body?.user;
    const userId = selfUser?.id == null ? null : String(selfUser.id);
    if (selfResponse.status !== 200 || selfResponse.body?.success === false || !userId) {
      return { state: "error", reason: "invalid_response" };
    }
    if (expectedAccountId && userId !== expectedAccountId) {
      return { state: "account_mismatch", accountId: userId, expectedAccountId };
    }
    // The same-origin self endpoint is authoritative. A stale storage label
    // must never override its exact account identity.
    const identityMatched = !expectedAccountId || userId === expectedAccountId;
    if (!identityMatched) {
      return { state: "account_mismatch", accountId: userId, expectedAccountId };
    }
    const now = new Date();
    const startSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
    const endSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000);
    const amountPattern = /增加额度\s*[＄$]\s*([0-9]+(?:\.[0-9]+)?)/i;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const endpoint = new URL(logUrl);
      endpoint.searchParams.set("p", String(pageIndex));
      endpoint.searchParams.set("page_size", "100");
      endpoint.searchParams.set("type", String(logType));
      endpoint.searchParams.set("token_name", "");
      endpoint.searchParams.set("model_name", "");
      endpoint.searchParams.set("start_timestamp", String(startSeconds));
      endpoint.searchParams.set("end_timestamp", String(endSeconds));
      endpoint.searchParams.set("group", "");
      const response = await readJson(endpoint.href, { "New-Api-User": userId });
      if (response.reason === "challenge_required") return { state: "error", reason: "challenge_required" };
      if (response.status === 401 || response.status === 403) return { state: "session_expired" };
      if (response.status === 0 || response.reason === "request_failed") return { state: "error", reason: "request_failed" };
      if (!response.status || response.status >= 500 || response.status === 429) return { state: "error", reason: `http_${response.status}` };
      if (response.status !== 200) return { state: "error", reason: `http_${response.status}` };
      const body = response.body;
      const items = body?.data?.items;
      if (!Array.isArray(items)) return { state: "error", reason: "invalid_response" };
      const match = items.find((item) => {
        const createdAt = Number(item?.created_at);
        const content = String(item?.content || "");
        const amount = Number(content.match(amountPattern)?.[1]);
        return Number(item?.type) === logType
          && createdAt >= startSeconds
          && createdAt < endSeconds
          && content.includes(successText)
          && Number.isFinite(amount)
          && Math.abs(amount - rewardAmount) < 0.000001;
      });
      if (match) return { state: "confirmed", createdAt: Number(match.created_at), accountId: userId, identityMatched: true };
      if (items.length < 100) break;
    }
    return { state: "missing", identityMatched: true };
  }, rule);

  if (observed?.state === "confirmed") {
    const evidence = {
      source: "usage_log",
      createdAt: new Date(Number(observed.createdAt) * 1000).toISOString(),
      rewardAmount: rule.rewardAmount,
    };
    if (observed.accountId != null && String(observed.accountId).trim()) {
      evidence.accountId = String(observed.accountId).trim();
    }
    return {
      status: completedStatus,
      reason: `使用日志确认今日重新登录签到成功，奖励额度 $${rule.rewardAmount}`,
      evidence,
    };
  }
  if (observed?.state === "account_mismatch") {
    return {
      status: "login_required",
      reason: `当前登录账号 ${observed.accountId || "unknown"} 与配置账号 ${observed.expectedAccountId} 不符`,
      forceOAuthRelogin: true,
      reloginReason: "account_mismatch",
    };
  }
  if (observed?.state === "session_expired" || observed?.state === "unauthorized") {
    return {
      status: "login_required",
      reason: "站点会话已过期，需要在当前 Profile 中重新完成 OAuth 登录",
      forceOAuthRelogin: true,
      reloginReason: "session_expired",
    };
  }
  if (observed?.state === "missing") {
    return {
      status: "login_required",
      reason: "今日使用日志没有登录签到额度记录，需要退出后重新登录",
      forceOAuthRelogin: true,
      reloginReason: "daily_reward_missing",
      identityMatched: observed.identityMatched === true,
    };
  }
  if (observed?.state === "error" && observed.reason === "http_429") {
    return { status: "deferred", retryCause: "rate_limit", reason: "使用日志接口触发频率限制，已停止本轮查询" };
  }
  if (observed?.state === "error" && /^(?:request_failed|http_5\d\d)$/.test(String(observed.reason ?? ""))) {
    return { status: "deferred", retryCause: "upstream_unavailable", reason: "使用日志接口暂时不可用，已停止本轮查询" };
  }
  return { status: "unconfirmed", reason: "无法从使用日志确认今日登录签到结果" };
}

export async function readOAuthAccountIdentity(page, origin) {
  const expectedOrigin = new URL(origin).origin;
  let activeOrigin;
  try { activeOrigin = new URL(page.url()).origin; } catch { return null; }
  if (activeOrigin !== expectedOrigin) return null;
  return page.evaluate(() => {
    const preferredKeys = ["user", "current_user", "currentUser"];
    const keys = [];
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of preferredKeys) {
        if (storage.getItem(key) !== null) keys.push([storage, key]);
      }
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && !preferredKeys.includes(key)) keys.push([storage, key]);
      }
    }
    for (const [storage, key] of keys) {
      try {
        const value = JSON.parse(storage.getItem(key) || "null");
        const candidate = value?.user ?? value?.state?.user ?? value?.data?.user ?? value?.data ?? value;
        const id = candidate?.id;
        if (id == null) continue;
        return {
          accountId: String(id),
          username: String(candidate?.username ?? candidate?.display_name ?? candidate?.name ?? "").slice(0, 120),
        };
      } catch { /* continue */ }
    }
    return null;
  });
}
