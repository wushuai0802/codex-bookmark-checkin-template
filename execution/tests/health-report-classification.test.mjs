import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

test("Windows task cadence defects do not activate dormant legacy watchdog checks", async () => {
  const source = await fs.readFile(path.join(root, "scripts/Test-CheckinHealth.ps1"), "utf8");
  const ownership = source.match(/^\$windowsTaskOwnsExecution = .+$/m)[0];
  const selection = source.match(/^\$useUserScheduler = .+$/m)[0];
  const expression = "$scheduledTask = [pscustomobject]@{State='Ready'}; $scheduledTaskActionValid=$true; $scheduledTaskReady=$false; $userSchedulerConfigured=$true; " + ownership + "; " + selection + "; $useUserScheduler";
  assert.equal(runExpression(expression), "False");
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

test("跨日仍按昨日原始回执核对内部业务完成标记", async () => {
  const source = await fs.readFile(path.join(root, "scripts/Test-CheckinHealth.ps1"), "utf8");
  const start = source.indexOf("$latestStoredResultComplete =");
  const end = source.indexOf("$reportStatus =", start);
  assert.ok(start >= 0 && end > start);
  const setup = "$latestRunToday=$false; $plannedTotal=1; $processedTotal=1; $minimumTargets=1; $problemCount=0; $latest=[pscustomobject]@{runState='final';isComplete=$true;executionComplete=$true;businessComplete=$true;results=@([pscustomobject]@{status='signed'})}; ";
  assert.equal(runExpression(setup + source.slice(start, end) + "; $serializedBusinessCompleteMatches"), "True");
});
