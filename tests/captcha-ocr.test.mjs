import test from "node:test";
import assert from "node:assert/strict";
import { correctCaptchaConfusions, correctNexusCaptchaConfusions, newApiCaptchaCandidates } from "../src/captcha-ocr.mjs";
import {
  applyExternalOcrConsensus,
  tryBaiduOcrSecondOpinion,
} from "../src/baidu-ocr.mjs";

function glyph(width, height, leftCoverage) {
  const leftInk = Math.round(height * leftCoverage);
  return {
    width,
    height,
    columnInk: [leftInk, Math.max(0, leftInk - 1), ...Array(Math.max(0, width - 2)).fill(2)],
  };
}

test("修正 HDSky 块状字体的 B/E 与 D/0 混淆", () => {
  const glyphs = [
    glyph(8, 10, 1),
    glyph(9, 10, 1),
    glyph(8, 10, 0.8),
    glyph(8, 10, 1),
    glyph(8, 10, 1),
    glyph(8, 10, 1),
  ];
  assert.equal(correctCaptchaConfusions("ME2AGE", glyphs), "MB2AGE");
  assert.equal(correctCaptchaConfusions("DFH20E", glyphs), "DFH2DE");
  assert.equal(correctCaptchaConfusions("CMEE1H", [
    glyph(8, 10, 0.8),
    glyph(8, 10, 1),
    glyph(10, 10, 1),
    glyph(7, 10, 1),
    glyph(6, 10, 0.5),
    glyph(9, 10, 1),
  ]), "CMRE1H");
});

test("不修改普通六位验证码", () => {
  const glyphs = Array.from({ length: 6 }, () => glyph(8, 10, 0.8));
  assert.equal(correctCaptchaConfusions("PH16FG", glyphs), "PH16FG");
});

test("OpenCD 识别器导出接口可用", async () => {
  const module = await import("../src/captcha-ocr.mjs");
  assert.equal(typeof module.recognizeOpenCdCaptcha, "function");
  assert.equal(typeof module.recognizeNexusCaptcha, "function");
});

test("NexusPHP 固定字体根据字形内部结构修正 6/G 混淆", () => {
  const glyphs = Array.from({ length: 6 }, () => ({ width: 8, height: 10, size: 40, middleCenterInk: 4 }));
  glyphs[1] = { width: 8, height: 10, size: 42, middleCenterInk: 1 };
  assert.equal(correctNexusCaptchaConfusions("661A35", glyphs), "6G1A35");
  assert.equal(correctNexusCaptchaConfusions("GG1A35", glyphs), "6G1A35");
});

test("外部 OCR 只能确认本地结果或本地候选，不能单独决定验证码", () => {
  assert.deepEqual(
    applyExternalOcrConsensus({ code: null, candidates: [] }, "ABC123", {
      length: 6,
      alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    }),
    { code: null, candidates: [], externalConsensus: false, externalProvider: "baidu" },
  );

  const local = {
    code: "ABC128",
    confidence: 40,
    candidates: ["A", "B", "C", "1", "2", "3"].map((character) => [{ character, score: 2 }]),
  };
  const agreed = applyExternalOcrConsensus(local, "ABC123", {
    length: 6,
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  });
  assert.equal(agreed.code, "ABC123");
  assert.equal(agreed.externalConsensus, true);
  assert.equal(agreed.confidence, 70);
});

test("百度 OCR 默认关闭并严格要求站点白名单与环境凭据", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("should not be called");
  };
  const common = {
    origin: "https://captcha.example",
    length: 5,
    alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    fetchImpl,
    env: {},
  };
  assert.equal(await tryBaiduOcrSecondOpinion(Buffer.from("image"), { config: {}, ...common }), null);
  assert.equal(await tryBaiduOcrSecondOpinion(Buffer.from("image"), {
    config: { baiduOcr: { enabled: true, allowedOrigins: ["https://other.example"] } },
    ...common,
  }), null);
  assert.equal(calls, 0);
});

test("百度 OCR 请求只返回规范化验证码，不暴露令牌响应", async () => {
  const responses = [
    { ok: true, json: async () => ({ access_token: "test" + "-token", expires_in: 3600 }) },
    { ok: true, json: async () => ({ words_result: [{ words: "A B C 2 3" }] }) },
  ];
  const result = await tryBaiduOcrSecondOpinion(Buffer.from("image"), {
    config: { baiduOcr: { enabled: true, allowedOrigins: ["https://captcha.example"], timeoutMs: 1000 } },
    origin: "https://captcha.example",
    length: 5,
    alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
    env: {
      CHECKIN_BAIDU_OCR_API_KEY: "test" + "-api-value",
      CHECKIN_BAIDU_OCR_SECRET_KEY: "test" + "-secret-value",
    },
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result, "ABC23");
});

test("New API 五位验证码只生成有界的高分候选", () => {
  const recognition = {
    candidates: [
      [{ character: "K", score: 10 }, { character: "X", score: 1 }],
      [{ character: "P", score: 9 }],
      [{ character: "T", score: 8 }, { character: "7", score: 2 }],
      [{ character: "4", score: 7 }],
      [{ character: "C", score: 6 }, { character: "G", score: 5 }],
    ],
  };
  assert.deepEqual(newApiCaptchaCandidates(recognition, 4), ["KPT4C", "KPT4G", "KP74C", "KP74G"]);
  assert.deepEqual(newApiCaptchaCandidates({ candidates: [] }), []);
});
