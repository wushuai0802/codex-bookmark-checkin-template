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
  planFingerprint,
  resultIdentity,
  resumePlanMatches,
} from "../src/result-identity.mjs";
import {
  configuredOAuthAccounts,
  configuredSupplementalOAuthAccounts,
  oauthAccountRetryPolicy,
  oauthHelperResultToCheckin,
} from "../src/supplemental-oauth-accounts.mjs";

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
    automaticOAuthProviders: { [origin]: "GitHub" },
    oauthUpstreamProviders: { [origin]: "GitHub" },
    oauthLoginUrls: { [origin]: `${origin}/oauth/login` },
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
  const metadata = accountMetadataForOrigin(origin, configWith([]));
  assert.deepEqual({
    accountKey: metadata.accountKey,
    accountId: metadata.accountId,
    accountLabel: metadata.accountLabel,
  }, {
    accountKey: "primary",
    accountId: "100",
    accountLabel: "Primary",
  });
  assert.match(metadata.executionBinding, /^[a-f0-9]{64}$/);
  assert.equal(metadata.loginUrl, undefined);
  assert.equal(metadata.automationUserDataDir, undefined);
  assert.throws(() => accountMetadataForOrigin(origin, {
    ...configWith([]), oauthExpectedAccountIds: { [origin]: "999" },
  }), /身份与预期账号不一致/);
});

test("执行绑定任一变化都会改变计划指纹且报告元数据不暴露原始路径", () => {
  const base = {
    origin,
    accountKey: "primary",
    accountId: "100",
    provider: "LinuxDO",
    upstreamProvider: "Google",
    loginUrl: `${origin}/login`,
    automationUserDataDir: "D:/private/accounts/primary",
  };
  const baseline = planFingerprint([base]);
  for (const [field, value] of [
    ["accountId", "101"],
    ["provider", "GitHub"],
    ["upstreamProvider", "GitHub"],
    ["loginUrl", `${origin}/oauth/login`],
    ["automationUserDataDir", "D:/private/accounts/other"],
  ]) {
    assert.notEqual(planFingerprint([{ ...base, [field]: value }]), baseline, field);
  }

  const config = configWith([]);
  config.oauthAccountIdentities[origin].automationUserDataDir = "data/accounts/primary/chrome-user-data";
  const metadata = accountMetadataForOrigin(origin, config);
  assert.doesNotMatch(JSON.stringify(metadata), /oauth\/login|chrome-user-data|automationUserDataDir|loginUrl/);
  assert.equal(planFingerprint([{ origin, ...metadata }]), planFingerprint([{
    origin,
    accountKey: "primary",
    accountId: "100",
    provider: "GitHub",
    upstreamProvider: "GitHub",
    loginUrl: `${origin}/oauth/login`,
    automationUserDataDir: "data/accounts/primary/chrome-user-data",
  }]));
});

test("续跑报告必须与当前完整执行计划指纹一致", () => {
  const fingerprint = planFingerprint([{ origin, candidates: [`${origin}/dashboard`] }]);
  const report = { bookmarkSummary: { planFingerprint: fingerprint } };
  assert.equal(resumePlanMatches(report, fingerprint), true);
  assert.equal(resumePlanMatches(report, planFingerprint([{ origin, accountId: "changed" }])), false);
  assert.equal(resumePlanMatches({ bookmarkSummary: {} }, fingerprint), false);
});

test("JS 配置拒绝可能破坏身份编码的 accountKey", () => {
  const invalidPrimary = configWith([]);
  invalidPrimary.oauthAccountIdentities[origin].accountKey = "bad/key";
  assert.throws(() => accountMetadataForOrigin(origin, invalidPrimary), /accountKey 无效/);
  assert.throws(() => configuredSupplementalOAuthAccounts(configWith([
    supplemental({ accountKey: "bad key" }),
  ]), root), /accountKey 无效/);
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

test("账号显示名中的旧数字自动采用权威账号 ID，内部 accountKey 保持稳定", () => {
  const [account] = configuredSupplementalOAuthAccounts(configWith([supplemental({
    accountKey: "example-100001",
    accountId: "100002",
    accountLabel: "Agent 100001 (OAuth)",
    title: "Example 100001",
  })]), root);
  assert.equal(account.accountKey, "example-100001");
  assert.equal(account.accountId, "100002");
  assert.equal(account.accountLabel, "Agent 100002 (OAuth)");
  assert.equal(account.title, "Example 100002");
});

test("续跑复用旧结果时刷新权威账号展示字段", () => {
  const current = supplemental({
    accountKey: "example-100001",
    accountId: "100002",
    accountLabel: "Agent 100002 (OAuth)",
    title: "Example 100002",
  });
  const reused = compatiblePriorResult(current, [{
    ...current,
    accountLabel: "Agent 100001 (OAuth)",
    title: "Example 100001",
    status: "signed",
  }]);
  assert.equal(reused.status, "signed");
  assert.equal(reused.accountLabel, "Agent 100002 (OAuth)");
  assert.equal(reused.title, "Example 100002");
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

test("显式专属 profile 的主账号解析为隔离 helper 且内联 OAuth 元组优先", () => {
  const configured = {
    ...configWith([]),
    automaticOAuthProviders: { [origin]: "WrongMapProvider" },
    oauthUpstreamProviders: { [origin]: "WrongMapUpstream" },
    oauthLoginUrls: { [origin]: `${origin}/wrong-map-login` },
    oauthAccountIdentities: {
      [origin]: {
        accountKey: "primary",
        accountId: "100",
        accountLabel: "Primary",
        provider: "LinuxDO",
        upstreamProvider: "Google",
        loginUrl: `${origin}/inline-login`,
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  };
  const { isolatedPrimaryAccounts, supplementalAccounts } = configuredOAuthAccounts(configured, root);
  assert.equal(supplementalAccounts.length, 0);
  assert.equal(isolatedPrimaryAccounts.length, 1);
  assert.deepEqual({
    accountKey: isolatedPrimaryAccounts[0].accountKey,
    accountId: isolatedPrimaryAccounts[0].accountId,
    provider: isolatedPrimaryAccounts[0].provider,
    upstreamProvider: isolatedPrimaryAccounts[0].upstreamProvider,
    loginUrl: isolatedPrimaryAccounts[0].loginUrl,
  }, {
    accountKey: "primary",
    accountId: "100",
    provider: "LinuxDO",
    upstreamProvider: "Google",
    loginUrl: `${origin}/inline-login`,
  });
});

test("未配置专属 profile 的旧主账号继续走全局路径", () => {
  const { isolatedPrimaryAccounts } = configuredOAuthAccounts(configWith([]), root);
  assert.deepEqual(isolatedPrimaryAccounts, []);
});

test("隔离 helper 的主账号结果不冒充补充账号并保留权威身份", () => {
  const primary = oauthHelperResultToCheckin({
    accountKey: "primary",
    accountId: "100",
    accountLabel: "Primary",
    origin,
    provider: "LinuxDO",
    loginUrl: `${origin}/inline-login`,
    title: "Primary target",
    folderNames: ["check-in"],
  }, {
    finalUrl: `${origin}/console/log`,
    dailyCheckin: {
      status: "signed",
      reason: "usage log confirmed",
      evidence: { source: "usage_log", rewardAmount: 25 },
    },
  });
  assert.equal(primary.accountKey, "primary");
  assert.equal(primary.accountId, "100");
  assert.equal(primary.status, "signed");
  assert.equal(primary.supplementalAccount, undefined);

  const supplementalResult = oauthHelperResultToCheckin({
    ...supplemental(),
    supplementalAccount: true,
    title: "Secondary target",
  }, null);
  assert.equal(supplementalResult.supplementalAccount, true);
});

test("OAuth 账号只对可自愈失败安排重试", () => {
  const account = {
    ...supplemental(),
    supplementalAccount: true,
    title: "Secondary target",
  };
  const timeout = oauthHelperResultToCheckin(account, {
    status: "needs_attention",
    reason: "OAuth 未在限定时间内完成",
    failureCode: "oauth_timeout",
  });
  assert.equal(timeout.status, "login_required");
  assert.equal(timeout.retryableLoginRecovery, true);

  const mismatch = oauthHelperResultToCheckin(account, {
    status: "needs_attention",
    reason: "OAuth 登录账号与配置不匹配",
    failureCode: "account_mismatch",
  });
  assert.equal(mismatch.status, "needs_attention");
  assert.equal(mismatch.retryableLoginRecovery, false);
});

test("未初始化的隔离账号会话属于配置问题而不是瞬时失败", () => {
  const result = oauthHelperResultToCheckin({
    ...supplemental(),
    supplementalAccount: true,
    title: "Secondary target",
  }, {
    status: "needs_attention",
    reason: "独立登录会话尚未初始化",
    failureCode: "configuration_mismatch",
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "configuration_mismatch");
  assert.equal(result.retryableLoginRecovery, false);
});

test("OAuth 账号瞬时失败使用有界重试策略", () => {
  assert.deepEqual(oauthAccountRetryPolicy({}), { attempts: 2, delayMs: 5000 });
  assert.deepEqual(oauthAccountRetryPolicy({ oauthAccountAttempts: 9, oauthAccountRetryDelayMs: 999999 }), {
    attempts: 3,
    delayMs: 60000,
  });
  assert.deepEqual(oauthAccountRetryPolicy({ oauthAccountAttempts: 1, oauthAccountRetryDelayMs: 0 }), {
    attempts: 1,
    delayMs: 0,
  });
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

test("PowerShell OAuth 绑定优先采用主身份内联登录元组", async () => {
  const config = {
    ...configWith([]),
    automaticOAuthProviders: { [origin]: "WrongMapProvider" },
    oauthUpstreamProviders: { [origin]: "WrongMapUpstream" },
    oauthLoginUrls: { [origin]: `${origin}/wrong-map-login` },
    oauthAccountIdentities: {
      [origin]: {
        accountKey: "primary",
        accountId: "100",
        accountLabel: "Primary",
        provider: "LinuxDO",
        upstreamProvider: "Google",
        loginUrl: `${origin}/inline-login`,
        automationUserDataDir: "data/accounts/primary/chrome-user-data",
      },
    },
  };
  const binding = await resolvePowerShellBinding(config);
  assert.equal(binding.Provider, "LinuxDO");
  assert.equal(binding.UpstreamProvider, "Google");
  assert.equal(binding.LoginUrl, `${origin}/inline-login`);
});

test("PowerShell OAuth 绑定拒绝非法 accountKey", async () => {
  await assert.rejects(resolvePowerShellBinding(configWith([]), "bad/key"), /accountKey 无效/);
});

test("同域多账号支持按 accountKey 精确续跑并绕过该账号冷却", async () => {
  const source = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /process\.argv\.indexOf\("--account-keys"\)/);
  assert.match(source, /const selectedAccountKeys = accountKeysIndex >= 0/);
  assert.match(source, /const explicitSelection = Boolean\(selectedOrigins \|\| selectedAccountKeys\)/);
  assert.match(source, /selectedAccountKeys\.has\(String\(target\.accountKey \|\| ""\)\.trim\(\)\)/);
  assert.match(source, /定向续跑账号不存在/);
  assert.match(source, /explicitSelection && prior && isTerminalResult\(prior\)/);
});

test("重新启用的站点不会复用旧的配置取消终态", async () => {
  const source = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /terminalResultReenabled\(prior, target, config\)/);
  assert.match(source, /reenabledTerminal[\s\S]*?!reenabledTerminal/);
});

test("PowerShell wrapper 支持 HTTPS 来源级定向续跑", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "Run-Checkin.ps1"), "utf8");
  const runner = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /\[string\[\]\]\$Origins\s*=\s*@\(\)/);
  assert.match(source, /@\('--origins',\s*\(\$selectedOrigins -join ','\)\)/);
  assert.match(source, /定向站点必须是 HTTPS 来源/);
  assert.match(source, /Test-HasImmediateRetry\(\$Report, \[datetime\]\$RetryAt, \[string\[\]\]\$SelectedOrigins/);
  assert.match(source, /\$SelectedOrigins -contains \[string\]\$_.origin/);
  assert.match(source, /Test-HasImmediateRetry \$resumeCandidate\.Report \(\(Get-Date\)\.AddMinutes\(\$retryDelayMinutes\)\) \$selectedOrigins \$selectedAccountKeys/);
  assert.match(source, /src\\current-plan\.mjs/);
  assert.match(source, /\$currentFingerprint -ne \$resumeFingerprint/);
  assert.match(source, /续跑报告与当前账号或登录计划不一致/);
  assert.match(runner, /定向续跑来源不存在/);
  assert.match(runner, /resumePlanMatches\(resumeBase, report\.planFingerprint\)/);
  assert.match(runner, /exactResumeRequired/);
  assert.match(runner, /const exitResults = explicitSelection/);
  assert.match(runner, /selectedIdentities\.has\(resultIdentity\(result\)\)/);
  assert.match(runner, /selectedResultSetComplete/);
});

test("专属 profile 主账号首轮和恢复阶段都不会落入全局 context", async () => {
  const source = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /const \{ isolatedPrimaryAccounts, supplementalAccounts \} = configuredOAuthAccounts/);
  assert.match(source, /const globalContextTargets = selectedTargets\.filter/);
  assert.match(source, /!isolatedPrimaryByIdentity\.has\(resultIdentity\(target\)\)/);
  assert.match(source, /\? await runIsolatedPrimaryTarget\(target\)/);
  assert.match(source, /runOAuthAccount\(\{/);
  assert.match(source, /&& !isolatedPrimaryByIdentity\.has\(resultIdentity\(result\)\) \? index : -1/);
});
