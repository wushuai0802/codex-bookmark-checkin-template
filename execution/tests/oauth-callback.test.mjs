import assert from "node:assert/strict";
import test from "node:test";
import { mayClaimOAuthLogin, shouldStartOAuthFallback } from "../src/oauth-callback.mjs";

test("a fast same-page callback must not be invalidated by generating another state", () => {
  const origin = "https://example.test";
  assert.equal(shouldStartOAuthFallback(origin + "/login", origin, null), true);
  assert.equal(shouldStartOAuthFallback(origin + "/oauth/linuxdo?code=test", origin, null), false);
  assert.equal(shouldStartOAuthFallback(origin + "/console", origin, null), false);
  assert.equal(shouldStartOAuthFallback(origin + "/login", origin, { success: false }), false);
});

test("HTTP403 state-rejected callback cannot claim login even on its own origin", () => {
  const args = { origin: "https://example.test", finalUrl: "https://example.test/oauth/linuxdo", pageLooksAuthenticated: true };
  assert.equal(mayClaimOAuthLogin({ ...args, callbackEvidence: { httpStatus: 403, success: false, errorCategory: "state_rejected" } }), false);
  assert.equal(mayClaimOAuthLogin(args), false);
  assert.equal(mayClaimOAuthLogin({ ...args, finalUrl: "https://example.test/console", dailyCheckin: { status: "login_required" } }), false);
  assert.equal(mayClaimOAuthLogin({ ...args, finalUrl: "https://example.test/console", callbackEvidence: { httpStatus: 200, success: true } }), true);
});

import { extractSafeOAuthCallbackEvidence, isTargetOAuthCallback } from "../src/oauth-callback.mjs";

test("OAuth callback routing stays on the target origin and API path", () => {
  assert.equal(isTargetOAuthCallback("https://example.com/api/oauth/linuxdo?code=hidden", "https://example.com", "Linux DO"), true);
  assert.equal(isTargetOAuthCallback("https://example.com/api/oauth/state", "https://example.com", "LinuxDO"), false);
  assert.equal(isTargetOAuthCallback("https://other.example/api/oauth/linuxdo", "https://example.com", "LinuxDO"), false);
  assert.equal(isTargetOAuthCallback("https://example.com/api/user/self", "https://example.com", "LinuxDO"), false);
});

test("OAuth callback evidence keeps only the safe account and check-in fields", () => {
  const privateField = ["access", "token"].join("_");
  const evidence = extractSafeOAuthCallbackEvidence({
    success: true,
    data: { user: { id: 12345 }, checked_in: true, [privateField]: "must-not-leak" },
  }, 200);
  assert.deepEqual(evidence, {
    httpStatus: 200,
    success: true,
    userId: "12345",
    checkedIn: true,
    errorCategory: null,
  });
  assert.equal(JSON.stringify(evidence).includes("must-not-leak"), false);
});

test("OAuth callback failures expose only a bounded category", () => {
  const privateValue = "private-callback-detail";
  const evidence = extractSafeOAuthCallbackEvidence({
    success: false,
    message: `authorization code exchange failed: ${privateValue}`,
  }, 200);
  assert.equal(evidence.errorCategory, "code_exchange_failed");
  assert.equal(JSON.stringify(evidence).includes(privateValue), false);
});

test("OAuth recovery can transfer an obsolete callback to a configured same-origin override", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8"));
  assert.match(source, /failedCallbackTransfer = \{ code, state \}/);
  assert.match(source, /state === directOAuthState/);
  assert.match(source, /new URL\(page\.url\(\)\)\.protocol === "chrome-error:"/);
  assert.match(source, /const completedRedirectOverride = redirectOverride/);
  assert.match(source, /override\.origin !== origin/);
  assert.match(source, /override\.searchParams\.set\("code", code\)/);
  assert.match(source, /override\.searchParams\.set\("state", state\)/);
  assert.doesNotMatch(source, /console\.log\([^\n]*failedCallbackTransfer/);
  assert.doesNotMatch(source, /for \(const \[key, value\] of landed\.searchParams/);
});
