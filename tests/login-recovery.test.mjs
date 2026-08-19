import test from "node:test";
import assert from "node:assert/strict";
import {
  authoritativeNativeOAuthDailyCheckin,
  loginHelperOutcome,
  parseLoginHelperResult,
  resolveLoginRecoveryUrl,
} from "../src/login-recovery.mjs";

test("登录助手必须明确返回 logged_in 才算成功", () => {
  assert.deepEqual(parseLoginHelperResult('startup\n{"status":"logged_in"}\n'), { status: "logged_in" });
  assert.deepEqual(parseLoginHelperResult('browser startup\n{\n  "status": "logged_in"\n}\n'), { status: "logged_in" });
  assert.equal(loginHelperOutcome('{"status":"logged_in"}').succeeded, true);
  assert.equal(loginHelperOutcome('{"status":"needs_attention"}').succeeded, false);
  assert.equal(loginHelperOutcome("browser startup text").succeeded, false);
});

test("登录助手区分可自愈超时与确定性身份错误", () => {
  const timeout = loginHelperOutcome('{"status":"needs_attention","failureCode":"oauth_timeout"}');
  assert.equal(timeout.failureCode, "oauth_timeout");
  assert.equal(timeout.retryable, true);

  const mismatch = loginHelperOutcome('{"status":"needs_attention","failureCode":"account_mismatch"}');
  assert.equal(mismatch.failureCode, "account_mismatch");
  assert.equal(mismatch.retryable, false);
});

test("登录助手保留无敏感信息的凭据拒绝诊断码", () => {
  const outcome = loginHelperOutcome('{"status":"invalid_credential","diagnostic":{"observedResponses":[{"path":"/api/user/login"}]}}');
  assert.equal(outcome.succeeded, false);
  assert.equal(outcome.status, "invalid_credential");
  assert.equal(outcome.diagnosticCode, "invalid_credential");
  assert.equal(Object.hasOwn(outcome, "username"), false);
  assert.equal(Object.hasOwn(outcome, "password"), false);
});

test("登录助手只保留白名单内的权威签到证据", () => {
  const mockSecretValue = "redacted-test-value";
  const outcome = loginHelperOutcome(JSON.stringify({
    status: "logged_in",
    cookie: mockSecretValue,
    token: "private-token",
    body: "private-body",
    dailyCheckin: {
      status: "signed",
      reason: "使用日志确认今日签到成功",
      cookie: mockSecretValue,
      evidence: {
        source: "usage_log",
        createdAt: "2026-08-09T01:02:03Z",
        rewardAmount: 25,
        accountId: "private-account",
        token: "nested-token",
        body: "nested-body",
      },
    },
  }));
  assert.deepEqual(outcome, {
    succeeded: true,
    status: "logged_in",
    diagnostic: "已取得登录会话",
    dailyCheckin: {
      status: "signed",
      reason: "使用日志确认今日签到成功",
      evidence: {
        source: "usage_log",
        createdAt: "2026-08-09T01:02:03.000Z",
        rewardAmount: 25,
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(outcome), /private|cookie|token|body|accountId/);
});

test("只有成功的 native OAuth 助手可以直接提交权威签到结果", () => {
  const outcome = loginHelperOutcome(JSON.stringify({
    status: "logged_in",
    dailyCheckin: { status: "already_signed", reason: "当日使用日志已确认" },
  }));
  assert.deepEqual(authoritativeNativeOAuthDailyCheckin("native_oauth", outcome), outcome.dailyCheckin);
  assert.equal(authoritativeNativeOAuthDailyCheckin("saved_password", outcome), null);
  assert.equal(authoritativeNativeOAuthDailyCheckin("native_oauth", { ...outcome, succeeded: false }), null);
  assert.equal(authoritativeNativeOAuthDailyCheckin("native_oauth", loginHelperOutcome(JSON.stringify({
    status: "logged_in", dailyCheckin: { status: "login_required", reason: "not terminal" },
  }))), null);
});

test("报告中的脱敏参数不会被重新用于登录导航", () => {
  assert.equal(
    resolveLoginRecoveryUrl(
      "https://example.test",
      null,
      "https://example.test/sign-in?redirect=%5BVALUE%5D",
    ),
    "https://example.test/sign-in",
  );
});

test("显式登录入口优先且必须保持同源 HTTPS", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", "https://example.test/auth?mode=login", null),
    "https://example.test/auth?mode=login",
  );
  assert.throws(
    () => resolveLoginRecoveryUrl("https://example.test", "https://evil.test/login", null),
    /目标 HTTPS origin/,
  );
});

test("非登录诊断地址回退到约定登录入口", () => {
  assert.equal(
    resolveLoginRecoveryUrl("https://example.test", null, "https://example.test/dashboard"),
    "https://example.test/login",
  );
});
