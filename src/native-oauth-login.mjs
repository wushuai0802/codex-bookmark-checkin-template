import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import {
  configuredOAuthReloginRule,
  forceConfiguredOAuthLogout,
  parseObservedBrowserUrl,
  readOAuthAccountIdentity,
  tryOAuthReloginCheckinStatus,
} from "./oauth-relogin-checkin.mjs";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const port = Number.parseInt(process.argv[2], 10);
const requestedOrigin = process.argv[3];
const provider = process.argv[4] || "LinuxDO";
const expectedAccountId = String(process.argv[5] || "").trim();
const accountKey = String(process.argv[6] || "").trim();
const accountLabel = String(process.argv[7] || expectedAccountId).trim();
const requestedUpstreamProvider = String(process.argv[8] || "").trim();
const requestedLoginUrl = String(process.argv[9] || "").trim();

if (!Number.isInteger(port) || port <= 0 || !requestedOrigin) {
  throw new Error("用法: node src/native-oauth-login.mjs <port> <origin> [provider]");
}

const origin = new URL(requestedOrigin).origin;
const upstreamProvider = requestedUpstreamProvider
  || String(config.oauthUpstreamProviders?.[origin] || (provider === "LinuxDO" ? "" : provider)).trim();
if (!upstreamProvider) throw new Error("Linux DO OAuth 恢复必须显式配置上游登录方式");
const runtimeConfig = expectedAccountId || requestedLoginUrl ? {
  ...config,
  ...(expectedAccountId ? {
    oauthExpectedAccountIds: { ...(config.oauthExpectedAccountIds ?? {}), [origin]: expectedAccountId },
  } : {}),
  ...(requestedLoginUrl ? {
    oauthLoginUrls: { ...(config.oauthLoginUrls ?? {}), [origin]: requestedLoginUrl },
  } : {}),
} : config;
await findBookmarkTarget(runtimeConfig.bookmarksPath, origin, runtimeConfig);
const rule = configuredOAuthReloginRule(origin, runtimeConfig);
if (!rule?.nativeBrowser) throw new Error("目标站点没有启用原生浏览器 OAuth 恢复");
const configuredExpectedAccountId = expectedAccountId || rule.expectedAccountId;

function providerLabels(name) {
  const variants = [...new Set([name, name.replace(/linuxdo/i, "Linux DO")])];
  return {
    text: variants.flatMap((value) => [
      `使用 ${value} 继续`,
      `使用 ${value} 登录`,
      `使用 ${value} 登入`,
    ]),
    alt: /linux\s*do/i.test(name) ? ["LINUX DO", "Linux DO", "LinuxDO"] : [name],
  };
}

async function findProviderButton(page, labels) {
  for (const label of labels.text) {
    const roleButton = page.getByRole("button").filter({ hasText: label });
    if (await roleButton.count() === 1 && await roleButton.isVisible()) return roleButton;
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible()) return candidate;
  }
  for (const label of labels.alt) {
    const image = page.locator(`img[alt="${label}"]`);
    if (await image.count() !== 1 || !await image.isVisible()) continue;
    const button = image.locator("xpath=ancestor::button[1]");
    return await button.count() === 1 ? button : image;
  }
  return null;
}

async function revealAlternateLoginOptions(page) {
  for (const label of ["其他登录选项", "第三方登录", "Other login options", "Other sign-in options"]) {
    const candidate = page.getByText(label, { exact: true });
    if (await candidate.count() !== 1 || !await candidate.isVisible()) continue;
    await candidate.click();
    await page.waitForTimeout(300);
    return true;
  }
  return false;
}

async function findAuthorizeButton(page) {
  for (const label of ["允许", "授权", "Allow", "Authorize"]) {
    const byRole = page.getByRole("button", { name: label, exact: true });
    if (await byRole.count() === 1 && await byRole.isVisible()) return byRole;
    const byText = page.getByText(label, { exact: true });
    if (await byText.count() === 1 && await byText.isVisible()) return byText;
  }
  return null;
}

async function startLinuxDoUpstreamLogin(page, loginProvider) {
  const location = new URL(page.url());
  if (location.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(location.pathname)) return false;
  const modalClose = page.locator('button.modal-close[title="关闭"]:visible');
  if (await modalClose.count() === 1) {
    await modalClose.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
  let providerButton = await findProviderButton(page, providerLabels(loginProvider));
  if (!providerButton && await revealAlternateLoginOptions(page)) {
    providerButton = await findProviderButton(page, providerLabels(loginProvider));
  }
  if (!providerButton) return false;
  await providerButton.click({ timeout: 10000 });
  await page.waitForTimeout(1000);
  return true;
}

function isTargetLogin(url) {
  return url.origin === origin && /\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(url.href);
}

function safeFailureReason(error) {
  const message = String(error?.message || "原生 OAuth 恢复失败")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return message.slice(0, 240);
}

let browser = null;
let page = null;
let checkedIn = null;
try {
  browser = await connectOverCdpWithRetry(chromium, port, { timeoutMs: 20000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("原生 Chrome 没有可用浏览器上下文");

  const observeCallback = (candidate) => {
    candidate.on("response", async (response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== origin || !/^\/api\/oauth\//i.test(url.pathname)) return;
        const text = await response.text();
        const body = JSON.parse(text);
        const value = body?.checked_in ?? body?.data?.checked_in;
        if (typeof value === "boolean") checkedIn = value;
      } catch { /* callback evidence is optional */ }
    });
  };
  for (const candidate of context.pages()) observeCallback(candidate);
  context.on("page", observeCallback);

  page = context.pages().find((candidate) => {
    return parseObservedBrowserUrl(candidate.url())?.origin === origin;
  }) ?? context.pages()[0];
  if (!page) throw new Error("原生 Chrome 中没有找到目标登录页");

  const configuredLoginUrl = runtimeConfig.oauthLoginUrls?.[origin] ?? `${origin}/login`;
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.protocol !== "https:" || loginUrl.origin !== origin || loginUrl.username || loginUrl.password) {
    throw new Error("OAuth 登录入口不属于目标站点");
  }

  // A completed daily reward is authoritative for the rest of the local day.
  // Check it before logging out so retries, acceptance runs, and manual audits
  // do not repeatedly trigger the upstream OAuth provider's rate limit.
  await page.goto(rule.logPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(runtimeConfig.navigationTimeoutMs) || 20000,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const existingAccountIdentity = await readOAuthAccountIdentity(page, origin);
  const existingIdentityMatches = !configuredExpectedAccountId
    || existingAccountIdentity?.accountId === configuredExpectedAccountId;
  const existingDailyCheckin = existingIdentityMatches
    ? await tryOAuthReloginCheckinStatus(page, origin, runtimeConfig, "already_signed")
    : null;
  const reuseExistingDailyEvidence = ["signed", "already_signed"].includes(existingDailyCheckin?.status);

  if (reuseExistingDailyEvidence) {
    console.log(JSON.stringify({
      origin,
      provider,
      status: "logged_in",
      finalUrl: safeLogUrl(page.url()),
      checkedIn: null,
      accountKey,
      accountId: existingAccountIdentity?.accountId ?? (configuredExpectedAccountId || null),
      accountLabel,
      upstreamProvider,
      reusedExistingDailyEvidence: true,
      dailyCheckin: existingDailyCheckin,
    }));
  } else {
    if (rule.forceLogout) await forceConfiguredOAuthLogout(page, rule, runtimeConfig);

    const beginTargetProviderLogin = async (activePage) => {
    await activePage.goto(loginUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: Number(runtimeConfig.navigationTimeoutMs) || 20000,
    });
    await activePage.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const agreementCheckbox = activePage.locator('input[type="checkbox"]:visible');
    if (await agreementCheckbox.count() === 1 && !await agreementCheckbox.isChecked()) {
      await agreementCheckbox.check({ force: true, timeout: 5000 });
    }
    const labels = providerLabels(provider);
    let providerButton = await findProviderButton(activePage, labels);
    if (!providerButton && await revealAlternateLoginOptions(activePage)) {
      providerButton = await findProviderButton(activePage, labels);
    }
    if (!providerButton) throw new Error(`没有找到唯一的 ${provider} 登录按钮`);
    const popupPromise = activePage.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
    await providerButton.click({ timeout: 10000 });
    const popup = await popupPromise;
    const nextPage = popup ?? activePage;
    await nextPage.waitForTimeout(1500);
    await nextPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    return nextPage;
    };

    page = await beginTargetProviderLogin(page);

    const oauthDeadline = Date.now()
    + Math.max(30000, Math.min(120000, Number(runtimeConfig.cloudflareWaitMs) || 90000));
    let authorizeClicked = false;
    let upstreamLoginAttempted = false;
    let resumeTargetAfterUpstream = false;
    let githubAuthorizeAttempted = false;
    let callbackReached = false;
    while (Date.now() < oauthDeadline) {
    if (page.isClosed()) {
      const targetPage = [...context.pages()].reverse().find((candidate) => {
        const url = parseObservedBrowserUrl(candidate.url());
        return url?.origin === origin && !isTargetLogin(url);
      });
      if (targetPage) page = targetPage;
      else {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
    }

    const location = parseObservedBrowserUrl(page.url());
    if (!location) {
      await page.waitForTimeout(500);
      continue;
    }
    if (location.origin === origin && !isTargetLogin(location)) {
      callbackReached = true;
      break;
    }
    if (location.hostname === "connect.linux.do" && !authorizeClicked) {
      const authorizeButton = await findAuthorizeButton(page);
      if (authorizeButton) {
        authorizeClicked = true;
        await authorizeButton.click({ timeout: 10000 });
        await page.waitForTimeout(1000);
        continue;
      }
    }
    if (location.hostname === "linux.do" && /^\/login(?:[/?#]|$)/i.test(location.pathname)) {
      if (!upstreamLoginAttempted) {
        upstreamLoginAttempted = true;
        resumeTargetAfterUpstream = true;
        if (await startLinuxDoUpstreamLogin(page, upstreamProvider)) continue;
      }
      throw new Error(`机器人 Chrome 的 Linux DO 登录已失效，且现有 ${upstreamProvider} 会话未能自动恢复`);
    }
    if (resumeTargetAfterUpstream && location.hostname === "linux.do") {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      page = await beginTargetProviderLogin(page);
      resumeTargetAfterUpstream = false;
      authorizeClicked = false;
      continue;
    }
    if (location.hostname === "github.com") {
      if (/^\/login(?:[/?#]|$)/i.test(location.pathname)) {
        throw new Error("机器人 Chrome 需要人工确认一次 GitHub 登录");
      }
      if (!githubAuthorizeAttempted && /\/login\/oauth\/authorize/i.test(location.pathname)) {
        const authorize = page.locator('button[name="authorize"]:visible');
        if (await authorize.count() === 1) {
          githubAuthorizeAttempted = true;
          await authorize.click({ timeout: 10000 });
          await page.waitForTimeout(1000);
          continue;
        }
      }
    }
    if (/accounts\.google\.com$/i.test(location.hostname)) {
      throw new Error("机器人 Chrome 需要人工确认一次 Google 登录后才能恢复 Linux DO");
    }
    await page.waitForTimeout(1000);
    }
    if (!callbackReached) throw new Error(`${provider} OAuth 未在限定时间内回到目标站点`);

  // The callback page finishes the server-side OAuth exchange with JavaScript.
  // Let that request settle before navigating to the authoritative log page.
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.goto(rule.logPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(runtimeConfig.navigationTimeoutMs) || 20000,
  });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const accountIdentity = await readOAuthAccountIdentity(page, origin);
    if (configuredExpectedAccountId && accountIdentity?.accountId !== configuredExpectedAccountId) {
      throw new Error(`OAuth 登录账号不匹配，期望 ${configuredExpectedAccountId}，实际 ${accountIdentity?.accountId || "unknown"}`);
    }

    const verificationDeadline = Date.now() + rule.verificationWaitMs;
    let dailyCheckin = null;
    do {
      dailyCheckin = await tryOAuthReloginCheckinStatus(page, origin, runtimeConfig, "signed");
      if (["signed", "already_signed"].includes(dailyCheckin?.status) || dailyCheckin?.status === "unconfirmed") break;
      await page.waitForTimeout(1000);
    } while (Date.now() < verificationDeadline);

    const completed = ["signed", "already_signed"].includes(dailyCheckin?.status);
    console.log(JSON.stringify({
      origin,
      provider,
      status: completed ? "logged_in" : "needs_attention",
      finalUrl: safeLogUrl(page.url()),
      checkedIn,
      accountKey,
      accountId: accountIdentity?.accountId ?? (configuredExpectedAccountId || null),
      accountLabel,
      upstreamProvider,
      reusedExistingDailyEvidence: false,
      dailyCheckin,
    }));
    if (!completed) process.exitCode = 2;
  }
} catch (error) {
  console.log(JSON.stringify({
    origin,
    provider,
    status: "needs_attention",
    finalUrl: page && !page.isClosed() ? safeLogUrl(page.url()) : origin,
    checkedIn,
    accountKey,
    accountId: configuredExpectedAccountId || null,
    accountLabel,
    upstreamProvider,
    reason: safeFailureReason(error),
  }));
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
}
