import process from "node:process";
import { createRequire } from "node:module";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import {
  credentialVerificationUrl,
  verifyCredentialSession,
} from "./credential-session-verification.mjs";
import { isCredentialLoginRoute } from "./url-routes.mjs";
import { safeLogUrl } from "./security.mjs";
import { classifyPageText } from "./detector.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const port = Number.parseInt(process.argv[2], 10);
const origin = new URL(process.argv[3]).origin;
const loginUrl = new URL(process.argv[4]);
const verificationPath = process.argv[5];
if (!Number.isInteger(port) || port <= 0 || loginUrl.protocol !== "https:" || loginUrl.origin !== origin
  || loginUrl.username || loginUrl.password) {
  throw new Error("用法: native-credential-login.mjs <port> <origin> <same-origin-login-url> <verification-path>");
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16 * 1024) throw new Error("凭据输入超过安全上限");
}
const credential = JSON.parse(input);
if (typeof credential.username !== "string" || credential.username.length < 1 || credential.username.length > 320
  || typeof credential.password !== "string" || credential.password.length < 1 || credential.password.length > 1024) {
  throw new Error("凭据输入格式无效");
}
credentialVerificationUrl(origin, verificationPath);

let browser;
let status = "failed";
let diagnostic = null;
let page;
let dailyCheckin = null;
let failureCode = null;
let stage = "startup";
let submitAttempted = false;
try {
  stage = "connect";
  browser = await connectOverCdpWithRetry(chromium, port, { timeoutMs: 30000 });
  const deadline = Date.now() + 30000;
  while (!page && Date.now() < deadline) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
      try { return new URL(candidate.url()).origin === origin; } catch { return false; }
    });
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error("原生 Chrome 中没有找到目标站点页面");

  stage = "wait_for_site";
  const siteDeadline = Date.now() + 120000;
  let initialText = "";
  let wafVisible = false;
  let passwordCount = 0;
  let nonWafWithoutPasswordSince = 0;
  while (Date.now() < siteDeadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    initialText = String(await page.locator("body").innerText().catch(() => ""));
    wafVisible = /Just a moment|正在进行安全验证|Performing security verification|当前环境正在被调试/i.test(initialText);
    passwordCount = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    if (!wafVisible && passwordCount > 0) break;
    if (!wafVisible && !isCredentialLoginRoute(page.url())) break;
    if (!wafVisible) {
      if (!nonWafWithoutPasswordSince) nonWafWithoutPasswordSince = Date.now();
      if (Date.now() - nonWafWithoutPasswordSince >= 5000) break;
    } else {
      nonWafWithoutPasswordSince = 0;
    }
    await page.waitForTimeout(1000).catch(() => {});
  }
  const password = page.locator('input[type="password"]:visible');
  const initialState = classifyPageText({ url: page.url(), bodyText: initialText, hasPassword: passwordCount > 0 });
  if (initialState.failureCode === "two_factor_required") {
    status = "needs_attention";
    failureCode = initialState.failureCode;
  } else if (wafVisible || passwordCount < 1) {
    if (wafVisible) {
      status = "needs_attention";
      diagnostic = { wafVisible, passwordVisible: false };
    } else {
      stage = "verify_existing_session";
      const verification = await verifyCredentialSession(page, { origin, verificationPath });
      dailyCheckin = verification.dailyCheckin ?? null;
      status = verification.authenticated
        ? "logged_in"
        : (verification.failureCode === "challenge" ? "needs_attention" : "failed");
      diagnostic = verification.authenticated ? null : { verificationFailure: verification.failureCode };
    }
  } else {
    const username = page.locator([
      'input[name="username"]:visible',
      'input[autocomplete="username"]:visible',
      'input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])',
    ].join(", ")).first();
    const explicitCaptcha = page.locator([
      'input[name="imagestring"]:visible',
      'input[name*="captcha" i]:visible',
      'input[name*="verify" i]:visible',
      'img[src*="captcha" i]:visible',
    ].join(", "));
    stage = "inspect_form";
    const providerState = await page.evaluate(() => {
      const tokens = [...document.querySelectorAll(
        'input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]',
      )];
      const widgetVisible = [...document.querySelectorAll(
        '.cf-turnstile, .g-recaptcha, .h-captcha, iframe[src*="turnstile" i], iframe[src*="captcha" i]',
      )].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
      return { widgetVisible, tokenReady: tokens.some((element) => String(element.value || "").length > 20) };
    }).catch(() => null);
    if (await username.count() !== 1 || await password.count() !== 1) {
      status = "unsupported";
      diagnostic = { formShapeUnsupported: true };
    } else if (!providerState) {
      status = "needs_attention";
      diagnostic = { providerInspectionFailed: true };
    } else if (await explicitCaptcha.count() > 0 || (providerState.widgetVisible && !providerState.tokenReady)) {
      status = "needs_attention";
      diagnostic = { explicitCaptcha: await explicitCaptcha.count() > 0, providerTokenReady: providerState.tokenReady };
    } else {
      stage = "fill_form";
      await username.fill(credential.username);
      await password.fill(credential.password);
      const submit = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
      if (await submit.count() !== 1 || !await submit.isEnabled().catch(() => false)) {
        status = "unsupported";
        diagnostic = { submitUnavailable: true };
      } else {
        stage = "submit_form";
        submitAttempted = true;
        await submit.click({ timeout: 10000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1200);
        const text = String(await page.locator("body").innerText().catch(() => ""));
        const submittedState = classifyPageText({
          url: page.url(),
          bodyText: text,
          hasPassword: await page.locator('input[type="password"]:visible').count() > 0,
        });
        if (submittedState.failureCode === "two_factor_required") {
          status = "needs_attention";
          failureCode = submittedState.failureCode;
        } else if (/(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(text)) {
          status = "invalid_credential";
        } else if (/(验证码错误|驗證碼錯誤|captcha|verify you are human|安全验证)/i.test(text)) {
          status = "needs_attention";
        } else {
          stage = "verify_submitted_session";
          const verification = await verifyCredentialSession(page, { origin, verificationPath });
          dailyCheckin = verification.dailyCheckin ?? null;
          status = verification.authenticated
            ? "logged_in"
            : (verification.failureCode === "challenge" ? "needs_attention" : "failed");
          diagnostic = verification.authenticated ? null : {
            verificationFailure: verification.failureCode,
            loginRoute: isCredentialLoginRoute(page.url()),
            passwordVisible: verification.passwordVisible,
          };
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({
    status,
    origin,
    finalUrl: safeLogUrl(page.url()),
    diagnostic,
    ...(failureCode ? { failureCode, attentionKind: "trusted_device_initialization" } : {}),
    ...(dailyCheckin ? { dailyCheckin } : {}),
  }));
  if (status !== "logged_in") process.exitCode = 2;
} catch {
  process.stdout.write(JSON.stringify({
    status: "failed",
    origin,
    diagnostic: { stage, submitAttempted },
  }));
  process.exitCode = 2;
} finally {
  credential.username = "";
  credential.password = "";
  await browser?.close().catch(() => {});
}
