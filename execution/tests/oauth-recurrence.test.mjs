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
