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

function pageExecuting(fetchResults) {
  let index = 0;
  return {
    evaluate: async (callback, rule) => {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        const next = fetchResults[Math.min(index, fetchResults.length - 1)];
        index += 1;
        return {
          status: next.status ?? 200,
          ok: next.ok ?? true,
          json: async () => next.body,
        };
      };
      try { return await callback(rule); }
      finally { globalThis.fetch = previousFetch; }
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

test("OAuth API 动作后必须有当日状态回读，并保留余额证据", async () => {
  const result = await tryOAuthApiCheckin(pageExecuting([
    { body: { success: true, can_spin: true, current_balance: 100 } },
    { body: { success: true, quota: 50, new_balance: 150 } },
    { body: { success: true, can_spin: false, current_balance: 150 } },
  ]), origin, config);
  assert.deepEqual(result, {
    status: "signed",
    reason: "OAuth 站点签到接口确认今日签到成功",
    evidence: {
      source: "oauth_api_action_status",
      beforeBalance: 100,
      actionBalance: 150,
      afterBalance: 150,
      reward: 50,
    },
  });
});

test("OAuth API 频率限制进入低频延迟，不重复提交动作", async () => {
  const result = await tryOAuthApiCheckin(pageExecuting([
    { status: 429, ok: false, body: { success: false, message: "请求次数过多" } },
  ]), origin, config);
  assert.deepEqual(result, {
    status: "deferred",
    retryCause: "rate_limit",
    reason: "OAuth 站点签到接口触发频率限制，已延后低频重试",
  });
});

test("OAuth API 动作已提交但状态延迟时停止后续页面动作", async () => {
  const result = await tryOAuthApiCheckin(pageExecuting([
    { body: { success: true, can_spin: true, current_balance: 100 } },
    { body: { success: true, quota: "", new_balance: "" } },
    { body: { success: true, can_spin: true } },
  ]), origin, config);
  assert.deepEqual(result, {
    status: "needs_attention",
    reason: "OAuth 签到动作已提交，但状态接口在限定时间内未确认结果",
    failureCode: "submission_outcome_unknown",
    submissionAttempted: true,
    retryable: false,
  });
});
