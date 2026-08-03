import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyNewApiCaptchaObservation,
  configuredNewApiCaptchaRule,
  classifyNewApiSignInObservation,
  configuredNewApiSignInRule,
  tryNewApiCaptchaCheckin,
  tryNewApiSignIn,
} from "../src/new-api-signin.mjs";

test("New API 图片验证码规则限制同源地址和尝试次数", () => {
  const captchaOrigin = "https://captcha.example";
  const rule = configuredNewApiCaptchaRule(captchaOrigin, {
    newApiCaptchaRules: {
      [captchaOrigin]: { checkinPath: "/api/user/checkin", captchaPath: "/api/user/checkin/captcha", maxAttempts: 6 },
    },
  });
  assert.equal(rule.checkinUrl, "https://captcha.example/api/user/checkin");
  assert.equal(rule.captchaUrl, "https://captcha.example/api/user/checkin/captcha");
  assert.equal(rule.maxAttempts, 6);
  assert.throws(() => configuredNewApiCaptchaRule(captchaOrigin, {
    newApiCaptchaRules: { [captchaOrigin]: { maxAttempts: 20 } },
  }), /maxAttempts/);
});

test("New API 图片验证码只按接口权威状态确认完成", () => {
  assert.equal(classifyNewApiCaptchaObservation({ state: "already_signed" }).status, "already_signed");
  const signed = classifyNewApiCaptchaObservation({ state: "signed", quotaAwarded: 5000000, attempts: 2 });
  assert.equal(signed.status, "signed");
  assert.equal(signed.evidence.quotaAwarded, 5000000);
  assert.equal(classifyNewApiCaptchaObservation({ state: "captcha_unresolved" }).status, "interactive_challenge");
});

test("New API 图片验证码提交后必须再次确认当日状态", async () => {
  const captchaOrigin = "https://captcha.example";
  const observations = [
    { state: "ready", userId: "7" },
    { state: "ready", id: "captcha-id", image: `data:image/png;base64,${Buffer.from("image").toString("base64")}` },
    { state: "signed", quotaAwarded: 5000000 },
    { state: "signed" },
  ];
  const page = { evaluate: async () => observations.shift() };
  const result = await tryNewApiCaptchaCheckin(page, captchaOrigin, {
    newApiCaptchaRules: { [captchaOrigin]: { maxAttempts: 2 } },
  }, async () => ["ABCDE"]);
  assert.equal(result.status, "signed");
  assert.equal(result.evidence.quotaAwarded, 5000000);
  assert.equal(observations.length, 0);
});

const origin = "https://anyrouter.top";
const config = {
  newApiSignInRules: {
    [origin]: {
      signInPath: "/api/user/sign_in",
      selfPath: "/api/user/self",
      statusPath: "/api/status",
      logPath: "/api/log/self",
      logType: 4,
      responseSuccessText: "签到成功，获得",
      logSuccessText: "每日签到成功，增加额度",
      rewardAmount: 25,
      emptySuccessMeansAlreadySigned: true,
      userStorageKeys: ["user"],
    },
  },
};

test("New API sign_in 规则只接受同源 HTTPS 地址", () => {
  const rule = configuredNewApiSignInRule(origin, config);
  assert.equal(rule.signInUrl, "https://anyrouter.top/api/user/sign_in");
  assert.equal(rule.logUrl, "https://anyrouter.top/api/log/self");
  assert.equal(rule.rewardAmount, 25);
  assert.deepEqual(rule.userStorageKeys, ["user"]);

  assert.throws(() => configuredNewApiSignInRule(origin, {
    newApiSignInRules: {
      [origin]: { ...config.newApiSignInRules[origin], signInPath: "https://other.example/api/user/sign_in" },
    },
  }), /同源|目标站点/);
});

test("明确的奖励响应、额度差或新增日志可以确认签到成功", () => {
  const rule = configuredNewApiSignInRule(origin, config);
  const explicit = classifyNewApiSignInObservation({
    state: "called",
    responseSuccess: true,
    responseMessage: "签到成功，获得 $25 额度",
    quotaDelta: 25,
    rewardLogBefore: false,
    rewardLogAfter: true,
    rewardLogCreatedAt: 1785479484,
  }, rule);
  assert.equal(explicit.status, "signed");
  assert.deepEqual(explicit.evidence.sources, ["sign_in_response", "quota_delta", "usage_log"]);
  assert.equal(explicit.evidence.rewardAmount, 25);
});

test("调用前已有当日奖励日志时确认今日已签到", () => {
  const rule = configuredNewApiSignInRule(origin, config);
  const result = classifyNewApiSignInObservation({
    state: "already_confirmed",
    rewardLogCreatedAt: 1785479484,
  }, rule);
  assert.equal(result.status, "already_signed");
  assert.equal(result.evidence.source, "usage_log");
});

test("站点未声明空成功约定时不误报完成", async () => {
  const page = {
    evaluate: async () => ({
      state: "called",
      responseSuccess: true,
      responseMessage: "",
      quotaDelta: 0,
      rewardLogBefore: false,
      rewardLogAfter: false,
    }),
  };
  const strictConfig = {
    newApiSignInRules: {
      [origin]: { ...config.newApiSignInRules[origin], emptySuccessMeansAlreadySigned: false },
    },
  };
  const result = await tryNewApiSignIn(page, origin, strictConfig);
  assert.equal(result.status, "unconfirmed");
  assert.match(result.reason, /没有奖励消息|未判定/);
});

test("AnyRouter 声明的空成功约定只在认证有效且额度不变时确认已签到", async () => {
  const page = {
    evaluate: async () => ({
      state: "called",
      signInStatus: 200,
      responseSuccess: true,
      responseMessage: "",
      quotaDelta: 0,
      rewardLogBefore: false,
      rewardLogAfter: false,
    }),
  };
  const result = await tryNewApiSignIn(page, origin, config);
  assert.equal(result.status, "already_signed");
  assert.equal(result.evidence.source, "sign_in_already_claimed_contract");

  const missingQuota = classifyNewApiSignInObservation({
    state: "called",
    signInStatus: 200,
    responseSuccess: true,
    responseMessage: "",
    quotaDelta: null,
    rewardLogBefore: false,
    rewardLogAfter: false,
  }, configuredNewApiSignInRule(origin, config));
  assert.equal(missingQuota.status, "unconfirmed");
});

test("认证失效返回 login_required", async () => {
  const page = { evaluate: async () => ({ state: "unauthorized" }) };
  const result = await tryNewApiSignIn(page, origin, config);
  assert.equal(result.status, "login_required");
  assert.match(result.reason, /重新登录/);
});
