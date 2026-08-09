import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  accountMetadataForOrigin,
  compatiblePriorResult,
  resultIdentity,
} from "../src/result-identity.mjs";
import { configuredSupplementalOAuthAccounts } from "../src/supplemental-oauth-accounts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin = "https://agent.example";
const execFileAsync = promisify(execFile);

async function resolvePowerShellBinding(config, accountKey = "primary") {
  const script = path.join(root, "scripts", "OAuth-AccountConfig.ps1").replaceAll("'", "''");
  const command = [
    `. '${script}'`,
    "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_TEST_OAUTH_CONFIG_B64))",
    "$config = $json | ConvertFrom-Json",
    "$binding = Resolve-OAuthAccountConfiguration $config $env:CODEX_TEST_OAUTH_ROOT $env:CODEX_TEST_OAUTH_ACCOUNT_KEY",
    "$binding | ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_TEST_OAUTH_CONFIG_B64: Buffer.from(JSON.stringify(config), "utf8").toString("base64"),
      CODEX_TEST_OAUTH_ROOT: root,
      CODEX_TEST_OAUTH_ACCOUNT_KEY: accountKey,
    },
  });
  return JSON.parse(stdout);
}

function configWith(accounts) {
  return {
    automationUserDataDir: "data/chrome-user-data",
    oauthAccountIdentities: {
      [origin]: { accountKey: "primary", accountId: "100", accountLabel: "Primary" },
    },
    oauthExpectedAccountIds: { [origin]: "100" },
    supplementalOAuthAccounts: accounts,
  };
}

function supplemental(overrides = {}) {
  return {
    accountKey: "secondary",
    accountId: "200",
    accountLabel: "Secondary",
    origin,
    provider: "GitHub",
    upstreamProvider: "GitHub",
    loginUrl: `${origin}/oauth/login`,
    automationUserDataDir: "data/accounts/secondary/chrome-user-data",
    ...overrides,
  };
}

test("同一来源的不同账号使用独立结果身份", () => {
  assert.equal(resultIdentity({ origin }), origin);
  assert.equal(resultIdentity({ origin, accountKey: "primary" }), `${origin}#account=primary`);
  assert.notEqual(
    resultIdentity({ origin, accountKey: "primary" }),
    resultIdentity({ origin, accountKey: "secondary" }),
  );
});

test("旧版无账号结果只迁移到主书签账号", () => {
  const previous = [{ origin, status: "signed", reason: "legacy" }];
  const primary = compatiblePriorResult({
    origin, accountKey: "primary", accountId: "100", accountLabel: "Primary",
  }, previous);
  assert.equal(primary.status, "signed");
  assert.equal(primary.accountKey, "primary");
  assert.equal(primary.migratedLegacyIdentity, true);
  assert.equal(compatiblePriorResult({
    origin, accountKey: "secondary", supplementalAccount: true,
  }, previous), null);
  assert.equal(compatiblePriorResult({
    origin, accountKey: "primary", accountId: "999",
  }, [{ origin, accountKey: "primary", accountId: "100", status: "signed" }]), null);
});

test("主账号展示身份与登录校验身份必须一致", () => {
  assert.deepEqual(accountMetadataForOrigin(origin, configWith([])), {
    accountKey: "primary",
    accountId: "100",
    accountLabel: "Primary",
  });
  assert.throws(() => accountMetadataForOrigin(origin, {
    ...configWith([]), oauthExpectedAccountIds: { [origin]: "999" },
  }), /身份与预期账号不一致/);
});

test("补充账号拒绝主账号碰撞、重复账号 ID 和重复浏览器目录", () => {
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ accountKey: "primary" }),
  ]), root), /账号重复/);
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ accountId: "100" }),
  ]), root), /账号 ID 重复/);
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ automationUserDataDir: "data/chrome-user-data" }),
  ]), root), /浏览器目录重复/);
});

test("补充账号浏览器目录必须严格位于项目 data 子目录", () => {
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ automationUserDataDir: "data-outside/profile" }),
  ]), root), /必须位于 data 内/);
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ automationUserDataDir: "data" }),
  ]), root), /必须位于 data 内/);
  const [account] = configuredSupplementalOAuthAccounts(configWith([supplemental()]), root);
  assert.equal(account.accountId, "200");
  assert.equal(account.loginUrl, `${origin}/oauth/login`);
});

test("补充账号必须显式声明上游登录方式", () => {
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ upstreamProvider: "" }),
  ]), root), /upstreamProvider 无效/);
});

test("主 OAuth 身份的专属浏览器目录参与 data 边界和唯一性校验", () => {
  const customPrimary = {
    ...configWith([]),
    oauthAccountIdentities: {
      [origin]: {
        accountKey: "primary",
        accountId: "100",
        accountLabel: "Primary",
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  };
  assert.doesNotThrow(() => configuredSupplementalOAuthAccounts(customPrimary, root));
  assert.throws(() => configuredSupplementalOAuthAccounts({
    ...customPrimary,
    supplementalOAuthAccounts: [supplemental({
      automationUserDataDir: "data/accounts/primary/chrome-user-data",
    })],
  }, root), /浏览器目录重复/);
  assert.throws(() => configuredSupplementalOAuthAccounts({
    ...customPrimary,
    oauthAccountIdentities: {
      [origin]: {
        ...customPrimary.oauthAccountIdentities[origin],
        automationUserDataDir: "outside/primary",
      },
    },
  }, root), /必须位于 data 内/);
});

test("PowerShell OAuth 绑定解析主身份的专属 profile", async () => {
  const config = {
    ...configWith([]),
    automaticOAuthProviders: { [origin]: "GitHub" },
    oauthUpstreamProviders: { [origin]: "GitHub" },
    oauthLoginUrls: { [origin]: `${origin}/oauth/login` },
    oauthAccountIdentities: {
      [origin]: {
        accountKey: "primary",
        accountId: "100",
        accountLabel: "Primary",
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  };
  const binding = await resolvePowerShellBinding(config);
  assert.equal(binding.AccountKey, "primary");
  assert.equal(binding.AutomationUserDataDir, path.join(root, "data", "accounts", "primary", "chrome-user-data"));
  assert.equal(binding.Supplemental, false);

  await assert.rejects(resolvePowerShellBinding({
    ...config,
    supplementalOAuthAccounts: [supplemental({
      automationUserDataDir: "data/accounts/primary/chrome-user-data",
    })],
  }), /浏览器目录必须唯一/);
});

test("同域多账号支持按 accountKey 精确续跑并绕过该账号冷却", async () => {
  const source = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /process\.argv\.indexOf\("--account-keys"\)/);
  assert.match(source, /const selectedAccountKeys = accountKeysIndex >= 0/);
  assert.match(source, /const explicitSelection = Boolean\(selectedOrigins \|\| selectedAccountKeys\)/);
  assert.match(source, /selectedAccountKeys\.has\(String\(target\.accountKey \|\| ""\)\.trim\(\)\)/);
  assert.match(source, /定向续跑账号不存在/);
  assert.match(source, /explicitSelection && prior && TERMINAL_STATUSES\.has\(prior\.status\)/);
});
