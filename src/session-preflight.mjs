import { classifyPageText } from "./detector.mjs";
import { safeLogUrl } from "./security.mjs";
import { resultIdentity } from "./result-identity.mjs";

function requiredHttpsUrl(value, field, expectedOrigin = null) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${field} 必须是 HTTPS 地址`); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${field} 必须是无凭据 HTTPS 地址`);
  if (expectedOrigin && url.origin !== expectedOrigin) throw new Error(`${field} 必须属于 ${expectedOrigin}`);
  return url.href;
}

function readPath(value, configuredPath) {
  return String(configuredPath).split(".").filter(Boolean).reduce(
    (current, part) => current != null ? current[part] : undefined,
    value,
  );
}

export function buildSessionPreflightPlan({
  targets = [],
  isolatedPrimaryAccounts = [],
  supplementalAccounts = [],
  sessionProfiles,
  config = {},
} = {}) {
  if (config.sessionPreflightEnabled === false) return [];
  const plan = [];
  const selectedIdentities = new Set(targets.map(resultIdentity));
  const sharedRules = config.oauthSessionProbeRules ?? {};
  const usedSessions = new Set();
  for (const target of targets) {
    const sessionKey = sessionProfiles?.siteBindings?.get(target.origin);
    if (!sessionKey || usedSessions.has(sessionKey) || !sharedRules[sessionKey]) continue;
    const profilePath = sessionProfiles.profiles.get(sessionKey);
    const rule = sharedRules[sessionKey];
    plan.push({
      kind: "shared_oauth",
      key: sessionKey,
      profilePath,
      probeUrl: requiredHttpsUrl(rule.url, `OAuth 会话 ${sessionKey} 体检地址`),
      representativeOrigin: target.origin,
    });
    usedSessions.add(sessionKey);
  }
  const accountRules = config.oauthAccountProbeRules ?? {};
  for (const account of [...isolatedPrimaryAccounts, ...supplementalAccounts]) {
    if (!selectedIdentities.has(resultIdentity(account)) || !accountRules[account.accountKey]) continue;
    const rule = accountRules[account.accountKey];
    const apiUrl = rule.apiUrl
      ? requiredHttpsUrl(rule.apiUrl, `OAuth 账号 ${account.accountKey} 体检接口`, account.origin)
      : null;
    const userIdHeader = String(rule.userIdHeader ?? "").trim();
    if (userIdHeader && !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(userIdHeader)) {
      throw new Error(`OAuth 账号 ${account.accountKey} 体检请求头无效`);
    }
    plan.push({
      kind: "oauth_account",
      key: account.accountKey,
      identity: resultIdentity(account),
      profilePath: account.automationUserDataDir,
      probeUrl: requiredHttpsUrl(rule.url, `OAuth 账号 ${account.accountKey} 体检地址`, account.origin),
      apiUrl,
      userIdHeader: userIdHeader || null,
      expectedAccountId: account.accountId,
      accountIdPaths: Array.isArray(rule.accountIdPaths) && rule.accountIdPaths.length > 0
        ? rule.accountIdPaths.map(String)
        : ["data.id", "data.user.id", "user.id", "id"],
    });
  }
  return plan;
}

export async function probeSessionPage(context, probe, timeoutMs = 15000) {
  const page = await context.newPage();
  try {
    const response = await page.goto(probe.probeUrl, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(3000, Math.min(30000, Number(timeoutMs) || 15000)),
    });
    const statusCode = response?.status() ?? 0;
    if ([401, 403].includes(statusCode)) {
      return { key: probe.key, kind: probe.kind, status: "login_required", checkedUrl: safeLogUrl(page.url()) };
    }
    if (statusCode >= 500) {
      return { key: probe.key, kind: probe.kind, status: "unavailable", checkedUrl: safeLogUrl(page.url()) };
    }
    if (probe.kind === "oauth_account") {
      const snapshot = await page.evaluate(() => ({
        bodyText: String(document.body?.innerText ?? "").slice(0, 30000),
        hasPassword: [...document.querySelectorAll('input[type="password"]')].some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }),
      })).catch(() => ({ bodyText: "", hasPassword: false }));
      const finalUrl = new URL(page.url());
      if (finalUrl.origin !== new URL(probe.probeUrl).origin) {
        return { key: probe.key, kind: probe.kind, status: "login_required", checkedUrl: safeLogUrl(page.url()) };
      }
      const pageState = classifyPageText({
        url: page.url(),
        title: await page.title().catch(() => ""),
        bodyText: snapshot.bodyText,
        hasPassword: snapshot.hasPassword,
      });
      if (pageState.status === "login_required") {
        return { key: probe.key, kind: probe.kind, status: "login_required", checkedUrl: safeLogUrl(page.url()) };
      }
      const storageIdentity = await page.evaluate(() => {
        for (const storage of [localStorage, sessionStorage]) {
          for (let index = 0; index < storage.length; index += 1) {
            try {
              const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
              const candidate = value?.user ?? value?.state?.user ?? value?.data?.user ?? value?.data ?? value;
              if (candidate?.id != null) return String(candidate.id);
            } catch { /* continue */ }
          }
        }
        return null;
      }).catch(() => null);
      const navigationPayload = storageIdentity == null ? await response?.json().catch(() => null) : null;
      const observed = storageIdentity
        ?? probe.accountIdPaths.map((item) => readPath(navigationPayload, item)).find((item) => item != null);
      if (observed == null) {
        return { key: probe.key, kind: probe.kind, status: "login_required", checkedUrl: safeLogUrl(page.url()) };
      }
      if (String(observed) !== String(probe.expectedAccountId)) {
        return { key: probe.key, kind: probe.kind, status: "account_mismatch", checkedUrl: safeLogUrl(page.url()) };
      }
      if (probe.apiUrl) {
        const apiResult = await page.evaluate(async ({ apiUrl, userIdHeader, userId }) => {
          try {
            const headers = { Accept: "application/json" };
            if (userIdHeader) headers[userIdHeader] = userId;
            const value = await fetch(apiUrl, { credentials: "include", headers });
            const body = await value.json().catch(() => null);
            return { status: value.status, ok: value.ok, body };
          } catch { return null; }
        }, {
          apiUrl: probe.apiUrl,
          userIdHeader: probe.userIdHeader,
          userId: String(observed),
        }).catch(() => null);
        if (!apiResult || apiResult.status >= 500) {
          return { key: probe.key, kind: probe.kind, status: "unavailable", checkedUrl: safeLogUrl(probe.apiUrl) };
        }
        if ([401, 403].includes(apiResult.status) || !apiResult.ok) {
          return { key: probe.key, kind: probe.kind, status: "login_required", checkedUrl: safeLogUrl(probe.apiUrl) };
        }
        const apiAccountId = probe.accountIdPaths
          .map((item) => readPath(apiResult.body, item)).find((item) => item != null);
        if (apiAccountId != null && String(apiAccountId) !== String(probe.expectedAccountId)) {
          return { key: probe.key, kind: probe.kind, status: "account_mismatch", checkedUrl: safeLogUrl(probe.apiUrl) };
        }
      }
      return { key: probe.key, kind: probe.kind, status: "authenticated", checkedUrl: safeLogUrl(page.url()) };
    }
    const snapshot = await page.evaluate(() => ({
      bodyText: String(document.body?.innerText ?? "").slice(0, 30000),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
    }));
    const state = classifyPageText({
      url: page.url(),
      title: await page.title(),
      bodyText: snapshot.bodyText,
      hasPassword: snapshot.hasPassword,
    });
    const status = state.status === "login_required"
      ? "login_required"
      : ["interactive_challenge", "managed_challenge"].includes(state.status)
        ? "challenge"
        : state.status === "deferred"
          ? "unavailable"
          : "authenticated";
    return { key: probe.key, kind: probe.kind, status, checkedUrl: safeLogUrl(page.url()) };
  } catch {
    return { key: probe.key, kind: probe.kind, status: "unavailable", checkedUrl: safeLogUrl(probe.probeUrl) };
  } finally {
    await page.close().catch(() => {});
  }
}
