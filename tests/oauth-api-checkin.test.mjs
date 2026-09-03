import test from "node:test";
import assert from "node:assert/strict";
import {
  configuredOAuthApiCheckinRule,
  tryOAuthApiCheckin,
} from "../src/oauth-api-checkin.mjs";

const origin = "https://up.example";
const config = {
  oauthApiCheckinRules: {
    [origin]: {
      statusPath: "/api/checkin/status",
      actionPath: "/api/checkin/spin",
    },
  },
};

function pageReturning(outcome) {
  return {
    evaluate: async (_callback, rule) => {
      assert.deepEqual(rule, {
        statusUrl: `${origin}/api/checkin/status`,
        actionUrl: `${origin}/api/checkin/spin`,
      });
      return outcome;
    },
  };
}

test("OAuth API 签到规则只允许同源 HTTPS 端点", () => {
  assert.deepEqual(configuredOAuthApiCheckinRule(origin, config), {
    statusUrl: `${origin}/api/checkin/status`,
    actionUrl: `${origin}/api/checkin/spin`,
  });
  assert.throws(() => configuredOAuthApiCheckinRule(origin, {
    oauthApiCheckinRules: {
      [origin]: { statusPath: "https://other.example/status", actionPath: "/spin" },
    },
  }), /必须属于目标 HTTPS origin/);
});

test("OAuth API 签到只从接口终态返回成功", async () => {
  const signed = await tryOAuthApiCheckin(pageReturning({ code: "signed" }), origin, config);
  assert.deepEqual(signed, {
    status: "signed",
    reason: "OAuth 站点签到接口确认今日签到成功",
    evidence: { source: "oauth_api_action" },
  });

  const already = await tryOAuthApiCheckin(pageReturning({ code: "already_signed" }), origin, config);
  assert.deepEqual(already, {
    status: "already_signed",
    reason: "OAuth 站点状态接口确认今日已签到",
    evidence: { source: "oauth_api_status" },
  });

  assert.equal(await tryOAuthApiCheckin(pageReturning({ code: "unconfirmed" }), origin, config), null);
});

test("OAuth API 签到保留登录失效状态供恢复流程接管", async () => {
  assert.deepEqual(
    await tryOAuthApiCheckin(pageReturning({ code: "login_required" }), origin, config),
    { status: "login_required", reason: "OAuth 站点登录状态失效" },
  );
});
