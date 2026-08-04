import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredOAuthReloginRule,
  forceConfiguredOAuthLogout,
  parseObservedBrowserUrl,
  tryOAuthReloginCheckinStatus,
} from "../src/oauth-relogin-checkin.mjs";

const origin = "https://agentrouter.org";
const config = {
  oauthReloginCheckinRules: {
    [origin]: {
      forceLogout: true,
      nativeBrowser: true,
      logoutPagePath: "/console",
      logoutPath: "/api/user/logout",
      logoutLabel: "退出",
      logPagePath: "/console/log",
      logPath: "/api/log/self",
      logType: 4,
      successText: "每日签到成功，增加额度",
      rewardAmount: 25,
      verificationWaitMs: 12000,
    },
  },
};

test("OAuth 弹窗的临时空地址不会中断恢复流程", () => {
  assert.equal(parseObservedBrowserUrl(""), null);
  assert.equal(parseObservedBrowserUrl(undefined), null);
  assert.equal(parseObservedBrowserUrl("https://agentrouter.org/login").origin, origin);
});

test("OAuth 重登录签到规则只接受同源 HTTPS 地址", () => {
  const rule = configuredOAuthReloginRule(origin, config);
  assert.equal(rule.logUrl, "https://agentrouter.org/api/log/self");
  assert.equal(rule.logoutPageUrl, "https://agentrouter.org/console");
  assert.equal(rule.logoutUrl, "https://agentrouter.org/api/user/logout");
  assert.equal(rule.rewardAmount, 25);
  assert.equal(rule.forceLogout, true);
  assert.equal(rule.nativeBrowser, true);

  assert.throws(() => configuredOAuthReloginRule(origin, {
    oauthReloginCheckinRules: {
      [origin]: { ...config.oauthReloginCheckinRules[origin], logPath: "https://other.example/api/log/self" },
    },
  }), /同源|目标站点/);
});

test("OAuth 重登录只调用配置的同源退出接口", async () => {
  let evaluatedUrl = null;
  const page = {
    goto: async (url) => assert.equal(url, "https://agentrouter.org/console"),
    waitForLoadState: async () => {},
    evaluate: async (_callback, logoutUrl) => {
      evaluatedUrl = logoutUrl;
      return { state: "logged_out", status: 200 };
    },
  };
  const rule = configuredOAuthReloginRule(origin, config);
  assert.equal(await forceConfiguredOAuthLogout(page, rule, { navigationTimeoutMs: 20000 }), true);
  assert.equal(evaluatedUrl, "https://agentrouter.org/api/user/logout");
});

test("只有当日使用日志中的预期奖励记录确认签到成功", async () => {
  let observedRule = null;
  const page = {
    evaluate: async (_callback, rule) => {
      observedRule = rule;
      return { state: "confirmed", createdAt: 1785479484 };
    },
  };
  const result = await tryOAuthReloginCheckinStatus(page, origin, config, "signed");
  assert.equal(observedRule.logType, 4);
  assert.equal(observedRule.successText, "每日签到成功，增加额度");
  assert.deepEqual(result, {
    status: "signed",
    reason: "使用日志确认今日重新登录签到成功，奖励额度 $25",
    evidence: {
      source: "usage_log",
      createdAt: "2026-07-31T06:31:24.000Z",
      rewardAmount: 25,
    },
  });
});

test("缺失奖励日志时要求强制 OAuth 重登录且不误报成功", async () => {
  const missingPage = { evaluate: async () => ({ state: "missing" }) };
  const missing = await tryOAuthReloginCheckinStatus(missingPage, origin, config);
  assert.equal(missing.status, "login_required");
  assert.equal(missing.forceOAuthRelogin, true);
  assert.match(missing.reason, /退出后重新登录/);

  const failedPage = { evaluate: async () => ({ state: "error", reason: "invalid_response" }) };
  const failed = await tryOAuthReloginCheckinStatus(failedPage, origin, config);
  assert.equal(failed.status, "unconfirmed");
});

test("OAuth 登录账号不符时拒绝使用其他账号的奖励记录", async () => {
  let observedRule = null;
  const mismatchConfig = {
    ...config,
    oauthExpectedAccountIds: { [origin]: "20002" },
  };
  const page = {
    evaluate: async (_callback, rule) => {
      observedRule = rule;
      return { state: "account_mismatch", accountId: "10001", expectedAccountId: rule.expectedAccountId };
    },
  };
  const result = await tryOAuthReloginCheckinStatus(page, origin, mismatchConfig, "signed");
  assert.equal(observedRule.expectedAccountId, "20002");
  assert.equal(result.status, "login_required");
  assert.equal(result.forceOAuthRelogin, true);
  assert.match(result.reason, /10001.*20002/);
});
