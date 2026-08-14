import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_STATUSES,
  advanceAttemptedDeferredRetries,
  advanceDeferredRetry,
  applyManualConfirmations,
  applyTemporaryUnavailableConfirmations,
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  isRetryEligible,
  nextDeferredRetryAt,
  nextShanghaiTime,
  resumeSelectedOrigins,
  withRetrySchedule,
} from "../src/retry-policy.mjs";

test("凭据被拒绝是人工关注终态，不进入自动重试", () => {
  assert.equal(ATTENTION_STATUSES.has("needs_attention"), true);
  assert.equal(isRetryEligible({ status: "needs_attention", retryCause: "invalid_credential" }), false);
});

test("频率限制会获得有界的下次执行时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = withRetrySchedule(
    { status: "deferred", retryCause: "rate_limit", reason: "操作过于频繁" },
    { deferredRetryDelayMs: 900000, rateLimitRetryDelayMs: 3600000 },
    now,
  );
  assert.equal(result.nextEligibleAt, "2026-07-23T06:00:00.000Z");
  assert.equal(result.retryCause, "rate_limit");
  assert.equal(isRetryEligible(result, now), false);
  assert.equal(isRetryEligible(result, new Date("2026-07-23T06:00:01Z")), true);
});

test("同站限频使用指数退避并在达到上限后转到次日", () => {
  const config = {
    schedule: "08:05",
    rateLimitRetryDelayMs: 3600000,
    rateLimitMaxDelayMs: 21600000,
    rateLimitMaxDailyAttempts: 3,
  };
  const now = new Date("2026-07-23T12:00:00Z");
  const first = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, null, config, now);
  const second = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, first, config, now);
  const third = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, second, config, now);
  assert.equal(first.nextEligibleAt, "2026-07-23T13:00:00.000Z");
  assert.equal(second.nextEligibleAt, "2026-07-23T14:00:00.000Z");
  assert.equal(third.nextEligibleAt, "2026-07-24T00:05:00.000Z");
  assert.equal(third.retryExhaustedForDay, true);
});

test("上游站点连续不可用达到上限后只结束当天重试", () => {
  const config = { upstreamUnavailableMaxDailyAttempts: 3 };
  const now = new Date("2026-07-23T12:00:00Z");
  const first = advanceDeferredRetry({
    status: "deferred",
    retryCause: "upstream_unavailable",
    nextEligibleAt: "2026-07-23T12:30:00.000Z",
  }, null, config, now);
  const second = advanceDeferredRetry({
    status: "deferred",
    retryCause: "upstream_unavailable",
    nextEligibleAt: "2026-07-23T13:00:00.000Z",
  }, first, config, now);
  const settled = advanceDeferredRetry({
    status: "deferred",
    retryCause: "upstream_unavailable",
    nextEligibleAt: "2026-07-23T13:30:00.000Z",
  }, second, config, now);

  assert.equal(first.status, "deferred");
  assert.equal(second.status, "deferred");
  assert.equal(settled.status, "not_available");
  assert.equal(settled.temporarilyUnavailable, true);
  assert.equal(settled.unavailableDate, "20260723");
  assert.equal(settled.retryAttempts, 3);
  assert.equal("nextEligibleAt" in settled, false);
  assert.match(settled.reason, /明日自动恢复/);
});

test("续跑只推进本轮真正尝试过的站点", () => {
  const now = new Date("2026-07-23T12:00:00Z");
  const previous = [
    { origin: "https://wait.test", status: "deferred", retryCause: "rate_limit", retrySequence: 1, retrySequenceDate: "20260723", nextEligibleAt: "2026-07-23T13:00:00.000Z" },
    { origin: "https://retry.test", status: "deferred", retryCause: "rate_limit", retrySequence: 1, retrySequenceDate: "20260723", nextEligibleAt: "2026-07-23T13:00:00.000Z" },
  ];
  const current = previous.map((result) => ({ ...result }));
  const advanced = advanceAttemptedDeferredRetries(current, new Set(["https://retry.test"]), previous, {
    rateLimitRetryDelayMs: 3600000,
  }, now);
  assert.deepEqual(advanced[0], current[0]);
  assert.equal(advanced[1].retrySequence, 2);
  assert.equal(advanced[1].nextEligibleAt, "2026-07-23T14:00:00.000Z");
});

test("同源账号分别延续自己的重试序列并兼容旧主账号结果", () => {
  const now = new Date("2026-07-23T12:00:00Z");
  const previous = [
    { origin: "https://agent.test", status: "deferred", retryCause: "rate_limit", retrySequence: 1, retrySequenceDate: "20260723" },
    { origin: "https://agent.test", accountKey: "secondary", supplementalAccount: true, status: "deferred", retryCause: "rate_limit", retrySequence: 3, retrySequenceDate: "20260723" },
  ];
  const current = [
    { origin: "https://agent.test", accountKey: "primary", status: "deferred", retryCause: "rate_limit" },
    { origin: "https://agent.test", accountKey: "secondary", supplementalAccount: true, status: "deferred", retryCause: "rate_limit" },
  ];
  const attempted = new Set([
    "https://agent.test#account=primary",
    "https://agent.test#account=secondary",
  ]);
  const advanced = advanceAttemptedDeferredRetries(current, attempted, previous, {
    rateLimitRetryDelayMs: 3600000,
    rateLimitMaxDailyAttempts: 6,
  }, now);
  assert.equal(advanced[0].retrySequence, 2);
  assert.equal(advanced[1].retrySequence, 4);
});

test("限频序列跨上海日期会重置且耗尽始终转到次日", () => {
  const config = {
    schedule: "08:05",
    rateLimitRetryDelayMs: 3600000,
    rateLimitMaxDailyAttempts: 3,
  };
  const afterMidnight = new Date("2026-07-23T16:01:00Z");
  const yesterday = {
    status: "deferred",
    retryCause: "rate_limit",
    retrySequence: 3,
    retrySequenceDate: "20260723",
    retryExhaustedForDay: true,
  };
  const reset = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, yesterday, config, afterMidnight);
  assert.equal(reset.retrySequence, 1);
  assert.equal(reset.retrySequenceDate, "20260724");
  assert.equal(reset.retryExhaustedForDay, false);

  const atSevenShanghai = new Date("2026-07-23T23:00:00Z");
  const first = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, null, config, atSevenShanghai);
  const second = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, first, config, atSevenShanghai);
  const exhausted = advanceDeferredRetry({ status: "deferred", retryCause: "rate_limit" }, second, config, atSevenShanghai);
  assert.equal(exhausted.nextEligibleAt, "2026-07-25T00:05:00.000Z");

  const fallback = advanceDeferredRetry(
    { status: "deferred", retryCause: "rate_limit" },
    { ...second, retrySequence: 2 },
    { ...config, rateLimitNextDayTime: "invalid", schedule: "09:10" },
    atSevenShanghai,
  );
  assert.equal(fallback.nextEligibleAt, "2026-07-25T01:10:00.000Z");
});

test("站点指定的上海时间会转换为准确的下一次时间", () => {
  assert.equal(nextShanghaiTime("08:00", new Date("2026-07-22T23:30:00Z")), "2026-07-23T00:00:00.000Z");
  const result = withRetrySchedule({ status: "deferred", reason: "站点要求 08:00 后访问" }, {}, new Date("2026-07-22T23:30:00Z"));
  assert.equal(result.nextEligibleAt, "2026-07-23T00:00:00.000Z");
});

test("只返回未来最近的延迟重试时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  assert.equal(nextDeferredRetryAt([
    { status: "deferred", nextEligibleAt: "2026-07-23T06:00:00Z" },
    { status: "deferred", nextEligibleAt: "2026-07-23T05:20:00Z" },
    { status: "signed" },
  ], now), "2026-07-23T05:20:00.000Z");
});

test("续跑只接受同一上海日期的运行编号", () => {
  const now = new Date("2026-07-22T16:30:00Z");
  assert.equal(isCurrentLocalRunId("20260723-080500", now), true);
  assert.equal(isCurrentLocalRunId("20260722-235959", now), false);
});

test("安全验证可使用独立的低频退避时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = withRetrySchedule({
    status: "deferred",
    retryCause: "managed_challenge_timeout",
    reason: "安全验证未自动通过，改为低频重试",
  }, { deferredRetryDelayMs: 1800000, challengeRetryDelayMs: 3600000 }, now);
  assert.equal(result.nextEligibleAt, "2026-07-23T06:00:00.000Z");
  assert.equal(result.retryCause, "managed_challenge_timeout");
});

test("自动登录恢复仍失败时使用独立的六小时退避时间", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const result = deferUnresolvedLogin({
    status: "login_required",
    reason: "登录状态失效",
  }, {
    loginRetryDelayMs: 6 * 60 * 60 * 1000,
    deferredRetryDelayMs: 30 * 60 * 1000,
  }, now);

  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "login_required");
  assert.equal(result.nextEligibleAt, "2026-07-23T11:00:00.000Z");
  assert.equal(result.reason, "登录状态失效；已安排低频重试");
});

test("登录恢复的延迟重试达到本日上限后停止盲目等待", () => {
  const now = new Date("2026-07-23T05:00:00Z");
  const deferred = deferUnresolvedLogin({
    status: "login_required",
    reason: "OAuth 恢复超时",
    retryableLoginRecovery: true,
  }, { loginRetryDelayMs: 6 * 60 * 60 * 1000 }, now);
  const first = advanceDeferredRetry(deferred, null, { loginRetryMaxDailyAttempts: 2 }, now);
  const exhausted = advanceDeferredRetry(deferred, first, { loginRetryMaxDailyAttempts: 2 }, now);

  assert.equal(first.status, "deferred");
  assert.equal(first.retrySequence, 1);
  assert.equal(exhausted.status, "needs_attention");
  assert.equal(exhausted.retrySequence, 2);
  assert.equal(exhausted.nextEligibleAt, undefined);
  assert.match(exhausted.reason, /不再盲目重试/);
});

test("确定性登录失败不会进入延迟重试", () => {
  const result = deferUnresolvedLogin({
    status: "login_required",
    reason: "OAuth 登录账号与配置不匹配",
    failureCode: "account_mismatch",
    retryableLoginRecovery: false,
  }, { loginRetryDelayMs: 21600000 });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.nextEligibleAt, undefined);
  assert.equal(result.retryCause, "login_required");
});

test("非登录异常不会被登录退避策略改写", () => {
  const result = { status: "interactive_challenge", reason: "需要验证" };
  assert.equal(deferUnresolvedLogin(result, { loginRetryDelayMs: 21600000 }), result);
});

test("续跑会重新选择配置取消但旧状态仍异常的站点", () => {
  const selected = resumeSelectedOrigins(
    [
      { origin: "https://disabled.example" },
      { origin: "https://done.example" },
    ],
    [
      { origin: "https://disabled.example", status: "needs_attention" },
      { origin: "https://done.example", status: "signed" },
    ],
    { disabledCheckinOrigins: ["https://disabled.example", "https://not-bookmarked.example"] },
  );
  assert.deepEqual([...selected], ["https://disabled.example"]);
});

test("人工完成确认会清除重试字段并保留明确审计标记", () => {
  const now = new Date("2026-07-27T01:00:00Z");
  const results = applyManualConfirmations([
    {
      origin: "https://manual.example",
      status: "deferred",
      retryCause: "login_required",
      nextEligibleAt: "2026-07-27T07:00:00Z",
      retrySequence: 2,
    },
    { origin: "https://done.example", status: "signed", reason: "自动完成" },
  ], new Set(["https://manual.example", "https://done.example"]), now);
  assert.deepEqual(results[0], {
    origin: "https://manual.example",
    status: "already_signed",
    reason: "用户已确认手动完成",
    manualConfirmation: true,
    manualConfirmedAt: "2026-07-27T01:00:00.000Z",
  });
  assert.deepEqual(results[1], { origin: "https://done.example", status: "signed", reason: "自动完成" });
});

test("同一来源存在多个账号时不接受来源级人工完成确认", () => {
  const results = applyManualConfirmations([
    { origin: "https://agent.test", accountKey: "primary", status: "deferred" },
    { origin: "https://agent.test", accountKey: "secondary", status: "deferred" },
  ], new Set(["https://agent.test"]), new Date("2026-07-27T01:00:00Z"));
  assert.deepEqual(results.map((result) => result.status), ["deferred", "deferred"]);
});

test("用户确认站点维护会结束当天重试但不伪报签到成功", () => {
  const results = applyTemporaryUnavailableConfirmations([{
    origin: "https://offline.example",
    status: "deferred",
    retryCause: "upstream_unavailable",
    nextEligibleAt: "2026-07-27T02:00:00Z",
    retrySequence: 4,
  }], new Set(["https://offline.example"]), new Date("2026-07-27T01:00:00Z"));

  assert.deepEqual(results[0], {
    origin: "https://offline.example",
    status: "not_available",
    reason: "用户确认站点维护或网络不可用，今日停止重试，明日自动恢复",
    temporarilyUnavailable: true,
    unavailableDate: "20260727",
    operatorConfirmedUnavailable: true,
  });
});

test("暂不可用的当日终态在次日会重新进入目标计划", () => {
  const selected = resumeSelectedOrigins(
    [{ origin: "https://offline.example" }],
    [{
      origin: "https://offline.example",
      status: "not_available",
      temporarilyUnavailable: true,
      unavailableDate: "20260727",
    }],
    {},
    new Date("2026-07-28T01:00:00Z"),
  );
  assert.deepEqual([...selected], ["https://offline.example"]);
});
