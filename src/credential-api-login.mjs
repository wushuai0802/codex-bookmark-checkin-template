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
  const endpoint = new URL(rule.loginUrl);
  if (rule.turnstileQuery) endpoint.searchParams.set("turnstile", "");
  const loginResponse = await context.request.post(endpoint.href, {
    data: { username: credential.username, password: credential.password },
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    failOnStatusCode: false,
    timeout: config.navigationTimeoutMs,
  }).catch(() => null);
  const loginBody = loginResponse ? await loginResponse.json().catch(() => null) : null;
  const loginResult = classifyCredentialApiLoginResponse({
    statusCode: loginResponse?.status() ?? 0,
    body: loginBody,
  });
  if (loginResult.status !== "ready") {
    process.stdout.write(JSON.stringify({ status: loginResult.status, origin, diagnostic: loginResult.diagnostic ?? null,
      ...(loginResult.failureCode ? { failureCode: loginResult.failureCode, attentionKind: "trusted_device_initialization" } : {}) }));
    process.exitCode = 2;
  } else {
    const loginUser = credentialApiUserData(loginBody);
    const selfResponse = await context.request.get(rule.selfUrl.href, {
      headers: { Accept: "application/json", [rule.userIdHeader]: loginUser.id },
      failOnStatusCode: false,
      timeout: config.navigationTimeoutMs,
    }).catch(() => null);
    const selfBody = selfResponse ? await selfResponse.json().catch(() => null) : null;
    const selfResult = classifyCredentialApiSelfResponse({
      statusCode: selfResponse?.status() ?? 0,
      body: selfBody,
      expectedUserId: loginUser.id,
    });
    if (!selfResult.authenticated) {
      process.stdout.write(JSON.stringify({ status: "failed", origin, diagnostic: selfResult.diagnostic,
        selfHttpStatus: selfResponse?.status() ?? 0,
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
        authCheckStatus: selfResponse.status(),
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
