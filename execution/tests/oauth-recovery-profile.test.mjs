import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { configForOAuthRecoveryAccount } from "../src/oauth-recovery-profile.mjs";

const root = path.resolve("D:/safe/checkin");
const origin = "https://target.example";
const config = {
  automationUserDataDir: "data/chrome-user-data",
  automaticOAuthProviders: { [origin]: "LinuxDO" },
  oauthRecoveryAccountBindings: { [origin]: "primary-linuxdo" },
  oauthAccountIdentities: {
    "https://account.example": {
      accountKey: "primary-linuxdo",
      accountId: "123",
      accountLabel: "Primary LinuxDO",
      provider: "LinuxDO",
      upstreamProvider: "Google",
      loginUrl: "https://account.example/login",
      automationUserDataDir: "data/accounts/primary/chrome-user-data",
    },
  },
};

test("OAuth recovery can explicitly reuse an isolated upstream account profile", () => {
  const resolved = configForOAuthRecoveryAccount(config, root, origin, "Linux DO");
  assert.equal(resolved.automationUserDataDir, path.resolve(root, "data/accounts/primary/chrome-user-data"));
  assert.equal(config.automationUserDataDir, "data/chrome-user-data");
});

test("OAuth recovery rejects a provider mismatch", () => {
  assert.throws(
    () => configForOAuthRecoveryAccount(config, root, origin, "GitHub"),
    /提供商不匹配/,
  );
});
