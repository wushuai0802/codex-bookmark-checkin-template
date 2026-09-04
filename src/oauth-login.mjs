import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext, tryNewApiCheckin } from "./browser.mjs";
import { safeLogUrl } from "./security.mjs";
import { isLoginOrSignInRoute } from "./url-routes.mjs";
import { configuredNewApiSignInRule, tryNewApiSignIn } from "./new-api-signin.mjs";
import { extractSafeOAuthCallbackEvidence, isTargetOAuthCallback } from "./oauth-callback.mjs";
import { tryOAuthApiCheckin } from "./oauth-api-checkin.mjs";
import {
  resolveOAuthRecoveryTargetOrigin,
  trustedLinuxDoAuthorizeRequest,
  trustedLinuxDoAuthorizeState,
} from "./oauth-recovery-target.mjs";
import { configForOAuthRecoveryAccount } from "./oauth-recovery-profile.mjs";
import {
  configuredIsolatedOAuthSiteProfiles,
  configForIsolatedOAuthSite,
} from "./isolated-site-profiles.mjs";
import {
  configuredOAuthSessionProfiles,
  configForOAuthSession,
} from "./oauth-session-profiles.mjs";
import {
  configuredOAuthReloginRule,
  forceConfiguredOAuthLogout,
  tryOAuthReloginCheckinStatus,
} from "./oauth-relogin-checkin.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const provider = process.argv[3] || "LinuxDO";
if (!requestedOrigin) throw new Error("用法: node src/oauth-login.mjs <origin> [provider]");
const bookmarkOrigin = new URL(requestedOrigin).origin;
const { target: bookmarkTarget } = await findBookmarkTarget(config.bookmarksPath, bookmarkOrigin, config);
const origin = resolveOAuthRecoveryTargetOrigin(bookmarkOrigin, config, bookmarkTarget.allowedOrigins);
const isolatedOAuthSiteProfiles = configuredIsolatedOAuthSiteProfiles(config, rootDirectory);
const oauthSessionProfiles = configuredOAuthSessionProfiles(config, rootDirectory);
const isolatedConfig = configForIsolatedOAuthSite(config, isolatedOAuthSiteProfiles, bookmarkOrigin);
const sessionConfig = configForOAuthSession(isolatedConfig, oauthSessionProfiles, bookmarkOrigin);
const runtimeConfig = configForOAuthRecoveryAccount(sessionConfig, rootDirectory, bookmarkOrigin, provider);

function classifyOAuthRecoveryFailure(error) {
  const message = String(error?.message ?? "");
  if (/429|too many requests|请求次数过多|頻率限制/i.test(message)) return "oauth_rate_limited";
  if (/timeout|timed out|超时|超時/i.test(message)) return "oauth_timeout";
  if (/profile.*(?:busy|lock)|SingletonLock|user data.*(?:in use|locked)|正在使用/i.test(message)) return "profile_busy";
  if (/没有找到唯一|授权.*(?:按钮|入口)|provider.*button|oauth.*(?:state|callback|popup)|回调|回調|弹窗|彈窗/i.test(message)) {
    return "site_flow_changed";
  }
  return "oauth_recovery_failed";
}

async function trySavedLinuxDoLogin(page) {
  const location = new URL(page.url());
  if (location.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(location.pathname)) return false;

  const username = page.locator('input#login-account-name:visible, input[name="login"]:visible');
  const password = page.locator('input#login-account-password:visible, input[type="password"]:visible');
  if (await username.count() !== 1 || await password.count() !== 1) return false;
  await page.waitForTimeout(800);

  let filled = await page.evaluate(() => {
    const user = document.querySelector('input#login-account-name, input[name="login"]');
    const secret = document.querySelector('input#login-account-password, input[type="password"]');
    return Boolean(user?.value && secret?.value);
  });
  if (!filled) {
    // A real focus/keyboard gesture asks Chrome Password Manager to apply the
    // encrypted credential copied into this dedicated profile.  Values are
    // never read or logged by the automation.
    await username.click();
    await username.press("ArrowDown").catch(() => {});
    await username.press("Enter").catch(() => {});
    await page.waitForTimeout(800);
    filled = await page.evaluate(() => {
      const user = document.querySelector('input#login-account-name, input[name="login"]');
      const secret = document.querySelector('input#login-account-password, input[type="password"]');
      return Boolean(user?.value && secret?.value);
    });
  }
  if (!filled) {
    // LinuxDO also exposes a Google login button.  Once the dedicated Chrome
    // has a valid Google session this is the simplest unattended recovery
    // path and does not require handling a password or Windows Hello prompt.
    const modalClose = page.locator('button.modal-close[title="关闭"]:visible');
    if (await modalClose.count() === 1) {
      await modalClose.click({ timeout: 5000 });
      await page.waitForTimeout(300);
    }
    const googleButton = page.getByRole("button", { name: "使用 Google 登录", exact: true });
    if (await googleButton.count() === 1) {
      await googleButton.click();
      await page.waitForURL((url) => {
        const loginPath = /^\/login(?:[/?#]|$)/i.test(url.pathname);
        return url.hostname === "connect.linux.do" || (url.hostname === "linux.do" && !loginPath);
      }, { timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      const afterGoogle = new URL(page.url());
      const loginPath = /^\/login(?:[/?#]|$)/i.test(afterGoogle.pathname);
      return afterGoogle.hostname === "connect.linux.do" || (afterGoogle.hostname === "linux.do" && !loginPath);
    }
    return false;
  }

  const loginButton = page.getByRole("button", { name: "登录", exact: true });
  if (await loginButton.count() !== 1) return false;
  await loginButton.click();
  await page.waitForURL((url) => url.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(url.pathname), {
    timeout: 30000,
  }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const finalLocation = new URL(page.url());
  return finalLocation.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(finalLocation.pathname);
}

async function findVisibleProviderButton(page, providerLabels, providerAltLabels) {
  for (const label of providerLabels) {
    const roleButton = page.getByRole("button").filter({ hasText: label });
    if (await roleButton.count() === 1 && await roleButton.isVisible()) return roleButton;
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
  }
  for (const label of providerAltLabels) {
    const exactText = page.getByText(label, { exact: true });
    if (await exactText.count() === 1 && await exactText.isVisible()) return exactText;
    const candidate = page.locator(`img[alt="${label}"]`);
    if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
  }
  return null;
}

async function revealAlternateLoginOptions(page) {
  const labels = ["其他登录选项", "第三方登录", "Other login options", "Other sign-in options"];
  for (const label of labels) {
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() !== 1 || !await candidate.isVisible()) continue;
    await candidate.click();
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function startDirectLinuxDoOAuth(page, redirectOverride = "") {
  const authorizeUrl = await page.evaluate(async (configuredRedirectUri) => {
    const readJson = async (pathValue, options = {}) => {
      const response = await fetch(pathValue, { ...options, credentials: "include", headers: { Accept: "application/json", ...(options.headers ?? {}) } }).catch(() => null);
      if (!response?.ok) return null;
      return response.json().catch(() => null);
    };
    const extractOAuthState = (body) => {
      if (body?.success !== true) return "";
      if (typeof body.data === "string") return body.data.trim();
      if (typeof body.data?.flow_token === "string") return body.data.flow_token.trim();
      return "";
    };
    const readOAuthState = async () => {
      const protocolBody = await readJson("/api/oauth/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "linuxdo", intent: "login" }),
      });
      const protocolState = extractOAuthState(protocolBody);
      if (protocolState) return protocolState;

      const legacyPostState = extractOAuthState(
        await readJson("/api/oauth/state", { method: "POST" }),
      );
      if (legacyPostState) return legacyPostState;
      return extractOAuthState(await readJson("/api/oauth/state"));
    };
    const [statusBody, stateBody] = await Promise.all([
      readJson("/api/status"),
      readOAuthState(),
    ]);
    const clientId = String(statusBody?.data?.linuxdo_client_id ?? "").trim();
    const state = String(stateBody ?? "").trim();
    if (!clientId || clientId.length > 200 || !state || state.length > 512 || /[\r\n]/.test(`${clientId}${state}`)) return null;
    const url = new URL("https://connect.linux.do/oauth2/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("state", state);
    if (configuredRedirectUri) {
      const redirect = new URL(configuredRedirectUri);
      if (redirect.protocol !== "https:" || redirect.origin !== window.location.origin) return null;
      url.searchParams.set("redirect_uri", redirect.href);
    }
    return url.href;
  }, redirectOverride);
  if (!authorizeUrl) return false;
  const resolved = new URL(authorizeUrl);
  if (resolved.origin !== "https://connect.linux.do" || resolved.pathname !== "/oauth2/authorize") return false;
  const state = String(resolved.searchParams.get("state") ?? "").trim();
  if (!state || state.length > 512 || /[\r\n]/.test(state)) return false;
  await page.goto(resolved.href, { waitUntil: "domcontentloaded", timeout: 45000 });
  return state;
}

async function runOAuthFlow(context) {
  let page = await context.newPage();
  let oauthCallbackEvidence = null;
  let oauthRateLimited = false;
  let navigationFailureCode = null;
  let directOAuthState = "";
  let directAuthorizeUrl = "";
  let failedCallbackTransfer = null;
  const redirectOverride = String(config.oauthRedirectOverrides?.[origin]?.[provider] ?? "").trim();
  if (redirectOverride) {
    const override = new URL(redirectOverride);
    if (override.origin !== origin || override.protocol !== "https:") {
      throw new Error("OAuth 回调覆盖地址不属于目标站点");
    }
  }
  const callbackTasks = new Set();
  const observeOAuthCallbacks = (observedPage) => {
    observedPage.on("requestfailed", (request) => {
      if (request.resourceType() !== "document" || request.frame() !== observedPage.mainFrame()) return;
      try {
        const location = new URL(request.url());
        if (location.origin === origin) navigationFailureCode = "target_navigation_failed";
        else if (location.hostname === "connect.linux.do") navigationFailureCode = "connect_navigation_failed";
        else if (location.hostname === "linux.do") navigationFailureCode = "linuxdo_navigation_failed";
        else {
          navigationFailureCode = "unexpected_oauth_navigation_failed";
          const code = String(location.searchParams.get("code") ?? "");
          const state = String(location.searchParams.get("state") ?? "");
          if (redirectOverride && directOAuthState && state === directOAuthState
            && code && code.length <= 2048 && state.length <= 512
            && location.protocol === "https:" && !/[\r\n]/.test(`${code}${state}`)) {
            failedCallbackTransfer = { code, state };
          }
        }
      } catch {
        navigationFailureCode = "invalid_oauth_navigation";
      }
    });
    observedPage.on("response", (response) => {
      try {
        const route = new URL(response.url());
        if (response.status() === 429 && ["linux.do", "connect.linux.do"].includes(route.hostname)) {
          oauthRateLimited = true;
        }
      } catch { /* ignore non-URL responses */ }
      if (!isTargetOAuthCallback(response.url(), origin, provider)) return;
      const task = (async () => {
        const text = await response.text().catch(() => "");
        let body = null;
        try { body = JSON.parse(text); } catch { /* malformed callback response */ }
        const evidence = extractSafeOAuthCallbackEvidence(body, response.status());
        if (!oauthCallbackEvidence?.userId || evidence.userId) oauthCallbackEvidence = evidence;
      })();
      callbackTasks.add(task);
      task.finally(() => callbackTasks.delete(task));
    });
  };
  observeOAuthCallbacks(page);
  const reloginRule = configuredOAuthReloginRule(origin, config);
  if (reloginRule?.forceLogout) await forceConfiguredOAuthLogout(page, reloginRule, config);
  const configuredLoginUrl = config.oauthLoginUrls?.[origin] ?? `${origin}/login`;
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.origin !== origin || loginUrl.protocol !== "https:") throw new Error("OAuth 登录入口不属于目标站点");
  await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  if (new URL(page.url()).origin === origin) {
    const text = String(await page.locator("body").innerText().catch(() => "")).trim();
    let loginPayload = null;
    try { loginPayload = JSON.parse(text); } catch { /* normal HTML login page */ }
    if (loginPayload?.auth_url) {
      const authorize = trustedLinuxDoAuthorizeRequest(loginPayload.auth_url, origin);
      if (!authorize) throw new Error("站点返回了无效的 OAuth 授权地址");
      directOAuthState = authorize.state;
      directAuthorizeUrl = authorize.href;
      await page.goto(authorize.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    }
  }
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  let existingDailyCheckin = await tryNewApiSignIn(page, origin, config);
  if (!["signed", "already_signed"].includes(existingDailyCheckin?.status)) {
    existingDailyCheckin = await tryOAuthApiCheckin(page, origin, config);
  }
  if (!["signed", "already_signed"].includes(existingDailyCheckin?.status)
    && (config.newApiCheckinOrigins ?? []).includes(origin)) {
    existingDailyCheckin = await tryNewApiCheckin(page);
  }
  if (["signed", "already_signed"].includes(existingDailyCheckin?.status)) {
    console.log(JSON.stringify({
      origin,
      provider,
      status: "logged_in",
      finalUrl: safeLogUrl(page.url()),
      title: await page.title(),
      dailyCheckin: existingDailyCheckin,
      reusedExistingDailyEvidence: true,
    }, null, 2));
    return;
  }
  for (const agreementCheckbox of await page.getByRole("checkbox").all()) {
    if (!await agreementCheckbox.isVisible()) continue;
    const checked = await agreementCheckbox.isChecked().catch(async () => (
      await agreementCheckbox.getAttribute("aria-checked") === "true"
    ));
    if (!checked) await agreementCheckbox.click({ force: true, timeout: 5000 });
    break;
  }
  const providerVariants = [...new Set([provider, provider.replace(/linuxdo/i, "Linux DO")])];
  const providerLabels = providerVariants.flatMap((name) => [
    `使用 ${name} 继续`, `使用 ${name} 登录`, `使用 ${name} 登入`,
  ]);
  const providerAltLabels = /linux\s*do/i.test(provider)
    ? ["LINUX DO", "Linux DO", "LinuxDO"]
    : [provider, `${provider}登录`, `${provider}登入`];
  directOAuthState = trustedLinuxDoAuthorizeState(page.url());
  if (directOAuthState) directAuthorizeUrl = page.url();
  let startedDirectOAuth = Boolean(directOAuthState);
  let providerButton = null;
  if (!startedDirectOAuth) {
    providerButton = await findVisibleProviderButton(page, providerLabels, providerAltLabels);
    if (!providerButton && await revealAlternateLoginOptions(page)) {
      providerButton = await findVisibleProviderButton(page, providerLabels, providerAltLabels);
    }
    if (!providerButton) throw new Error(`没有找到唯一的 ${provider} 登录按钮`);
  }
  if (!startedDirectOAuth && redirectOverride && /linux\s*do/i.test(provider)) {
    directOAuthState = await startDirectLinuxDoOAuth(page, redirectOverride) || "";
    startedDirectOAuth = Boolean(directOAuthState);
  }
  let popup = null;
  if (!startedDirectOAuth) {
    const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await providerButton.click({ timeout: 5000 }).catch(async () => {
      // Semi UI notifications may briefly cover the otherwise unique, enabled
      // provider button.  Disable pointer handling only on that notification
      // layer, then retry a trusted browser click so window.open keeps its user
      // gesture and the OAuth popup is not blocked.
      await page.locator(".semi-portal").evaluateAll((elements) => {
        for (const element of elements) element.style.pointerEvents = "none";
      });
      await providerButton.click({ timeout: 5000 });
    });
    popup = await popupPromise;
  }
  if (popup) {
    page = popup;
    observeOAuthCallbacks(page);
  } else if (!startedDirectOAuth && /linux\s*do/i.test(provider) && new URL(page.url()).origin === origin) {
    await startDirectLinuxDoOAuth(page);
  }
  await page.waitForTimeout(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await trySavedLinuxDoLogin(page);
  const afterUpstreamLogin = new URL(page.url());
  if (directAuthorizeUrl && afterUpstreamLogin.hostname === "linux.do"
    && !/^\/login(?:[/?#]|$)/i.test(afterUpstreamLogin.pathname)) {
    await page.goto(directAuthorizeUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }

  if (redirectOverride && new URL(page.url()).hostname === "connect.linux.do") {
    const override = new URL(redirectOverride);
    const authorizeUrl = new URL(page.url());
    authorizeUrl.searchParams.set("redirect_uri", override.href);
    await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  }

  const authorizeCandidates = ["授权", "允许", "Authorize", "Allow"];
  const authorizationDeadline = Date.now() + 50000;
  let authorizationClicked = false;
  for (let authorizationPhase = 0; authorizationPhase < 3; authorizationPhase += 1) {
    const authorizationLocation = new URL(page.url());
    if (authorizationLocation.hostname === "linux.do"
      && /^\/session\/sso_provider(?:[/?#]|$)/i.test(authorizationLocation.pathname)) {
      const waitMs = Math.max(5000, Math.min(120000, Number(config.cloudflareWaitMs) || 30000));
      await page.waitForURL((url) => url.hostname !== "linux.do", { timeout: waitMs }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      if (new URL(page.url()).hostname === "linux.do") break;
      continue;
    }
    if (authorizationLocation.hostname !== "connect.linux.do") break;

    let authorizeButton = null;
    while (Date.now() < authorizationDeadline && new URL(page.url()).hostname === "connect.linux.do") {
      for (const label of authorizeCandidates) {
        const roleButton = page.getByRole("button", { name: label, exact: true });
        if (await roleButton.count() === 1) {
          authorizeButton = roleButton;
          break;
        }
        const exactText = page.getByText(label, { exact: true });
        if (await exactText.count() === 1 && await exactText.isVisible()) {
          authorizeButton = exactText;
          break;
        }
      }
      if (authorizeButton) break;
      await page.waitForTimeout(2000);
    }
    if (authorizeButton && !authorizationClicked) {
      authorizationClicked = true;
      await authorizeButton.click();
      await page.waitForURL((url) => url.hostname !== "connect.linux.do", { timeout: 50000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      continue;
    }
    if (new URL(page.url()).hostname === "connect.linux.do") break;
  }

  if (failedCallbackTransfer && redirectOverride && new URL(page.url()).protocol === "chrome-error:") {
    const override = new URL(redirectOverride);
    override.searchParams.set("code", failedCallbackTransfer.code);
    override.searchParams.set("state", failedCallbackTransfer.state);
    await page.goto(override.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }

  const completedRedirectOverride = redirectOverride;
  if (completedRedirectOverride && new URL(page.url()).origin !== origin) {
    const landed = new URL(page.url());
    const override = new URL(completedRedirectOverride);
    const code = String(landed.searchParams.get("code") || "");
    const state = String(landed.searchParams.get("state") || "");
    if (override.protocol !== "https:" || override.origin !== origin) {
      throw new Error("OAuth 回调覆盖地址不属于目标站点");
    }
    if (code && state && code.length <= 2048 && state.length <= 2048 && !/[\r\n]/.test(`${code}${state}`)) {
      override.searchParams.set("code", code);
      override.searchParams.set("state", state);
      await page.goto(override.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }
  }

  await page.waitForTimeout(1500);
  await Promise.allSettled([...callbackTasks]);
  const finalUrl = page.url();
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const finalLocation = new URL(finalUrl);
  const browserNavigationFailed = finalLocation.protocol === "chrome-error:";
  const oauthFailure = finalLocation.searchParams.has("error")
    || finalLocation.hash.includes("error=")
    || /管理员关闭了新用户注册|注册已关闭|禁止注册|registration is disabled|sign[- ]up is disabled|oauth(?:\s+|[-_])?(?:failed|error)|authorization failed/i.test(bodyText);
  const visiblePassword = await page.locator('input[type="password"]:visible').count() > 0;
  let visibleProviderLogin = false;
  for (const label of providerLabels) {
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible()) {
      visibleProviderLogin = true;
      break;
    }
  }
  if (!visibleProviderLogin) {
    for (const label of providerAltLabels) {
      const candidate = page.locator(`img[alt="${label}"]`);
      if (await candidate.count() === 1 && await candidate.isVisible()) {
        visibleProviderLogin = true;
        break;
      }
    }
  }
  let dailyCheckin = null;
  const signInRule = configuredNewApiSignInRule(origin, config);
  if (signInRule && oauthCallbackEvidence?.userId && finalLocation.origin === origin) {
    await page.evaluate(({ storageKey, userId }) => {
      localStorage.setItem(storageKey, JSON.stringify({ id: userId }));
    }, { storageKey: signInRule.userStorageKeys[0], userId: oauthCallbackEvidence.userId });
    dailyCheckin = await tryNewApiSignIn(page, origin, config);
  }
  if (!dailyCheckin && oauthCallbackEvidence?.success && oauthCallbackEvidence.checkedIn === true) {
    dailyCheckin = {
      status: "signed",
      reason: "OAuth 回调确认今日额度已发放",
      evidence: { source: "oauth_callback" },
    };
  }
  if (!["signed", "already_signed"].includes(dailyCheckin?.status)
    && finalLocation.origin === origin) {
    dailyCheckin = await tryOAuthApiCheckin(page, origin, config);
  }
  if (!["signed", "already_signed"].includes(dailyCheckin?.status)
    && (config.newApiCheckinOrigins ?? []).includes(origin)
    && finalLocation.origin === origin) {
    dailyCheckin = await tryNewApiCheckin(page);
  }
  let loggedIn = !browserNavigationFailed && (["signed", "already_signed"].includes(dailyCheckin?.status)
    || finalLocation.origin === origin
    && !isLoginOrSignInRoute(finalLocation.href)
    && !visiblePassword
    && !visibleProviderLogin
    && !oauthFailure);
  const transferredCallbackRejected = Boolean(
    failedCallbackTransfer && oauthCallbackEvidence && oauthCallbackEvidence.success !== true,
  );
  if (loggedIn && reloginRule) {
    const verificationDeadline = Date.now() + reloginRule.verificationWaitMs;
    do {
      dailyCheckin = await tryOAuthReloginCheckinStatus(page, origin, config, "signed");
      if (["signed", "already_signed", "deferred", "needs_attention"].includes(dailyCheckin?.status)) break;
      await page.waitForTimeout(1000);
    } while (Date.now() < verificationDeadline);
    loggedIn = ["signed", "already_signed"].includes(dailyCheckin?.status);
  }
  const dailyFailureCode = dailyCheckin?.status === "deferred"
    ? (dailyCheckin.retryCause === "rate_limit" ? "oauth_rate_limited" : "oauth_upstream_unavailable")
    : null;
  console.log(JSON.stringify({
    origin,
    provider,
    status: loggedIn ? "logged_in" : (oauthRateLimited || browserNavigationFailed || transferredCallbackRejected || dailyFailureCode ? "failed" : "needs_attention"),
    ...(oauthRateLimited
      ? { failureCode: "oauth_rate_limited" }
      : transferredCallbackRejected
        ? { failureCode: "oauth_upstream_unavailable" }
      : browserNavigationFailed
        ? { failureCode: "site_flow_changed", navigationFailureCode: navigationFailureCode ?? "unknown_navigation_failure" }
        : dailyFailureCode
          ? { failureCode: dailyFailureCode }
        : {}),
    finalUrl: safeLogUrl(finalUrl),
    title: await page.title(),
    dailyCheckin,
    oauthCallback: oauthCallbackEvidence ? {
      httpStatus: oauthCallbackEvidence.httpStatus,
      success: oauthCallbackEvidence.success,
      userIdDetected: Boolean(oauthCallbackEvidence.userId),
      checkedIn: oauthCallbackEvidence.checkedIn,
      errorCategory: oauthCallbackEvidence.errorCategory,
    } : null,
  }, null, 2));
  if (!loggedIn) process.exitCode = 2;
}

let context;
try {
  context = await launchAutomationContext(runtimeConfig);
  await runOAuthFlow(context);
} catch (error) {
  console.log(JSON.stringify({
    origin,
    provider,
    status: "failed",
    failureCode: classifyOAuthRecoveryFailure(error),
  }));
  process.exitCode = 2;
} finally {
  await context?.close().catch(() => {});
}
