import test from "node:test";
import assert from "node:assert/strict";
import { applyLogicalCompletionReuse, collectLogicalCompletions } from "../src/logical-checkin.mjs";

const groups = {
  "https://first.example": "shared-site",
  "https://second.example": "shared-site",
};

test("同组后置成功会回填前置失败并移除重试状态", () => {
  const results = applyLogicalCompletionReuse([
    { origin: "https://first.example", status: "deferred", retryCause: "upstream_unavailable", nextEligibleAt: "2026-08-08T12:00:00Z" },
    { origin: "https://second.example", status: "signed", url: "https://second.example/checkin" },
  ], groups);
  assert.equal(results[0].status, "already_signed");
  assert.equal(results[0].reusedFrom, "https://second.example");
  assert.equal(results[0].nextEligibleAt, undefined);
});

test("同组不同 accountKey 不会相互复用", () => {
  const completions = collectLogicalCompletions([
    { origin: "https://first.example", accountKey: "one", status: "signed" },
  ], groups);
  assert.equal(completions.has("shared-site#account=one"), true);
  assert.equal(applyLogicalCompletionReuse([
    { origin: "https://first.example", accountKey: "one", status: "signed" },
    { origin: "https://second.example", accountKey: "two", status: "error" },
  ], groups)[1].status, "error");
});
