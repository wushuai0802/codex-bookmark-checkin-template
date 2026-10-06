import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { executionBindingForOrigin } from "../../observation/src/execution-adapter-registry.mjs";

const read = (relative) => fs.readFile(new URL(relative, import.meta.url), "utf8");

test("AgentRouter execution defaults to preserving the account session", async () => {
  const binding = executionBindingForOrigin({
    origin: "https://agentrouter.org",
    config: { oauthReloginCheckinRules: { "https://agentrouter.org": {} } },
  });
  assert.equal(binding.adapterRule.forceLogout, false);
  const adapter = await read("../../observation/src/oauth-reward-execution-adapter.mjs");
  assert.match(adapter, /forceLogout=rule\.forceLogout===true/);
});

test("OAuth recovery only logs out after an account-bound missing daily reward", async () => {
  const native = await read("../src/native-oauth-login.mjs");
  const generic = await read("../src/oauth-login.mjs");
  for (const source of [native, generic]) {
    assert.match(source, /shouldForceOAuthRelogin/);
    assert.match(source, /guardedOAuthRelogin/);
  }
  const guard = await read("../src/oauth-relogin-checkin.mjs");
  assert.match(guard, /reloginReason === "daily_reward_missing"/);
  assert.match(guard, /reloginReason === "session_expired"/);
  assert.match(guard, /selfUrl: sameOriginHttpsUrl/);
  assert.match(native, /rule\.forceLogout \|\| guardedOAuthRelogin/);
  assert.match(generic, /reloginRule\?\.forceLogout \|\| guardedOAuthRelogin/);
  assert.match(native, /existingIdentityMatches/);
  assert.match(native, /existingDailyCheckin\.status !== "login_required"/);
  assert.match(generic, /preflightReloginStatus/);
  assert.match(generic, /postNavigationStatus/);
  assert.match(generic, /guardedPostNavigation/);
});

test("OAuth recovery stops on unreadable reward status before opening a provider flow", async () => {
  const native = await read("../src/native-oauth-login.mjs");
  const generic = await read("../src/oauth-login.mjs");
  assert.match(native, /existingDailyCheckin\.status !== "login_required"/);
  assert.match(generic, /\["deferred", "unconfirmed"\]\.includes\(preflightReloginStatus\?\.status\)/);
  assert.match(native, /oauth_rate_limited/);
  assert.match(generic, /oauth_upstream_unavailable/);
  assert.match(await read("../src/oauth-relogin-checkin.mjs"), /selfResponse\.status === 401 \|\| selfResponse\.status === 403/);
  assert.match(await read("../src/oauth-relogin-checkin.mjs"), /reason === "challenge_required"/);
});

test("GitHub two-factor pages are terminally classified before generic challenge handling", async () => {
  const native = await read("../src/native-oauth-login.mjs");
  const generic = await read("../src/oauth-login.mjs");
  const plain = await read("../scripts/Invoke-PlainOAuthAccessibility.ps1");
  const recovery = await read("../scripts/Recover-NativeOAuthLogin.ps1");
  assert.match(native, /sessions\\\/two-factor\(\?:\\\/\|\$\)/);
  assert.match(native, /failureCode = "two_factor_required"/);
  assert.match(native, /error\?\.failureCode === "two_factor_required"/);
  assert.match(generic, /githubTwoFactorRequired/);
  assert.match(generic, /failureCode: "two_factor_required"/);
  assert.match(plain, /twoFactorRequired = \$true/);
  assert.match(plain, /failureCode = if \(\$twoFactorRequired\) \{ 'two_factor_required' \}/);
  assert.match(recovery, /\$PlainResult\.twoFactorRequired -eq \$true/);
  assert.match(recovery, /two_factor_required\|managed_challenge/);
});
