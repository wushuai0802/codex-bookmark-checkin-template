import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext, tryNewApiCheckin } from "./browser.mjs";
import { credentialVerificationUrl } from "./credential-session-verification.mjs";
import {
  classifyCredentialApiLoginResponse,
  classifyCredentialApiSelfResponse,
  configuredProtectedCredentialApiRule,
  credentialApiUserData,
} from "./protected-credential-api.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedLoginUrl = process.argv[3];
const verificationPath = process.argv[4];
if (!requestedOrigin || !requestedLoginUrl || !verificationPath) {
  throw new Error("Usage: credential-api-login.mjs <origin> <login-url> <verification-path>");
}
const origin = new URL(requestedOrigin).origin;
const { target } = await findBookmarkTarget(config.bookmarksPath, origin, config);
const loginUrl = assertBookmarkNavigation(requestedLoginUrl, target.allowedOrigins ?? [origin]);
if (new URL(loginUrl).origin !== origin) throw new Error("Credential login URL must be same-origin");
const verificationUrl = credentialVerificationUrl(origin, verificationPath);
const rule = configuredProtectedCredentialApiRule(origin, config);
if (!rule) {
  process.stdout.write(JSON.stringify({ status: "unsupported", origin, diagnostic: "api_rule_missing" }));
  process.exit(2);
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 16 * 1024) throw new Error("Credential input exceeds the safety limit");
}
const credential = JSON.parse(input);
if (typeof credential.username !== "string" || credential.username.length < 1 || credential.username.length > 320
  || typeof credential.password !== "string" || credential.password.length < 1 || credential.password.length > 1024) {
  throw new Error("Invalid credential input");
}

const context = await launchAutomationContext(config);
let page;
try {
  page = await context.newPage();
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  for (const cookie of await context.cookies(origin)) {
    await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path });
  }

  // Keep the authentication exchange in the real page context.  A request
  // made through BrowserContext.request may validate successfully in its
  // private APIRequestContext jar while its Set-Cookie result is not flushed
  // to the persistent browser profile before close.  The next worker launch
  // then sees the old UI/localStorage but receives 401 from the site API.
  // Same-origin page fetch uses Chromium's actual cookie jar and is the
  // durable session boundary for this profile.
  const pageJsonRequest = async (url, options = {}) => page.evaluate(async ({ requestUrl, requestOptions }) => {
    try {
      const response = await fetch(requestUrl, {
        credentials: "include",
        redirect: "error",
        ...requestOptions,
      });
      const text = await response.text();
      let body = null;
      try { body = JSON.parse(text); } catch { /* non-JSON challenge/error */ }
      return { status: response.status, body, text: text.slice(0, 500) };
    } catch (error) {
      return { status: 0, body: null, text: "", networkError: true, errorName: error?.name ?? "" };
    }
  }, { requestUrl: url, requestOptions: options });

  const endpoint = new URL(rule.loginUrl);
  if (rule.turnstileQuery) endpoint.searchParams.set("turnstile", "");
  const loginResponse = await pageJsonRequest(endpoint.href, {
    method: "POST",
    body: JSON.stringify({ username: credential.username, password: credential.password }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
  });
  // Ensure the browser process has handled Set-Cookie before the first
  // readback and eventual persistent-context close.
  await page.waitForTimeout(250);
  const loginBody = loginResponse.body;
  const loginResult = classifyCredentialApiLoginResponse({
    statusCode: loginResponse.status ?? 0,
    body: loginBody,
  });
  if (loginResult.status !== "ready") {
    process.stdout.write(JSON.stringify({ status: loginResult.status, origin, diagnostic: loginResult.diagnostic ?? null,
      ...(loginResult.failureCode ? { failureCode: loginResult.failureCode, attentionKind: "trusted_device_initialization" } : {}) }));
    process.exitCode = 2;
  } else {
    const loginUser = credentialApiUserData(loginBody);
    const accessToken = typeof loginBody?.data?.access_token === "string" ? loginBody.data.access_token : "";
    if (!accessToken) throw new Error("login_access_token_missing");
    const selfResponse = await pageJsonRequest(rule.selfUrl.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        [rule.userIdHeader]: loginUser.id,
        Authorization: `Bearer ${accessToken}`,
      },
    });
    const selfBody = selfResponse.body;
    const selfResult = classifyCredentialApiSelfResponse({
      statusCode: selfResponse.status ?? 0,
      body: selfBody,
      expectedUserId: loginUser.id,
    });
    if (!selfResult.authenticated) {
      process.stdout.write(JSON.stringify({ status: "failed", origin, diagnostic: selfResult.diagnostic,
        selfHttpStatus: selfResponse.status ?? 0,
        cookieCount: (await context.cookies(origin)).length,
        cookieNames: (await context.cookies(origin)).map((cookie) => String(cookie.name)).slice(0, 12),
        selfBodyKeys: selfBody && typeof selfBody === "object" ? Object.keys(selfBody).slice(0, 12) : [] }));
      process.exitCode = 2;
    } else {
      await page.evaluate(({ storageKey, user }) => {
        localStorage.setItem(storageKey, JSON.stringify(user));
      }, { storageKey: rule.storageKey, user: loginUser.value });
      await page.goto(verificationUrl.href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const dailyCheckin = (config.newApiCheckinOrigins ?? []).includes(origin)
        ? await tryNewApiCheckin(page)
        : null;
      process.stdout.write(JSON.stringify({
        status: "logged_in",
        origin,
        finalUrl: safeLogUrl(page.url()),
        authCheckStatus: selfResponse.status ?? 0,
        evidence: { source: "credential_api_self" },
        ...(["signed", "already_signed"].includes(dailyCheckin?.status) ? { dailyCheckin } : {}),
      }));
    }
  }
} catch {
  process.stdout.write(JSON.stringify({ status: "failed", origin, diagnostic: "credential_api_helper_failed" }));
  process.exitCode = 2;
} finally {
  credential.username = "";
  credential.password = "";
  await context.close().catch(() => {});
}
