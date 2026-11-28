import assert from "node:assert/strict";
import test from "node:test";
import * as browserFacade from "../src/browser.mjs";
import * as vibeQuota from "../src/vibe-quota-flow.mjs";
import * as qaChallenge from "../src/qa-challenge-flow.mjs";

test("browser.mjs 门面无损重导出 vibe-quota-flow 公共接口", () => {
  assert.equal(browserFacade.classifyVibeClaimResponse, vibeQuota.classifyVibeClaimResponse);
  assert.equal(browserFacade.waitForActiveQuotaBenefit, vibeQuota.waitForActiveQuotaBenefit);
  assert.equal(browserFacade.waitForQuotaRequestField, vibeQuota.waitForQuotaRequestField);
  assert.equal(typeof browserFacade.tryQuotaRequestFlow, "function");
  assert.equal(typeof qaChallenge.tryQaFlow, "function");
  assert.equal(typeof qaChallenge.findMatchingQaRule, "function");
});

test("findMatchingQaRule 精确匹配同源问题并忽略其他站点规则", async () => {
  const page = {
    locator: () => ({
      innerText: async () => "每日签到 请问：下面哪一个是标准协议？",
    }),
  };
  const rules = [
    { origin: "https://other.example", questionIncludes: "标准协议", answerText: "HTTP", submitText: "提交" },
    { origin: "https://qa.example", questionIncludes: "标准协议", answerText: "HTTPS", submitText: "提交" },
  ];
  const matched = await qaChallenge.findMatchingQaRule(page, rules, "https://qa.example");
  assert.equal(matched?.answerText, "HTTPS");
  assert.equal(await qaChallenge.findMatchingQaRule(page, rules, "https://none.example"), null);
});

test("tryQaFlow 在未注入 waitForManagedChallenge 时对已提交结果保守退回 interactive_challenge", async () => {
  let checkedIndex = null;
  let clickedSubmit = false;
  const page = {
    locator: (selector) => {
      if (selector === 'input[type="radio"]') {
        return {
          count: async () => 2,
          evaluateAll: async () => [
            { question: "请问测试问题？", options: ["选项A", "选项B"], contextText: "每日签到 请问测试问题？", submitTexts: ["提交"] },
          ],
          nth: (index) => ({ check: async () => { checkedIndex = index; } }),
        };
      }
      if (selector === "body") {
        return { innerText: async () => "每日签到 请问测试问题？" };
      }
      return {
        evaluateAll: async () => [{ index: 0, text: "提交" }],
        nth: () => ({ click: async () => { clickedSubmit = true; } }),
      };
    },
    getByText: () => ({ count: async () => 1, click: async () => { checkedIndex = 0; } }),
  };
  const result = await qaChallenge.tryQaFlow(
    page,
    [{ origin: "https://qa.example", questionIncludes: "测试问题", answerText: "选项A", submitText: "提交" }],
    "https://qa.example",
    { actionWaitMs: 0 },
  );
  assert.equal(checkedIndex, 0);
  assert.equal(clickedSubmit, true);
  assert.equal(result.status, "interactive_challenge");
  assert.equal(result.qa.verified, false);
});
