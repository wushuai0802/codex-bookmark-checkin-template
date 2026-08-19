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

test("完整且没有问题的签到报告分类为 complete", () => {
  assert.equal(classify(true, 0), "complete");
});

test("完整但含待重试或需关注站点的报告分类为 complete_with_attention", () => {
  assert.equal(classify(true, 3), "complete_with_attention");
});

test("不完整或缺失的签到报告分类为 incomplete", () => {
  assert.equal(classify(false, 0), "incomplete");
});
