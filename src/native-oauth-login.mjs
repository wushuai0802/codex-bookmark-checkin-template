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
if (!configuredExpectedAccountId) throw new Error("原生 OAuth 恢复必须配置预期账号 ID");

const CONNECT_LINUX_DO_ORIGIN = "https://connect.linux.do";
const CONNECT_AUTHORIZATION_LABELS = Object.freeze([
  "同意",
  "确认授权",
  "同意并继续",
  "继续",
  "Approve",
  "Continue",
  "允许",
  "授权",
  "Allow",
  "Authorize",
]);
const MAX_CONNECT_AUTHORIZATION_CLICKS = 3;
const MIN_CONNECT_AUTHORIZATION_CLICK_INTERVAL_MS = 5000;
const CONNECT_TURNSTILE_PASSIVE_WAIT_MS = 3000;
const CONNECT_TURNSTILE_SETTLE_WAIT_MS = 3000;
const CONNECT_MANAGED_CHALLENGE_TITLE = /just a moment|checking your browser|请稍候|請稍候|请稍等|請稍等|安全验证|安全驗證/i;

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

function isConnectLinuxDoAuthorizationPage(page) {
  return parseObservedBrowserUrl(page.url())?.origin === CONNECT_LINUX_DO_ORIGIN;
}

async function findConnectLinuxDoAuthorizationControl(page) {
  if (!isConnectLinuxDoAuthorizationPage(page)) return null;
  const matches = [];
  for (const label of CONNECT_AUTHORIZATION_LABELS) {
    const buttonLike = page.getByRole("button", { name: label, exact: true });
    for (let index = 0; index < await buttonLike.count(); index += 1) {
      const candidate = buttonLike.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const kind = await candidate.evaluate((element) => {
        const tagName = element.tagName.toLowerCase();
        const type = String(element.getAttribute("type") || "").toLowerCase();
        if (tagName === "button") return "button";
        if (tagName === "input" && type === "submit") return "submit";
        return null;
      }).catch(() => null);
      if (kind) matches.push(candidate);
    }
    const links = page.getByRole("link", { name: label, exact: true });
    for (let index = 0; index < await links.count(); index += 1) {
      const candidate = links.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const isLink = await candidate.evaluate((element) => element.tagName.toLowerCase() === "a")
        .catch(() => false);
      if (isLink) matches.push(candidate);
    }
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

async function clickConnectLinuxDoAuthorization(page, state) {
  if (!isConnectLinuxDoAuthorizationPage(page)) return false;
  let control = await findConnectLinuxDoAuthorizationControl(page);
  if (!control) return false;
  if (state.clicks >= MAX_CONNECT_AUTHORIZATION_CLICKS) {
    throw new Error("Linux DO OAuth 授权步骤超过安全点击上限");
  }
  const remainingInterval = state.lastClickedAt > 0
    ? MIN_CONNECT_AUTHORIZATION_CLICK_INTERVAL_MS - (Date.now() - state.lastClickedAt)
    : 0;
  if (remainingInterval > 0) await page.waitForTimeout(remainingInterval);
  if (!isConnectLinuxDoAuthorizationPage(page)) return false;
  control = await findConnectLinuxDoAuthorizationControl(page);
  if (!control) return false;
  await control.click({ timeout: 10000 });
  state.clicks += 1;
  state.lastClickedAt = Date.now();
  return true;
}

async function inspectConnectLinuxDoTurnstile(page) {
  if (!isConnectLinuxDoAuthorizationPage(page)) return { present: false, ready: false };
  const managedChallengeTitle = CONNECT_MANAGED_CHALLENGE_TITLE.test(await page.title().catch(() => ""));
  const response = page.locator([
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
  ].join(", "));
  const ready = await response.evaluateAll((elements) => elements.some((element) => {
    return typeof element.value === "string" && element.value.length > 20;
  })).catch(() => false);
  const frames = page.locator([
    'iframe[src*="challenges.cloudflare.com"]:visible',
    'iframe[src*="turnstile" i]:visible',
  ].join(", "));
  const widgets = page.locator([
    '.cf-turnstile:visible',
    '[data-turnstile-widget-id]:visible',
    '#challenge-stage:visible',
    '#turnstile-wrapper:visible',
  ].join(", "));
  return {
    present: managedChallengeTitle || await response.count() > 0 || await frames.count() > 0 || await widgets.count() > 0,
    ready,
  };
}

async function interactWithConnectLinuxDoTurnstileOnce(page) {
  if (!isConnectLinuxDoAuthorizationPage(page)) return false;
  const checkbox = page.frameLocator([
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile" i]',
  ].join(", ")).locator('input[type="checkbox"]:visible');
  if (await checkbox.count() === 1) {
    await checkbox.click({ timeout: 5000 });
    return true;
  }

  const frames = page.locator([
    'iframe[src*="challenges.cloudflare.com"]:visible',
    'iframe[src*="turnstile" i]:visible',
  ].join(", "));
  let target = await frames.count() === 1 ? frames.first() : null;
  if (!target && await frames.count() === 0) {
    for (const selector of [
      '.cf-turnstile:visible, [data-turnstile-widget-id]:visible',
      '#turnstile-wrapper:visible',
      '#challenge-stage:visible',
    ]) {
      const candidates = page.locator(selector);
      if (await candidates.count() === 1) {
        target = candidates.first();
        break;
      }
    }
  }
  if (!target && CONNECT_MANAGED_CHALLENGE_TITLE.test(await page.title().catch(() => ""))) {
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
    if (!viewport || viewport.width < 600 || viewport.height < 400) return false;
    await page.mouse.click((viewport.width / 2) - 120, viewport.height * 0.6);
    return true;
  }
  if (!target) return false;
  const box = await target.boundingBox().catch(() => null);
  if (!box || box.width < 8 || box.height < 8) return false;
  const leftOffset = Math.min(box.width - 2, Math.max(6, Math.min(32, box.width * 0.1)));
  await page.mouse.click(box.x + leftOffset, box.y + box.height / 2);
  return true;
}

async function handleConnectLinuxDoTurnstile(page, state) {
  if (!isConnectLinuxDoAuthorizationPage(page)) return false;
  let challenge = await inspectConnectLinuxDoTurnstile(page);
  if (!challenge.present) return false;

  if (!state.passiveWaitCompleted) {
    state.passiveWaitCompleted = true;
    await page.waitForTimeout(CONNECT_TURNSTILE_PASSIVE_WAIT_MS);
    if (!isConnectLinuxDoAuthorizationPage(page)) return true;
    if (await findConnectLinuxDoAuthorizationControl(page)) return true;
    challenge = await inspectConnectLinuxDoTurnstile(page);
  }
  if (!challenge.present || challenge.ready || state.interactionAttempted) return true;

  const interacted = await interactWithConnectLinuxDoTurnstileOnce(page);
  if (interacted) {
    state.interactionAttempted = true;
    await page.waitForTimeout(CONNECT_TURNSTILE_SETTLE_WAIT_MS);
  }
  return true;
}

async function startLinuxDoUpstreamLogin(page, loginProvider) {
  const location = new URL(page.url());
  if (location.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(location.pathname)) return null;
  const modalClose = page.locator('button.modal-close[title="关闭"]:visible');
  if (await modalClose.count() === 1) {
    await modalClose.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
  let providerButton = await findProviderButton(page, providerLabels(loginProvider));
  if (!providerButton && await revealAlternateLoginOptions(page)) {
    providerButton = await findProviderButton(page, providerLabels(loginProvider));
  }
  if (!providerButton) return null;
  const popupPromise = page.waitForEvent("popup", { timeout: 7000 }).catch(() => null);
  const samePagePromise = page.waitForURL((url) => {
    return url.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(url.pathname);
  }, { waitUntil: "domcontentloaded", timeout: 7000 }).then(() => page).catch(() => null);
  await providerButton.click({ timeout: 10000 });
  const activePage = await Promise.race([
    popupPromise,
    samePagePromise,
    page.waitForTimeout(7000).then(() => null),
  ]);
  if (!activePage) return null;
  await activePage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await activePage.waitForTimeout(1000);
  return activePage;
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
try {
  browser = await connectOverCdpWithRetry(chromium, port, { timeoutMs: 20000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error("原生 Chrome 没有可用浏览器上下文");
  // A session cookie can complete the callback server-side. Callback evidence
  // is optional, so this helper never reads or prints the callback body.

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
  const existingAccountId = (await readOAuthAccountIdentity(page, origin))?.accountId ?? null;
  const existingIdentityMatches = existingAccountId === configuredExpectedAccountId;
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
      accountKey,
      accountId: configuredExpectedAccountId,
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
    let upstreamLoginAttempted = false;
    let resumeTargetAfterUpstream = false;
    const connectAuthorizationState = { clicks: 0, lastClickedAt: 0 };
    const connectTurnstileState = { passiveWaitCompleted: false, interactionAttempted: false };
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
    if (location.origin === CONNECT_LINUX_DO_ORIGIN) {
      if (await clickConnectLinuxDoAuthorization(page, connectAuthorizationState)) {
        await page.waitForTimeout(1000);
        continue;
      }
      if (await handleConnectLinuxDoTurnstile(page, connectTurnstileState)) {
        await page.waitForTimeout(1000);
        continue;
      }
    }
    if (location.hostname === "linux.do" && /^\/login(?:[/?#]|$)/i.test(location.pathname)) {
      if (!upstreamLoginAttempted) {
        upstreamLoginAttempted = true;
        resumeTargetAfterUpstream = true;
        const upstreamPage = await startLinuxDoUpstreamLogin(page, upstreamProvider);
        if (upstreamPage) {
          page = upstreamPage;
          continue;
        }
      }
      throw new Error(`机器人 Chrome 的 Linux DO 登录已失效，且现有 ${upstreamProvider} 会话未能自动恢复`);
    }
    if (resumeTargetAfterUpstream && location.hostname === "linux.do") {
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      page = await beginTargetProviderLogin(page);
      resumeTargetAfterUpstream = false;
      // Upstream login starts a distinct authorization cycle with a fresh
      // Turnstile widget. Give only that new page one bounded interaction;
      // upstreamLoginAttempted prevents repeated resets.
      connectTurnstileState.passiveWaitCompleted = false;
      connectTurnstileState.interactionAttempted = false;
      continue;
    }
    if (location.hostname === "github.com") {
      if (/^\/login(?:[/?#]|$)/i.test(location.pathname)) {
        throw new Error("机器人 Chrome 需要人工确认一次 GitHub 登录");
      }
      if (/\/login\/oauth\/authorize/i.test(location.pathname)) {
        throw new Error("机器人 Chrome 需要人工确认一次 GitHub 授权");
      }
    }
    if (/accounts\.google\.com$/i.test(location.hostname)) {
      throw new Error("机器人 Chrome 需要人工确认一次 Google 登录后才能恢复 Linux DO");
    }
    await page.waitForTimeout(1000);
    }
    if (!callbackReached) {
      throw new Error(`${provider} OAuth 未在限定时间内回到目标站点（授权点击=${connectAuthorizationState.clicks}，验证交互=${connectTurnstileState.interactionAttempted ? 1 : 0}，上游恢复=${upstreamLoginAttempted ? 1 : 0}，等待重建=${resumeTargetAfterUpstream ? 1 : 0}）`);
    }

  // The callback page finishes the server-side OAuth exchange with JavaScript.
  // Let that request settle before navigating to the authoritative log page.
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.goto(rule.logPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(runtimeConfig.navigationTimeoutMs) || 20000,
  });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const observedAccountId = (await readOAuthAccountIdentity(page, origin))?.accountId ?? null;
    if (observedAccountId !== configuredExpectedAccountId) {
      throw new Error("OAuth 登录账号与配置不匹配");
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
      accountKey,
      accountId: configuredExpectedAccountId,
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
