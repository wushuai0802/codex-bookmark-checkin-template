import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function schedulerSource() {
  return fs.readFile(path.join(root, "scripts", "Start-UserScheduler.ps1"), "utf8");
}

test("调度器 claim 前异常也进入统一失败状态与通知链", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\$initialConfig\s*=\s*try\s*\{[\s\S]*?ConvertFrom-Json\s*\}\s*catch\s*\{\s*\$null\s*\}/);
  assert.match(scheduler, /\$lastGoodConfig\s*=\s*\$config/);
  assert.match(scheduler, /\.\s+\$runtimeResolverScript[\s\S]*?Resolve-CheckinNode\s+\$config/);
  assert.match(scheduler, /function Write-SchedulerFailureState/);
  assert.match(scheduler, /phase\s*=\s*'error'/);
  assert.match(scheduler, /reportRunState\s*=\s*'scheduler_error'/);
  assert.match(scheduler, /Write-SchedulerFailureState\s+\$message\s+\$failureConfig\s+\$claimedThisLoop/);
  assert.match(scheduler, /Write-SchedulerHeartbeat\s+'error'/);
  assert.match(scheduler, /Submit-UnifiedCheckinReport\.ps1/);
  assert.match(scheduler, /Invoke-SchedulerFailureNotification/);
  assert.match(scheduler, /\$reporterScript\s+-RunnerStatus failed[\s\S]*?-ConfigPath\s+\$temporaryConfig/);
  assert.match(scheduler, /\$outboxScript\s+-ConfigPath\s+\$temporaryConfig/);
  assert.match(scheduler, /if\s*\(\$LASTEXITCODE\s+-ne\s+0\)\s*\{\s*throw "当前书签计划检查失败/);
  assert.match(scheduler, /当前书签计划检查未返回有效 JSON/);

  const catchIndex = scheduler.search(/catch \{\r?\n\s+\$message = Compress-SchedulerError/);
  const heartbeatIndex = scheduler.indexOf("Write-SchedulerHeartbeat 'error'", catchIndex);
  const notifyIndex = scheduler.indexOf("Invoke-SchedulerFailureNotification", catchIndex);
  assert.ok(catchIndex >= 0 && heartbeatIndex > catchIndex && notifyIndex > heartbeatIndex,
    "异常后应先退出 running_checkin heartbeat，再尝试通知");
});

test("调度器与看门狗使用唯一临时文件和有界原子替换", async () => {
  const scheduler = await schedulerSource();
  const watchdog = await fs.readFile(path.join(root, "scripts", "Ensure-UserScheduler.ps1"), "utf8");
  for (const source of [scheduler, watchdog]) {
    assert.match(source, /function Write-AtomicTextFile/);
    assert.match(source, /\[guid\]::NewGuid\(\)\.ToString\('N'\)/);
    assert.match(source, /\[System\.IO\.File\]::Replace/);
    assert.match(source, /for \(\$attempt = 0; \$attempt -lt 8;/);
    assert.doesNotMatch(source, /Move-Item -LiteralPath \$temporary -Destination/);
  }
});

test("仅剩凭据拒绝等人工关注时调度器不会每小时空转", async () => {
  const scheduler = await fs.readFile(path.join(root, "scripts", "Start-UserScheduler.ps1"), "utf8");
  assert.match(scheduler, /\$automaticRetryProblems/);
  assert.match(scheduler, /AutomaticRetryCount/);
  assert.match(scheduler, /automaticRetryCount -eq 0/);
  assert.match(scheduler, /\$reportState\.AutomaticRetryCount -eq 0/);
  assert.match(scheduler, /\$automaticRetryCount\s*=\s*if\s*\(\$null -ne \$state\.automaticRetryCount\)/);
  assert.match(scheduler, /\$hasDeferredWakeups\s*=\s*@\(\$deferredWakeups\)\.Count -gt 0/);
  assert.match(scheduler, /automaticRetryCount\s*=\s*\$state\.automaticRetryCount/);
  assert.match(scheduler, /\$manualAttentionOnly\s*=\s*\$latestReportState\.Valid/);
  assert.match(scheduler, /-not \$manualAttentionOnly\s+-and\s+-not \(Test-SchedulerWaiting/);
});

test("任务级重试不会为空转凭据拒绝站点", async () => {
  const runner = await fs.readFile(path.join(root, "scripts", "Run-Checkin.ps1"), "utf8");
  assert.match(runner, /status -eq 'needs_attention'/);
  assert.match(runner, /retryCause -eq 'invalid_credential'/);
});

test("同一调度故障使用稳定哈希和冷却避免每分钟重复通知", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /Get-SchedulerErrorHash\s+\$safeMessage/);
  assert.match(scheduler, /lastSchedulerErrorHash/);
  assert.match(scheduler, /lastSchedulerErrorNotifiedAt/);
  assert.match(scheduler, /schedulerErrorNotificationCooldownMinutes/);
  assert.match(scheduler, /\$cooldown\s*=\s*\[Math\]::Max\(5,\s*\[Math\]::Min\(1440,/);
  assert.match(scheduler, /\$shouldNotify\s*=\s*-not \$sameError\s+-or\s+-not \$sameDay\s+-or\s+\$cooldownElapsed/);
  assert.match(scheduler, /Invoke-SchedulerFailureNotification\s+\$failureRecord\.Message\s+\$failureConfig\s+\$failureRecord\.ShouldNotify/);
  assert.match(scheduler, /if\s*\(\$enqueue\)\s*\{[\s\S]*?\$reporterScript/);
});

test("正常签到的 claim、隐藏启动和状态写回语义保持不变", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /Write-SchedulerClaim\s+\$runStartedAt/);
  assert.match(scheduler, /Start-Process[\s\S]*?'-WindowStyle',\s*'Hidden'/);
  assert.match(scheduler, /while\s*\(-not \$process\.HasExited\)/);
  assert.match(scheduler, /Get-LatestReportState\s+\$finishedAt\s+\$config\s+\$currentPlan\s+\$runStartedAt/);
  assert.match(scheduler, /Write-SchedulerState\s+\$finishedAt\s+\$process\.ExitCode\s+\$reportState\s+\$config/);
  assert.match(scheduler, /nextEligibleAt\s*=\s*if\s*\(\$claimed\)\s*\{[\s\S]*?\}\s*else\s*\{\s*\$state\.nextEligibleAt\s*\}/);
});

test("跨日外部报告不会搬运昨天的调度尝试次数", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\$finishedDate\s*=\s*\$finishedAt\.ToString\('yyyy-MM-dd'\)/);
  assert.match(scheduler, /\$attemptsToday\s*=\s*if\s*\(\[string\]\$state\.lastAttemptDate\s+-eq\s+\$finishedDate\)\s*\{[\s\S]*?\[Math\]::Max\(1,\s*\[int\]\$state\.attemptsToday\)[\s\S]*?\}\s*else\s*\{[\s\S]*?0[\s\S]*?\}/);
  assert.match(scheduler, /lastAttemptDate\s*=\s*\$finishedDate/);
  assert.match(scheduler, /attemptsToday\s*=\s*\$attemptsToday/);
  assert.doesNotMatch(scheduler, /lastAttemptDate\s*=\s*\$finishedAt\.ToString\('yyyy-MM-dd'\)[\s\S]*?attemptsToday\s*=\s*\[Math\]::Max\(1,\s*\[int\]\$state\.attemptsToday\)/);
});

test("子进程非零退出且没有有效报告时补发统一失败通知", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /if\s*\(\$process\.ExitCode\s+-ne\s+0\s+-and\s+-not\s+\$reportState\.Valid\)\s*\{/);
  assert.match(scheduler, /Invoke-SchedulerFailureNotification\s+\$exitMessage\s+\$config\s+\$true/);
  assert.match(scheduler, /签到子进程异常退出/);
  assert.doesNotMatch(scheduler, /if\s*\(\$process\.ExitCode\s+-eq\s+0\s+-and\s+-not\s+\$reportState\.Valid\)[\s\S]*?Invoke-SchedulerFailureNotification/);
});

test("延迟站点用身份和时间窗令牌获得有界补跑机会", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /function Get-UnclaimedDeferredWakeups/);
  assert.match(scheduler, /RetrySequence\s*-lt\s*\$perIdentityLimit/);
  assert.match(scheduler, /\$claimed\s+-notcontains\s+\[string\]\$_.Token/);
  assert.match(scheduler, /deferredWakeDate/);
  assert.match(scheduler, /deferredWakeTokens/);
  assert.match(scheduler, /Write-SchedulerClaim\s+\$runStartedAt\s+\$deferredWakeups/);
  assert.match(scheduler, /\$attemptedToday\s*-and\s+\[int\]\$state\.attemptsToday\s+-ge\s+\$maxAttempts\s+-and\s+-not \$hasDeferredWakeups/);
  assert.match(scheduler, /\$wakeTokens\s*=\s*@\(\s*@\(\s*@\(\$wakeTokens\)\s*@\(\$deferredWakeups/);
  assert.doesNotMatch(scheduler, /\$wakeTokens\s*\+\s*@\(\$deferredWakeups/);
  assert.match(scheduler, /deferredWakeTokens\s*=\s*@\(\$wakeTokens\)/);
  assert.match(scheduler, /function Get-NormalizedDeferredWakeTokens/);
  assert.match(scheduler, /function Repair-SchedulerWakeTokens/);
  assert.match(scheduler, /Repair-SchedulerWakeTokens\s*\r?\n\s*Write-SchedulerLog/);
  assert.match(scheduler, /-split '\\?\|', 4/);
});

test("外部报告仅在 runId 变化或有效状态被清除时再次通知", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\[string\]\$state\.lastRunId\s+-ne\s+\[string\]\$latestReportState\.RunId/);
  assert.match(scheduler, /\$state\.reportValid\s+-ne\s+\$true/);
  assert.doesNotMatch(scheduler, /\$hasNewExternalReport\s*=\s*\$latestReportState\.Valid[\s\S]*?\$state\.reportComplete\s+-ne\s+\$true/);
  assert.match(scheduler, /\$reporterScript\s+-RunnerStatus completed[\s\S]*?-ReportPath\s+\$latestReportPath/);
  assert.match(scheduler, /外部续跑报告通知暂未送达/);
});

test("外部报告元数据变化时同步调度状态但不重复通知", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\$reportStateNeedsSync\s*=\s*\$latestReportState\.Valid/);
  assert.match(scheduler, /\[int\]\$state\.automaticRetryCount\s+-ne\s+\[int\]\$latestReportState\.AutomaticRetryCount/);
  assert.match(scheduler, /自动重试=\$\(\$latestReportState\.AutomaticRetryCount\)/);
  assert.match(scheduler, /if \(\$hasNewExternalReport\)/);
  assert.match(scheduler, /\$state\s*=\s*Read-SchedulerState\s*\r?\n\s*\$deferredWakeups\s*=\s*Get-UnclaimedDeferredWakeups/);
});

test("调度器拒绝结果身份重复或缺失的伪完整报告", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\$resultIdentities\s*=\s*@\(\$results[\s\S]*?Get-CanonicalResultIdentity/);
  assert.match(scheduler, /\$uniqueResultIdentities\.Count\s+-eq\s+\$resultIdentities\.Count/);
  assert.match(scheduler, /Compare-Object\s+-ReferenceObject\s+@\(\$currentPlan\.identities\)\s+-DifferenceObject\s+\$uniqueResultIdentities/);
  assert.match(scheduler, /-and\s+\$resultIdentitiesMatch/);
});

test("调度状态分别记录执行完成与业务完成", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /ExecutionComplete = \$contractComplete/);
  assert.match(scheduler, /BusinessComplete = \$contractComplete -and \$problems\.Count -eq 0/);
  assert.match(scheduler, /reportExecutionComplete = \[bool\]\$reportState\.ExecutionComplete/);
  assert.match(scheduler, /reportBusinessComplete = \[bool\]\$reportState\.BusinessComplete/);
  assert.match(scheduler, /lastRunDate = if \(\$reportState\.ExecutionComplete\)/);
});
