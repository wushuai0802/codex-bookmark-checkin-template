const DEFAULT_LOG_PATH = "/api/log/self";

export function parseObservedBrowserUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
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
  const observed = await page.evaluate(async ({ logUrl, successText, rewardAmount, logType, expectedAccountId }) => {
    const findUserId = () => {
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          try {
            const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
            const userId = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? null;
            if (userId != null) return String(userId);
          } catch { /* continue */ }
        }
      }
      return null;
    };
    const userId = findUserId();
    if (!userId) return { state: "unauthorized" };
    if (expectedAccountId && userId !== expectedAccountId) {
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
      let response;
      try {
        response = await fetch(endpoint.href, {
          credentials: "include",
          headers: { Accept: "application/json", "New-Api-User": userId },
        });
      } catch {
        return { state: "error", reason: "request_failed" };
      }
      if (response.status === 401 || response.status === 403) return { state: "unauthorized" };
      if (!response.ok) return { state: "error", reason: `http_${response.status}` };
      const body = await response.json().catch(() => null);
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
      if (match) return { state: "confirmed", createdAt: Number(match.created_at), accountId: userId };
      if (items.length < 100) break;
    }
    return { state: "missing" };
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
    };
  }
  if (observed?.state === "unauthorized") {
    return { status: "login_required", reason: "站点会话已退出，需要重新完成 OAuth 登录", forceOAuthRelogin: true };
  }
  if (observed?.state === "missing") {
    return { status: "login_required", reason: "今日使用日志没有登录签到额度记录，需要退出后重新登录", forceOAuthRelogin: true };
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
