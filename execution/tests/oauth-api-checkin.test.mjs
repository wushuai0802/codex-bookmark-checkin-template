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

const recordConfig = {
  oauthApiCheckinRules: {
    [origin]: {...config.oauthApiCheckinRules[origin], identityPath:'/api/user/info', requireDailyRecord:true},
  },
};
const day = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai'}).format(new Date());
const identity = {success:true, linux_do_id:'101'};
const signedStatus = (record = {linux_do_id:'101', spin_date:day}) => ({success:true, can_spin:false, today_record:record});
function recordPage(responses) {
  const calls = [];
  return {calls, page:{evaluate:async (callback, rule) => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      calls.push({path:new URL(url).pathname, method:options.method});
      const response = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (response instanceof Error) throw response;
      return {ok:true, status:200, json:async () => response};
    };
    try{return await callback(rule);}finally{globalThis.fetch = original;}
  }}};
}

test('OAuth 当日记录读取核对本人身份和日期，已签到不发送 POST', async () => {
  const f = recordPage([identity, signedStatus()]);
  const result = await tryOAuthApiCheckin(f.page, origin, recordConfig);
  assert.equal(result.status, 'already_signed');
  assert.equal(result.submissionAttempted, false);
  assert.equal(result.evidence.authoritative, true);
  assert.equal(result.evidence.accountId, '101');
  assert.equal(result.evidence.businessDate, day);
  assert.equal(result.evidence.recordDate, day);
  assert.equal(result.evidence.statusSignal, 'oauth_daily_record');
  assert.deepEqual(f.calls.map(c => c.method), ['GET','GET']);
});

test('OAuth 不接受缺失、过期或其它账号的签到记录，也不回退通用点击', async () => {
  for (const record of [null, {linux_do_id:'102', spin_date:day}, {linux_do_id:'101', spin_date:'2000-01-01'}]) {
    const f = recordPage([identity, signedStatus(record)]);
    const result = await tryOAuthApiCheckin(f.page, origin, recordConfig);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.failureCode, 'authoritative_status_unavailable');
    assert.equal(result.submissionAttempted, false);
    assert.equal(f.calls.some(c => c.method === 'POST'), false);
  }
});

test('OAuth 只读负证不提交动作，可用于结果不明后的先行核验', async () => {
  const f = recordPage([identity, {success:true, can_spin:true, today_record:null}]);
  const result = await tryOAuthApiCheckin(f.page, origin, recordConfig, {readOnly:true});
  assert.equal(result.status, 'not_signed');
  assert.equal(result.submissionAttempted, false);
  assert.equal(result.evidence.authoritative, true);
  assert.equal(result.evidence.statusSignal, 'oauth_daily_unsigned');
  assert.equal(f.calls.length, 2);
});

test('OAuth 当前账号未签只提交一次，使用同一账号当日记录完成回读', async () => {
  const f = recordPage([identity, {success:true, can_spin:true, today_record:null}, {success:true, quota:50, new_balance:150}, signedStatus()]);
  const result = await tryOAuthApiCheckin(f.page, origin, recordConfig);
  assert.equal(result.status, 'signed');
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.evidence.authoritative, true);
  assert.equal(result.evidence.recordDate, day);
  assert.deepEqual(f.calls, [
    {path:'/api/user/info', method:'GET'}, {path:'/api/checkin/status', method:'GET'},
    {path:'/api/checkin/spin', method:'POST'}, {path:'/api/checkin/status', method:'GET'},
  ]);
});

test('OAuth 状态读取网络异常只延后核验，不进入页面动作', async () => {
  const f = recordPage([identity, Error('connection reset')]);
  const result = await tryOAuthApiCheckin(f.page, origin, recordConfig);
  assert.equal(result.status, 'deferred');
  assert.equal(result.submissionAttempted, false);
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});

test('OAuth 动作后仍无匹配当日记录时保留未知，只有一次 POST', async () => {
  const f = recordPage([identity, {success:true, can_spin:true, today_record:null}, {success:true}, signedStatus(null)]);
  const result = await tryOAuthApiCheckin(f.page, origin, recordConfig);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.failureCode, 'submission_outcome_unknown');
  assert.equal(result.submissionAttempted, true);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
});

test('OAuth 强校验拒绝跨站身份接口和未审查的只读模式', async () => {
  assert.throws(() => configuredOAuthApiCheckinRule(origin, {
    oauthApiCheckinRules:{[origin]:{...recordConfig.oauthApiCheckinRules[origin], identityPath:'https://other.example/self'}},
  }), /必须属于目标 HTTPS origin/);
  assert.throws(() => configuredOAuthApiCheckinRule(origin, {
    oauthApiCheckinRules:{[origin]:{...config.oauthApiCheckinRules[origin], requireDailyRecord:true}},
  }), /需要同源身份接口/);
  await assert.rejects(tryOAuthApiCheckin({}, origin, config, {readOnly:true}), /需要启用当日记录验证/);
});
