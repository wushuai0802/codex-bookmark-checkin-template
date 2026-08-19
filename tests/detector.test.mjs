import test from "node:test";
import assert from "node:assert/strict";
import { classifyPageText, formatDailyReason, isCheckinSingleChoiceChallenge, scoreActionText, solveArithmeticQuestion } from "../src/detector.mjs";

test("识别已签到状态", () => {
  assert.equal(classifyPageText({ bodyText: "您今日已签到，请明天再来" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "邀请 [发送]: 0 [已签到] 分享率" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "[查看签到记录] [21点]" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "[查看簽到記錄] [21點]" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "抱歉 您今天已经签到过了，请勿重复刷新。" }).status, "already_signed");
  assert.equal(classifyPageText({ bodyText: "鲸币 [使用]: 154,464.0 (签到已得350)" }).status, "already_signed");
});

test("识别签到成功状态", () => {
  assert.equal(classifyPageText({ bodyText: "签到成功，获得 10 积分" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "这是您的第159次签到，本次签到获得800个憨豆。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "回答正确，签到奖励已发放。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "申请额度成功，额度已发放。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "额度申请已提交，请稍后查看。" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "领取 Codex 权益成功" }).status, "signed");
  assert.equal(classifyPageText({ bodyText: "Codex 权益已领取" }).status, "already_signed");
});

test("带图片验证码的登录页仍识别为登录失效", () => {
  const result = classifyPageText({ url: "https://example.test/login", challengeSelectors: true, hasPassword: true });
  assert.equal(result.status, "login_required");
  assert.match(result.reason, /验证码/);
});

test("说明文字不被误判为当前人机挑战", () => {
  assert.equal(classifyPageText({ bodyText: "每日签到 完成人机验证即可领取奖励" }).status, "ready");
});

test("签到功能说明和历史入口不被误判为已完成", () => {
  assert.equal(classifyPageText({ bodyText: "每日签到可获得随机额度奖励" }).status, "ready");
  assert.equal(classifyPageText({ bodyText: "查看签到记录" }).status, "ready");
});

test("识别 Linux DO 登录入口", () => {
  assert.equal(classifyPageText({ bodyText: "使用 Linux DO 登录" }).status, "login_required");
});

test("可见的 Cloudflare 复选框优先识别为交互挑战", () => {
  assert.equal(classifyPageText({ bodyText: "正在进行安全验证 请验证您是真人" }).status, "interactive_challenge");
});

test("无复选框的托管验证继续等待", () => {
  assert.equal(classifyPageText({ bodyText: "Just a moment... 正在验证您是否是真人" }).status, "managed_challenge");
});

test("识别带连字符的登录路径", () => {
  assert.equal(classifyPageText({ url: "https://example.test/sign-in?redirect=%2Fconsole" }).status, "login_required");
});

test("识别站点频率限制并延后处理", () => {
  const result = classifyPageText({ bodyText: "操作过于频繁，请稍后再试" });
  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "rate_limit");
});

test("识别 Cloudflare 522 为站点故障并延后处理", () => {
  const result = classifyPageText({
    title: "Connection timed out",
    bodyText: "Error code 522 Browser Working Cloudflare Working Host Error",
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "upstream_unavailable");
});

test("识别站点维护页和容量耗尽页并延后处理", () => {
  for (const bodyText of [
    "SCHEDULED MAINTENANCE 正在进行系统维护 HTTP 503 Service Unavailable",
    "系统维护进行中 号池用尽，自动切换维护页",
  ]) {
    const result = classifyPageText({ bodyText });
    assert.equal(result.status, "deferred");
    assert.equal(result.retryCause, "upstream_unavailable");
  }
});

test("额度申请理由按上海日期生成唯一文案", () => {
  assert.equal(formatDailyReason("{date} 用于开发测试", new Date("2026-07-23T00:30:00Z")), "2026年7月23日 用于开发测试");
});

test("识别公开首页的登录注册入口", () => {
  assert.equal(classifyPageText({ bodyText: "首页 控制台 登录 注册 获取密钥" }).status, "login_required");
});

test("只选择明确的签到动作", () => {
  assert.ok(scoreActionText("立即签到") > 0);
  assert.ok(scoreActionText("[签到]") > 0);
  assert.ok(scoreActionText("福利站") > 0);
  assert.ok(scoreActionText("开始转动") > 0);
  assert.ok(scoreActionText("申请额度") > 0);
  assert.ok(scoreActionText("领取 Codex 权益") > 0);
  assert.ok(scoreActionText("領取Codex權益") > 0);
  assert.equal(scoreActionText("签到记录"), -1);
  assert.equal(scoreActionText("购买"), -1);
});

test("只计算简单安全整数算式", () => {
  assert.equal(solveArithmeticQuestion("请回答 12 × 3"), "36");
  assert.equal(solveArithmeticQuestion("10 / 4"), null);
  assert.equal(solveArithmeticQuestion("没有算式"), null);
});

test("普通首页投票不会被当成签到问答", () => {
  assert.equal(isCheckinSingleChoiceChallenge({
    contextText: "你更喜欢哪种视频规格？ 选项 A 选项 B 投票",
    submitTexts: ["投票"],
  }), false);
  assert.equal(isCheckinSingleChoiceChallenge({
    contextText: "签到答题 [单选] 请选择正确答案",
    submitTexts: ["提交"],
  }), true);
});
