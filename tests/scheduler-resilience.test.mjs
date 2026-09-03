import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";

async function schedulerSource() {
  return fs.readFile(path.join(root, "scripts", "Start-UserScheduler.ps1"), "utf8");
}

async function scheduledTaskInstallerSource() {
  return fs.readFile(path.join(root, "scripts", "Install-ScheduledTask.ps1"), "utf8");
}

test("Windows 计划任务安装器清理本项目的历史用户级调度入口", async () => {
  const installer = await scheduledTaskInstallerSource();
  assert.match(installer, /'CodexBookmarkDailyCheckin'/);
  assert.match(installer, /'ChromeDailyCheckin'/);
  assert.match(installer, /\$runValue\s+-and\s+\$runValue\.IndexOf\(\$supervisorScript,/);
  assert.match(installer, /\$shortcutCommand\.IndexOf\(\$supervisorScript,/);
  assert.match(installer, /Remove-ItemProperty\s+-Path\s+\$runKey\s+-Name\s+\$legacyName/);
  assert.match(installer, /Remove-Item\s+-LiteralPath\s+\$shortcutPath/);
  assert.match(installer, /Get-CimInstance Win32_Process -Filter "Name='wscript\.exe'"/);
  assert.match(installer, /\[string\]\$_\.CommandLine\s+-like\s+"\*\$supervisorScript\*"/);
  assert.match(installer, /Stop-Process\s+-Id\s+\$_\.ProcessId\s+-Force/);
});

test("Windows 计划任务空闲时健康检查不要求常驻 heartbeat", async () => {
  const health = await fs.readFile(path.join(root, "scripts", "Test-CheckinHealth.ps1"), "utf8");
  assert.match(health, /schedulerHeartbeatFresh\s*=\s*if \(\$useUserScheduler\) \{[\s\S]*?\[bool\]\$heartbeatFresh[\s\S]*?\} else \{[\s\S]*?State.*Disabled[\s\S]*?\}/);
});

test("用户级回退会停用遗留的旧 Windows 计划任务", async () => {
  const installer = await scheduledTaskInstallerSource();
  assert.match(installer, /Disable-ScheduledTask\s+-TaskName\s+\$taskName/);
  assert.match(installer, /运行锁阻止重复签到/);
});

test("健康检查核对计划任务触发频率，避免配置更新后继续沿用旧任务", async () => {
  const health = await fs.readFile(path.join(root, "scripts", "Test-CheckinHealth.ps1"), "utf8");
  assert.match(health, /expectedTriggerMinutes/);
  assert.match(health, /actualTriggerMinutes/);
  assert.match(health, /scheduledTaskTriggerFrequencyValid/);
  assert.match(health, /Compare-Object\s+-ReferenceObject\s+\$expectedTriggerMinutes/);
  assert.match(health, /useUserScheduler/);
});

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
  assert.match(scheduler, /function Test-SchedulerShouldRun/);
  assert.match(scheduler, /\$shouldRun\s*=\s*\[bool\]\(Test-SchedulerShouldRun/);
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
  assert.match(scheduler, /\$runArguments\s*=\s*@\([\s\S]*?'-WindowStyle',\s*'Hidden'/);
  assert.match(scheduler, /Start-Process[\s\S]*?-ArgumentList\s+\$runArguments[\s\S]*?-WindowStyle\s+Hidden/);
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
  assert.match(scheduler, /schedulerMaxDailyAttempts is a hard whole-process ceiling/i);
  assert.match(scheduler, /\$attemptedToday\s*-and\s+\[int\]\$state\.attemptsToday\s+-ge\s+\$maxAttempts\)\s*\{\s*return\s+\$true/);
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
  assert.match(scheduler, /\$state\s*=\s*Read-SchedulerState\s*\r?\n\s*# Run one due identity[\s\S]*?\$deferredWakeups\s*=\s*@\(Get-UnclaimedDeferredWakeups/);
});

test("调度器拒绝结果身份重复或缺失的伪完整报告", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /\$resultIdentities\s*=\s*@\(\$results[\s\S]*?Get-CanonicalResultIdentity/);
  assert.match(scheduler, /\$uniqueResultIdentities\.Count\s+-eq\s+\$resultIdentities\.Count/);
  assert.match(scheduler, /Compare-Object\s+-ReferenceObject\s+@\(\$currentPlan\.identities\)\s+-DifferenceObject\s+\$uniqueResultIdentities/);
  assert.match(scheduler, /-and\s+\$resultIdentitiesMatch/);
});

test("书签计划指纹变化会清除旧完成状态和重试令牌", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /PlanFingerprint\s*=\s*\$null/);
  assert.match(scheduler, /latest\.bookmarkSummary\.planFingerprint/);
  assert.match(scheduler, /currentPlan\.planFingerprint/);
  assert.match(scheduler, /function Reset-SchedulerForPlanChange/);
  assert.match(scheduler, /Reset-SchedulerForPlanChange\s+\$state\s+\$currentPlanFingerprint/);
  assert.match(scheduler, /deferredWakeTokens\s*-NotePropertyValue\s*@\(\)/);
  assert.match(scheduler, /attemptsToday\s*-NotePropertyValue\s+0/);
  assert.match(scheduler, /reportComplete\s*-NotePropertyValue\s+\$false/);
  assert.match(scheduler, /statePlanChanged\s*=\s*\$statePlanFingerprint/);
  assert.match(scheduler, /reportPlanChanged\s*=\s*\[string\]\$latestReportState\.PlanFingerprint/);
  assert.match(scheduler, /Reports without a fingerprint predate execution-plan validation/);
  assert.match(scheduler, /\$planMatchesByFingerprint\s*=\s*if \(\$reportPlanFingerprint\)[\s\S]*?else \{\s*\$false\s*\}/);
  assert.match(scheduler, /-and\s+\$planMatchesByFingerprint/);
  assert.match(scheduler, /elseif \(-not \$statePlanFingerprint\)[\s\S]*?Reset-SchedulerForPlanChange/);
});

test("到期的站点延迟唤醒可以越过全局冷却时间", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /global cooldown is only a fallback/i);
  assert.match(scheduler, /-gt \[datetimeoffset\]\$now\s+-and\s+-not \$hasDeferredWakeups/);
  assert.match(scheduler, /attemptedToday[\s\S]*-and -not \$hasDeferredWakeups/);
  assert.match(scheduler, /Future cooldowns can only be bypassed by a due/i);
  assert.match(scheduler, /\$state\.nextEligibleAt\s+-and\s+@\(\$deferredWakeups\)\.Count\s+-eq\s+0/);
  assert.match(scheduler, /Select-Object\s+-First\s+1/);
  assert.match(scheduler, /\$runArguments\s*\+=\s*@\('-Origins',\s*\$wakeOrigin\.GetLeftPart/);
  assert.match(scheduler, /\$runArguments\s*\+=\s*@\('-AccountKeys',\s*\$wakeAccountKey\)/);
});

test("未来冷却且没有到期单站任务时真实 PowerShell 决策拒绝启动", async () => {
  const command = String.raw`
$scriptPath = Join-Path $env:CHECKIN_TEST_ROOT 'scripts\Start-UserScheduler.ps1'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
foreach ($name in @('Test-SchedulerWaiting', 'Test-SchedulerShouldRun')) {
  $functionAst = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
  Invoke-Expression $functionAst.Extent.Text
}
$now = [datetime]'2026-09-03T18:00:00+08:00'
$scheduledToday = [datetime]'2026-09-03T08:05:00+08:00'
$state = [pscustomobject]@{
  lastRunDate = '2026-09-03'; reportComplete = $false
  lastAttemptDate = '2026-09-03'; attemptsToday = 24
  automaticRetryCount = 1; phase = 'finished'
  nextEligibleAt = '2026-09-04T08:05:00+08:00'
}
$config = [pscustomobject]@{ schedulerMaxDailyAttempts = 5; taskTimeoutMinutes = 25 }
$blocked = Test-SchedulerShouldRun $state $now $config @() $false $scheduledToday
$due = [pscustomobject]@{ Identity = 'https://example.com'; NextEligibleAt = $now.AddMinutes(-1) }
$blockedAtGlobalLimit = Test-SchedulerShouldRun $state $now $config @($due) $false $scheduledToday
$state.attemptsToday = 2
$allowedBelowGlobalLimit = Test-SchedulerShouldRun $state $now $config @($due) $false $scheduledToday
[ordered]@{
  blocked = [bool]$blocked
  blockedAtGlobalLimit = [bool]$blockedAtGlobalLimit
  allowedBelowGlobalLimit = [bool]$allowedBelowGlobalLimit
} | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CHECKIN_TEST_ROOT: root },
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.blocked, false);
  assert.equal(result.blockedAtGlobalLimit, false);
  assert.equal(result.allowedBelowGlobalLimit, true);
});

test("调度状态分别记录执行完成与业务完成", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /ExecutionComplete = \$contractComplete/);
  assert.match(scheduler, /BusinessComplete = \$contractComplete -and \$problems\.Count -eq 0/);
  assert.match(scheduler, /reportExecutionComplete = \[bool\]\$reportState\.ExecutionComplete/);
  assert.match(scheduler, /reportBusinessComplete = \[bool\]\$reportState\.BusinessComplete/);
  assert.match(scheduler, /lastRunDate = if \(\$reportState\.ExecutionComplete\)/);
});
