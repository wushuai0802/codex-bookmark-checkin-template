import test from "node:test";
import assert from "node:assert/strict";
import {
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
