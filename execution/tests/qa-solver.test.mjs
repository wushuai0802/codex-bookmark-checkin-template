import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeQaSearchQuestion, selectAnswerFromSearchText, updateQaCache } from "../src/qa-solver.mjs";

test("外部问答搜索前移除账号与站点标识", () => {
  const value = sanitizeQaSearchQuestion("账号 123456@example.com 在 https://private.example.com 提问：北京是哪个国家的首都？订单 123456789");
  assert.equal(value, "在 提问：北京是哪个国家的首都？订单");
});

test("只在搜索摘要明确给出唯一正确答案时选择选项", () => {
  const result = selectAnswerFromSearchText(
    ["白雪公主", "爱丽丝梦游仙境", "灰姑娘", "小红帽"],
    "资料页说明：正确答案：爱丽丝梦游仙境。其他选项包括白雪公主与灰姑娘。",
  );
  assert.equal(result.answer, "爱丽丝梦游仙境");
  assert.ok(result.confidence >= 80);
});

test("搜索文本只有选项罗列时不盲猜", () => {
  const result = selectAnswerFromSearchText(["A", "B", "C", "D"], "题目选项 A B C D");
  assert.equal(result.answer, null);
});

test("仅缓存页面已确认成功的问答答案", () => {
  const cache = updateQaCache({ version: 1, entries: [] }, [
    { origin: "https://pt.test", status: "signed", qa: { question: "问题", answer: "答案", verified: true, source: "web_search" } },
    { origin: "https://other.test", status: "clicked", qa: { question: "未知", answer: "猜测", verified: false } },
  ], new Date("2026-07-20T00:00:00Z"));
  assert.equal(cache.entries.length, 1);
  assert.equal(cache.entries[0].answerText, "答案");
});
