import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import {
  configuredOAuthReloginRule,
  forceConfiguredOAuthLogout,
  parseObservedBrowserUrl,
  tryOAuthReloginCheckinStatus,
} from "./oauth-relogin-checkin.mjs";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const port = Number.parseInt(process.argv[2], 10);
const requestedOrigin = process.argv[3];
const provider = process.argv[4] || "LinuxDO";

if (!Number.isInteger(port) || port <= 0 || !requestedOrigin) {
  throw new Error("用法: node src/native-oauth-login.mjs <port> <origin> [provider]");
}

const origin = new URL(requestedOrigin).origin;
await findBookmarkTarget(config.bookmarksPath, origin, config);
const rule = configuredOAuthReloginRule(origin, config);
if (!rule?.nativeBrowser) throw new Error("目标站点没有启用原生浏览器 OAuth 恢复");

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

async function tryExistingGoogleLinuxDoLogin(page) {
  const location = new URL(page.url());
  if (location.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(location.pathname)) return false;
  const modalClose = page.locator('button.modal-close[title="关闭"]:visible');
  if (await modalClose.count() === 1) {
    await modalClose.click({ timeout: 5000 });
    await page.waitForTimeout(300);
  }
  const googleButton = page.getByRole("button", { name: "使用 Google 登录", exact: true });
  if (await googleButton.count() !== 1 || !await googleButton.isVisible()) return false;
  await googleButton.click({ timeout: 10000 });
  await page.waitForURL((url) => {
    const loginPath = /^\/login(?:[/?#]|$)/i.test(url.pathname);
    return url.hostname !== "linux.do" || !loginPath;
  }, { timeout: 45000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const afterGoogle = new URL(page.url());
  return afterGoogle.hostname !== "linux.do" || !/^\/login(?:[/?#]|$)/i.test(afterGoogle.pathname);
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
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
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

  if (rule.forceLogout) await forceConfiguredOAuthLogout(page, rule, config);
  const configuredLoginUrl = config.oauthLoginUrls?.[origin] ?? `${origin}/login`;
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.protocol !== "https:" || loginUrl.origin !== origin || loginUrl.username || loginUrl.password) {
    throw new Error("OAuth 登录入口不属于目标站点");
  }
  await page.goto(loginUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: Number(config.navigationTimeoutMs) || 20000,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  const agreementCheckbox = page.locator('input[type="checkbox"]:visible');
  if (await agreementCheckbox.count() === 1 && !await agreementCheckbox.isChecked()) {
    await agreementCheckbox.check({ force: true, timeout: 5000 });
  }

  const labels = providerLabels(provider);
  let providerButton = await findProviderButton(page, labels);
  if (!providerButton && await revealAlternateLoginOptions(page)) {
    providerButton = await findProviderButton(page, labels);
  }
  if (!providerButton) throw new Error(`没有找到唯一的 ${provider} 登录按钮`);

  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await providerButton.click({ timeout: 10000 });
  const popup = await popupPromise;
  if (popup) page = popup;
  await page.waitForTimeout(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});

  const oauthDeadline = Date.now()
    + Math.max(30000, Math.min(120000, Number(config.cloudflareWaitMs) || 90000));
  let authorizeClicked = false;
  let googleLoginAttempted = false;
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
      if (!googleLoginAttempted) {
        googleLoginAttempted = true;
        if (await tryExistingGoogleLinuxDoLogin(page)) continue;
      }
      throw new Error("机器人 Chrome 的 Linux DO 登录已失效，且现有 Google 会话未能自动恢复");
    }
    if (/accounts\.google\.com$/i.test(location.hostname)) {
      throw new Error("机器人 Chrome 需要人工确认一次 Google 登录后才能恢复 Linux DO");
    }
    await page.waitForTimeout(1000);
  }
  if (!callbackReached) throw new Error("Linux DO 验证未在限定时间内回到目标站点");

  // The callback page finishes the server-side OAuth exchange with JavaScript.
  // Let that request settle before navigating to the authoritative log page.
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(5000);
  await page.goto(rule.logPageUrl, {
    waitUntil: "domcontentloaded",
    timeout: Number(config.navigationTimeoutMs) || 20000,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

  const verificationDeadline = Date.now() + rule.verificationWaitMs;
  let dailyCheckin = null;
  do {
    dailyCheckin = await tryOAuthReloginCheckinStatus(page, origin, config, "signed");
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
    dailyCheckin,
  }));
  if (!completed) process.exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({
    origin,
    provider,
    status: "needs_attention",
    finalUrl: page && !page.isClosed() ? safeLogUrl(page.url()) : origin,
    checkedIn,
    reason: safeFailureReason(error),
  }));
  process.exitCode = 2;
} finally {
  await browser?.close().catch(() => {});
}
