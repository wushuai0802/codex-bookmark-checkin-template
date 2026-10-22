import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCredentialVerification,
  credentialVerificationUrl,
} from "../src/credential-session-verification.mjs";

const valid = {
  expectedOrigin: "https://tracker.example",
  finalUrl: "https://tracker.example/attendance.php",
  statusCode: 200,
  passwordVisible: false,
  bodyText: "欢迎回来，今天已经签到，连续签到 12 天。",
};

test("受保护登录验证路径必须是同源 HTTPS", () => {
  assert.equal(
    credentialVerificationUrl("https://tracker.example", "/attendance.php").href,
    "https://tracker.example/attendance.php",
  );
  assert.throws(() => credentialVerificationUrl("https://tracker.example", ""), /权威验证路径/);
  assert.throws(() => credentialVerificationUrl("https://tracker.example", "https://other.example/profile"), /同源 HTTPS/);
});

test("只有权威页面的已登录证据才通过", () => {
  const success = classifyCredentialVerification(valid);
  assert.equal(success.authenticated, true);
  assert.equal(success.dailyCheckin.status, "already_signed");
  for (const sample of [
    { finalUrl: "https://tracker.example/login.php", bodyText: "登录", passwordVisible: true },
    { finalUrl: "https://tracker.example/takelogin.php", bodyText: "处理中", passwordVisible: false },
    { bodyText: "请先登录后访问签到页面" },
    { passwordVisible: true },
    { bodyText: "当前环境正在被调试，请稍后重试" },
    { statusCode: 500 },
  ]) {
    assert.equal(classifyCredentialVerification({ ...valid, ...sample }).authenticated, false, JSON.stringify(sample));
  }
});

test('verification retains daily completion beside 2FA settings but never authenticates a real OTP gate', () => {
  const settings = classifyCredentialVerification({ ...valid, bodyText: `${valid.bodyText} 2FA设置 忘记二级验证? 点击这里自助解绑` });
  assert.equal(settings.authenticated, true);
  assert.equal(settings.dailyCheckin.status, 'already_signed');
  for (const sample of [
    { bodyText: '异地登录安全验证 请输入二级验证代码，完成后再访问签到页面' },
    { hasOtpInput: true },
    { finalUrl: 'https://tracker.example/take2fa.php', hasOtpForm: true },
    { finalUrl: 'https://tracker.example/take2fa.php', passwordVisible: true },
  ]) {
    const result = classifyCredentialVerification({ ...valid, ...sample });
    assert.equal(result.authenticated, false, JSON.stringify(sample));
    assert.equal(result.failureCode, 'two_factor_required');
    assert.equal(result.dailyCheckin, undefined);
  }
});
