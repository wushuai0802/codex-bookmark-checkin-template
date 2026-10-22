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

test("乱码 nativeGate 原因保持旧提交门禁含义，不能伪装成 JSON 故障", () => {
  const input={status:'needs_attention',nativePreflight:true,nativeGate:true,
    submissionAttempted:true,failureCode:'submission_outcome_unknown',reason:'鍘熺敓绛惧埌鍙兘宸叉彁浜わ紝'};
  const result=normalizeResultReason(input);
  assert.equal(result.reason,'原生签到可能已提交，先只读核验，禁止自动重放');
  assert.equal(result.failureCode,input.failureCode);assert.equal(result.submissionAttempted,true);
  assert.doesNotMatch(result.reason,/JSON|不可读/);
});

test("只在结构化解码失败码确实存在时报告 JSON 故障", () => {
  const base={status:'unconfirmed',nativePreflight:true,reason:'�'};
  assert.doesNotMatch(normalizeResultReason(base).reason,/JSON|不可读/);
  assert.match(normalizeResultReason({...base,nativeReadback:{stage:'decode',code:'invalid_json'}}).reason,/无效 JSON/);
});
