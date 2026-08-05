import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { safeLogUrl } from "./security.mjs";
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
const origin = new URL(requestedOrigin).origin;
await findBookmarkTarget(config.bookmarksPath, origin, config);

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

const context = await launchAutomationContext(config);
try {
  let page = await context.newPage();
  const reloginRule = configuredOAuthReloginRule(origin, config);
  if (reloginRule?.forceLogout) await forceConfiguredOAuthLogout(page, reloginRule, config);
  const configuredLoginUrl = config.oauthLoginUrls?.[origin] ?? `${origin}/login`;
  const loginUrl = new URL(configuredLoginUrl);
  if (loginUrl.origin !== origin || loginUrl.protocol !== "https:") throw new Error("OAuth 登录入口不属于目标站点");
  await page.goto(loginUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const agreementCheckbox = page.locator('input[type="checkbox"]:visible');
  if (await agreementCheckbox.count() === 1 && !await agreementCheckbox.isChecked()) {
    await agreementCheckbox.check({ force: true, timeout: 5000 });
  }
  const providerVariants = [...new Set([provider, provider.replace(/linuxdo/i, "Linux DO")])];
  const providerLabels = providerVariants.flatMap((name) => [
    `使用 ${name} 继续`, `使用 ${name} 登录`, `使用 ${name} 登入`,
  ]);
  const providerAltLabels = /linux\s*do/i.test(provider)
    ? ["LINUX DO", "Linux DO", "LinuxDO"]
    : [provider, `${provider}登录`, `${provider}登入`];
  let providerButton = await findVisibleProviderButton(page, providerLabels, providerAltLabels);
  if (!providerButton && await revealAlternateLoginOptions(page)) {
    providerButton = await findVisibleProviderButton(page, providerLabels, providerAltLabels);
  }
  if (!providerButton) throw new Error(`没有找到唯一的 ${provider} 登录按钮`);
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await providerButton.click();
  const popup = await popupPromise;
  if (popup) page = popup;
  await page.waitForTimeout(1500);
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await trySavedLinuxDoLogin(page);

  const redirectOverride = config.oauthRedirectOverrides?.[origin]?.[provider];
  if (redirectOverride && new URL(page.url()).hostname === "connect.linux.do") {
    const override = new URL(redirectOverride);
    if (override.origin !== origin || override.protocol !== "https:") throw new Error("OAuth 回调覆盖地址不属于目标站点");
    const authorizeUrl = new URL(page.url());
    authorizeUrl.searchParams.set("redirect_uri", override.href);
    await page.goto(authorizeUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  }

  if (new URL(page.url()).hostname === "connect.linux.do") {
    const authorizeCandidates = ["授权", "允许", "Authorize", "Allow"];
    const challengeDeadline = Date.now() + 50000;
    let authorizeButton = null;
    while (Date.now() < challengeDeadline && new URL(page.url()).hostname === "connect.linux.do") {
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
    if (authorizeButton) {
      await authorizeButton.click();
      await page.waitForURL((url) => url.hostname !== "connect.linux.do", { timeout: 50000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    }
  }

  const discourseSso = new URL(page.url());
  if (discourseSso.hostname === "linux.do" && /^\/session\/sso_provider(?:[/?#]|$)/i.test(discourseSso.pathname)) {
    const waitMs = Math.max(5000, Math.min(120000, Number(config.cloudflareWaitMs) || 30000));
    await page.waitForURL((url) => url.origin === origin, { timeout: waitMs }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  }

  await page.waitForTimeout(1500);
  const finalUrl = page.url();
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const finalLocation = new URL(finalUrl);
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
  let loggedIn = finalLocation.origin === origin
    && !/\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i.test(finalLocation.href)
    && !visiblePassword
    && !visibleProviderLogin;
  let dailyCheckin = null;
  if (loggedIn && reloginRule) {
    const verificationDeadline = Date.now() + reloginRule.verificationWaitMs;
    do {
      dailyCheckin = await tryOAuthReloginCheckinStatus(page, origin, config, "signed");
      if (["signed", "already_signed"].includes(dailyCheckin?.status) || dailyCheckin?.status === "unconfirmed") break;
      await page.waitForTimeout(1000);
    } while (Date.now() < verificationDeadline);
    loggedIn = ["signed", "already_signed"].includes(dailyCheckin?.status);
  }
  const screenshotPath = path.join(rootDirectory, "tmp", `oauth-${new URL(origin).hostname.replace(/[^a-z0-9.-]/gi, "_")}.png`);
  if (!loggedIn) await page.screenshot({ path: screenshotPath, fullPage: false });
  console.log(JSON.stringify({
    origin,
    provider,
    status: loggedIn ? "logged_in" : "needs_attention",
    finalUrl: safeLogUrl(finalUrl),
    title: await page.title(),
    screenshotPath: loggedIn ? null : screenshotPath,
    dailyCheckin,
    excerpt: bodyText.slice(0, 1600),
  }, null, 2));
  if (!loggedIn) process.exitCode = 2;
} finally {
  await context.close();
}
