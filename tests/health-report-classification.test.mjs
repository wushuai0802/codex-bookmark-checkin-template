import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const classifier = path.join(root, "scripts", "HealthReportClassification.ps1");

function classify(latestResultValid, problemCount) {
  const command = [
    `. '${classifier.replaceAll("'", "''")}'`,
    `Get-CheckinReportStatus -LatestResultValid $${latestResultValid} -ProblemCount ${problemCount}`,
  ].join("; ");
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runExpression(expression) {
  const command = [
    `. '${classifier.replaceAll("'", "''")}'`,
    expression,
  ].join("; ");
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("完整且没有问题的签到报告分类为 complete", () => {
  assert.equal(classify(true, 0), "complete");
});

test("完整但含待重试或需关注站点的报告分类为 complete_with_attention", () => {
  assert.equal(classify(true, 3), "complete_with_attention");
});

test("不完整或缺失的签到报告分类为 incomplete", () => {
  assert.equal(classify(false, 0), "incomplete");
});

test("健康检查按问题项重算业务完成状态并拒绝旧报告假绿", () => {
  assert.equal(runExpression("Get-CheckinBusinessComplete -LatestExecutionComplete $true -ProblemCount 1"), "False");
  assert.equal(runExpression("Test-SerializedCheckinBusinessComplete -SerializedBusinessComplete $true -ComputedBusinessComplete $false"), "False");
});

test("身份集合相同但计划指纹变化时判定为不匹配", () => {
  const expression = [
    "$ids = @('https://example.test#account=primary');",
    "Test-CheckinPlanMatch -CurrentPlanIdentityReady $true -LatestPlanIdentityReady $true",
    "-LatestResultIdentityReady $true -CurrentPlanIdentities $ids -LatestPlanIdentities $ids",
    "-LatestResultIdentities $ids -CurrentPlannedTotal 1 -PlannedTotal 1",
    "-CurrentPlanFingerprint 'old' -LatestPlanFingerprint 'new'",
  ].join(" ");
  assert.equal(runExpression(expression), "False");
});

test("计划时间前没有今日结果不应被误报为调度故障", () => {
  assert.equal(runExpression("Test-CheckinRunDue -Schedule '08:05' -Now ([datetime]'2026-09-04T07:30:00')"), "False");
  assert.equal(runExpression("Test-CheckinRunDue -Schedule '08:05' -Now ([datetime]'2026-09-04T08:05:00')"), "True");
  assert.equal(runExpression("Test-CheckinRunDue -Schedule 'invalid' -Now ([datetime]'2026-09-04T07:30:00')"), "True");
});
