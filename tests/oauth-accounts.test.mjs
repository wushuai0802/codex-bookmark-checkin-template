import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountMetadataForOrigin,
  compatiblePriorResult,
  resultIdentity,
} from "../src/result-identity.mjs";
import { configuredSupplementalOAuthAccounts } from "../src/supplemental-oauth-accounts.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const origin = "https://agent.example";

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
