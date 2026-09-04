import test from "node:test";
import assert from "node:assert/strict";
import { normalizeResultReason, normalizeResultReasons } from "../src/report-reason.mjs";

test("原生 Chrome 回退的 PowerShell 乱码原因恢复为可读中文", () => {
  const result = normalizeResultReason({
    status: "signed",
    nativePreflight: true,
    reason: "涓?Chrome 椤甸潰鏄庣‘纭绛惧埌鎴愬姛",
  });
  assert.equal(result.reason, "主 Chrome 页面明确确认签到成功");
});

test("非原生回退结果和正常中文原因保持不变", () => {
  const normal = { status: "signed", reason: "站点接口确认签到成功" };
  const arbitrary = { status: "signed", nativePreflight: true, reason: "站点自定义提示" };
  assert.strictEqual(normalizeResultReason(normal), normal);
  assert.strictEqual(normalizeResultReason(arbitrary), arbitrary);
  assert.deepEqual(normalizeResultReasons([normal, arbitrary]), [normal, arbitrary]);
});
