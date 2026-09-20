import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { acceptConfiguredLoginTerms, waitForLoginSubmitEnabled } from "./protected-login-flow.mjs";
import {
  credentialVerificationUrl,
  verifyCredentialSession,
} from "./credential-session-verification.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";
import { isCredentialLoginRoute } from "./url-routes.mjs";
import { classifyPageText } from "./detector.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedLoginUrl = process.argv[3];
if (!requestedOrigin || !requestedLoginUrl) throw new Error("用法: credential-login.mjs <origin> <login-url>");
const origin = new URL(requestedOrigin).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, origin, config);
const loginUrl = assertBookmarkNavigation(requestedLoginUrl, target.allowedOrigins ?? [origin]);
if (new URL(loginUrl).origin !== origin) throw new Error("受保护登录地址必须与凭据来源同源");
const verificationPath = process.argv[4] ?? config.protectedLoginVerificationPaths?.[origin];

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

function isLoginUrl(value) {
  try { return isCredentialLoginRoute(new URL(value).href); }
  catch { return true; }
}

const context = await launchAutomationContext(config);
let status = "failed";
let page;
let storageSaved = false;
let authCheckStatus = null;
let diagnostic = null;
let dailyCheckin = null;
let failureCode = null;
try {
  page = await context.newPage();
  const observedResponses = [];
  page.on("response", async (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin !== origin || observedResponses.length >= 12) return;
      const method = response.request().method();
      if (method !== "POST" && method !== "PUT" && method !== "PATCH") return;
      const item = { method, path: url.pathname, status: response.status() };
      observedResponses.push(item);
      if (url.pathname === "/api/user/login") {
        const value = await response.json().catch(() => null);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const message = String(value.message ?? value.error ?? "");
          item.json = {
            keys: Object.keys(value).filter((key) => /^[a-z0-9_-]{1,40}$/i.test(key)).slice(0, 12),
            success: typeof value.success === "boolean" ? value.success : null,
            code: Number.isFinite(Number(value.code)) ? Number(value.code) : null,
            dataPresent: value.data !== undefined && value.data !== null,
            messageFlags: {
              invalidCredential: /(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(message),
              disabled: /(封禁|禁用|disabled|banned)/i.test(message),
              rateLimited: /(请求过多|操作频繁|too many requests|rate limit)/i.test(message),
              verification: /(验证|驗證|captcha|verify)/i.test(message),
            },
          };
        }
      }
    } catch { }
  });
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await acceptConfiguredLoginTerms(page, origin, config);
  const password = page.locator('input[type="password"]:visible');
  const initialText = String(await page.locator("body").innerText().catch(() => ""));
  const initialState = classifyPageText({ url: page.url(), bodyText: initialText, hasPassword: await password.count() > 0 });
  if (initialState.failureCode === "two_factor_required") {
    status = "needs_attention";
    failureCode = initialState.failureCode;
  } else if (await password.count() < 1) {
    const verification = await verifyCredentialSession(page, {
      origin,
      verificationPath,
      navigationTimeoutMs: config.navigationTimeoutMs,
    });
    authCheckStatus = verification.statusCode;
    dailyCheckin = verification.dailyCheckin ?? null;
    status = verification.authenticated ? "logged_in" : (verification.failureCode === "challenge" ? "needs_attention" : "failed");
    diagnostic = verification.authenticated ? null : { verificationFailure: verification.failureCode };
  } else {
    const usernames = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])');
    if (await usernames.count() < 1) status = "unsupported";
    else {
      await usernames.first().fill(credential.username);
      await password.first().fill(credential.password);
      let submit = null;
      for (const label of ["登录", "登入", "用户登录", "用戶登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1 && await candidate.isVisible()) { submit = candidate; break; }
      }
      if (!submit) {
        const fallback = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await fallback.count() >= 1) submit = fallback.first();
      }
      if (!submit) status = "unsupported";
      else {
        const submitReady = await waitForLoginSubmitEnabled(page, submit, origin, config);
        if (!submitReady) status = "needs_attention";
        else {
          await submit.click({ timeout: 10000 }).catch(() => {});
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1200);
          const postSubmitText = String(await page.locator("body").innerText().catch(() => ""));
          const responseInvalidCredential = observedResponses.some((item) => item.json?.messageFlags?.invalidCredential === true);
          const postSubmitState = classifyPageText({
            url: page.url(),
            bodyText: postSubmitText,
            hasPassword: await page.locator('input[type="password"]:visible').count() > 0,
          });
          if (postSubmitState.failureCode === "two_factor_required") {
            status = "needs_attention";
            failureCode = postSubmitState.failureCode;
          } else if (/(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(postSubmitText)
            || responseInvalidCredential) {
            status = "invalid_credential";
          } else {
            const verification = await verifyCredentialSession(page, {
              origin,
              verificationPath,
              navigationTimeoutMs: config.navigationTimeoutMs,
            });
            authCheckStatus = verification.statusCode;
            dailyCheckin = verification.dailyCheckin ?? null;
            status = verification.authenticated
              ? "logged_in"
              : (verification.failureCode === "challenge" ? "needs_attention" : "failed");
            diagnostic = verification.authenticated ? null : { verificationFailure: verification.failureCode };
          }
        }
        if (status !== "logged_in" && status !== "invalid_credential" && status !== "needs_attention") {
          const text = String(await page.locator("body").innerText().catch(() => ""));
          const passwordVisible = await page.locator('input[type="password"]:visible').count() > 0;
          const challengeVisible = await page.locator('cap-widget:visible, [data-cap-api-endpoint]:visible, .cf-turnstile:visible, .h-captcha:visible, iframe[src*="turnstile" i]:visible, iframe[src*="hcaptcha" i]:visible').count() > 0;
          const submitEnabled = await submit.isEnabled().catch(() => false);
          const bodyFlags = {
            invalidCredentialText: /(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(text),
            loginFailedText: /(登录失败|登入失败|login failed|authentication failed)/i.test(text),
            captchaText: /(验证码|驗證碼|captcha|turnstile|人机|真人)/i.test(text),
            rateLimitText: /(请求过多|操作频繁|too many requests|rate limit)/i.test(text),
            errorText: /(错误|錯誤|error|failed|失败|失敗)/i.test(text),
          };
          const formShape = await page.locator("form").evaluateAll((forms) => forms.slice(0, 4).map((form) => ({
            method: String(form.method || "GET").toUpperCase(),
            actionPath: (() => { try { return new URL(form.action || location.href).pathname; } catch { return ""; } })(),
            controls: [...form.querySelectorAll("input,button")].slice(0, 12).map((element) => ({
              tag: element.tagName,
              type: String(element.type || ""),
              name: String(element.name || ""),
            })),
          }))).catch(() => []);
          status = /(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(text)
            ? "invalid_credential"
            : (challengeVisible
              ? "needs_attention"
              : "failed");
          diagnostic = {
            passwordVisible,
            challengeVisible,
            submitEnabled,
            loginRoute: isLoginUrl(page.url()),
            bodyFlags,
            bodyLength: text.length,
            formShape,
            observedResponses,
            ...diagnostic,
          };
        }
      }
    }
  }
  process.stdout.write(JSON.stringify({
    status,
    origin,
    finalUrl: safeLogUrl(page.url()),
    storageSaved,
    authCheckStatus,
    diagnostic,
    ...(failureCode ? { failureCode, attentionKind: "trusted_device_initialization" } : {}),
    ...(dailyCheckin ? { dailyCheckin } : {}),
  }));
  if (status !== "logged_in") process.exitCode = 2;
} catch (error) {
  status = /Timeout|timed out/i.test(String(error?.message ?? error)) ? "timeout" : "failed";
  process.stdout.write(JSON.stringify({ status, origin }));
  process.exitCode = 2;
} finally {
  credential.username = "";
  credential.password = "";
  await context.close();
}
