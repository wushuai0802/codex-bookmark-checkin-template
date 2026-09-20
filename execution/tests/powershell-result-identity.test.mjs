import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(root, "scripts", "ResultIdentity.ps1").replaceAll("'", "''");
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";

test("PowerShell 身份编码与 encodeURIComponent 对空格井号和中文一致", async (context) => {
  const accountKey = "agent 1/#中文";
  const expected = `https://agent.example#account=${encodeURIComponent(accountKey)}`;
  const command = `. '${helper}'; Get-CanonicalResultIdentity ([pscustomobject]@{ origin='https://agent.example/path'; accountKey='${accountKey}' })`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8" }));
  } catch (error) {
    if (error?.code === "ENOENT") return context.skip("PowerShell unavailable");
    throw error;
  }
  assert.equal(stdout.trim(), expected);
});

test("health 与 scheduler 都使用统一的规范身份函数", async () => {
  const { readFile } = await import("node:fs/promises");
  const scheduler = await readFile(path.join(root, "scripts", "Start-UserScheduler.ps1"), "utf8");
  const health = await readFile(path.join(root, "scripts", "Test-CheckinHealth.ps1"), "utf8");
  const classification = await readFile(path.join(root, "scripts", "HealthReportClassification.ps1"), "utf8");
  for (const source of [scheduler, health]) {
    assert.match(source, /ResultIdentity\.ps1/);
    assert.match(source, /Get-CanonicalResultIdentity/);
  }
  assert.match(health, /\$latestResultIdentities\.Count\s+-eq\s+\$latestResultIdentityValues\.Count/);
  assert.match(health, /Test-CheckinPlanMatch/);
  assert.match(classification, /Compare-Object\s+-ReferenceObject\s+\$CurrentPlanIdentities\s+-DifferenceObject\s+\$LatestResultIdentities/);
});
