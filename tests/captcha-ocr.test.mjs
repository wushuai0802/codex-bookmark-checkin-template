import test from "node:test";
import assert from "node:assert/strict";
import { correctCaptchaConfusions, newApiCaptchaCandidates } from "../src/captcha-ocr.mjs";

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
