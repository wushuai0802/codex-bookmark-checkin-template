import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  configForOAuthSession,
  configuredOAuthSessionProfiles,
} from "../src/oauth-session-profiles.mjs";
import { configForOAuthRecoveryAccount } from "../src/oauth-recovery-profile.mjs";

const root = path.resolve("D:/fixture/checkin");

function baseConfig(overrides = {}) {
  return {
    automationUserDataDir: "data/chrome-user-data",
    oauthAccountIdentities: {},
    supplementalOAuthAccounts: [],
    isolatedOAuthSiteProfiles: {},
    oauthSessionProfiles: {},
    oauthSiteSessionBindings: {},
    ...overrides,
  };
}

test("同一 OAuth 会话可以绑定多个站点并复用 Profile", () => {
  const config = baseConfig({
    oauthSessionProfiles: {
      "linuxdo-shared": "data/sessions/linuxdo-shared/chrome-user-data",
    },
    oauthSiteSessionBindings: {
      "https://first.example": "linuxdo-shared",
      "https://second.example": "linuxdo-shared",
    },
  });
  const sessions = configuredOAuthSessionProfiles(config, root);
  assert.equal(sessions.siteBindings.get("https://first.example"), "linuxdo-shared");
  assert.equal(
    configForOAuthSession(config, sessions, "https://second.example/login").automationUserDataDir,
    path.resolve(root, "data/sessions/linuxdo-shared/chrome-user-data"),
  );
});

test("OAuth 会话拒绝未配置的绑定和 data 外目录", () => {
  assert.throws(() => configuredOAuthSessionProfiles(baseConfig({
    oauthSessionProfiles: { shared: "outside/profile" },
  }), root), /必须位于 data 内/);
  assert.throws(() => configuredOAuthSessionProfiles(baseConfig({
    oauthSessionProfiles: { shared: "data/sessions/shared" },
    oauthSiteSessionBindings: { "https://example.com": "missing" },
  }), root), /引用了未配置的会话/);
});

test("共享会话不能覆盖全局或账号专属 Profile", () => {
  assert.throws(() => configuredOAuthSessionProfiles(baseConfig({
    oauthSessionProfiles: { shared: "data/chrome-user-data" },
  }), root), /不能与 automationUserDataDir 重复/);
  assert.throws(() => configuredOAuthSessionProfiles(baseConfig({
    oauthAccountIdentities: {
      "https://example.com": { accountKey: "primary", automationUserDataDir: "data/accounts/primary" },
    },
    oauthSessionProfiles: { shared: "data/accounts/primary" },
  }), root), /不能与 primary 重复/);
});

test("OAuth 恢复优先保留显式共享会话，不重复切回账号 Profile", () => {
  const config = baseConfig({
    oauthSessionProfiles: {
      "linuxdo-shared": "data/sessions/linuxdo-shared/chrome-user-data",
    },
    oauthSiteSessionBindings: {
      "https://target.example": "linuxdo-shared",
    },
    oauthRecoveryAccountBindings: {
      "https://target.example": "primary",
    },
    oauthAccountIdentities: {
      "https://account.example": {
        accountKey: "primary",
        accountId: "1",
        provider: "LinuxDO",
        upstreamProvider: "Google",
        loginUrl: "https://account.example/login",
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  });
  const sessions = configuredOAuthSessionProfiles(config, root);
  const sessionConfig = configForOAuthSession(config, sessions, "https://target.example");
  const recovered = configForOAuthRecoveryAccount(sessionConfig, root, "https://target.example", "LinuxDO");
  assert.equal(
    recovered.automationUserDataDir,
    path.resolve(root, "data/sessions/linuxdo-shared/chrome-user-data"),
  );
});

test("没有共享会话绑定时 OAuth 恢复仍使用配置的账号 Profile", () => {
  const config = baseConfig({
    oauthRecoveryAccountBindings: { "https://target.example": "primary" },
    oauthAccountIdentities: {
      "https://account.example": {
        accountKey: "primary",
        accountId: "1",
        provider: "LinuxDO",
        upstreamProvider: "Google",
        loginUrl: "https://account.example/login",
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  });
  const recovered = configForOAuthRecoveryAccount(config, root, "https://target.example", "LinuxDO");
  assert.equal(
    recovered.automationUserDataDir,
    path.resolve(root, "data/accounts/primary/chrome-user-data"),
  );
});

test("公开示例说明同一 OAuth 会话可被多个站点复用", async () => {
  const example = JSON.parse(await fs.readFile(new URL("../config/config.local.example.json", import.meta.url), "utf8"));
  assert.equal(example.oauthSessionProfiles["linuxdo-shared"], "data/sessions/linuxdo-shared/chrome-user-data");
  assert.equal(example.oauthSiteSessionBindings["https://another-example.com"], "linuxdo-shared");
  assert.equal(example.oauthSiteSessionBindings["https://third-example.com"], "linuxdo-shared");
});
