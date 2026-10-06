import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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

test("计划任务通过 GUI 启动器运行 PowerShell，避免控制台闪现", async () => {
  const installer = await scheduledTaskInstallerSource();
  const launcher = await fs.readFile(path.join(root, "scripts", "Run-HiddenPowerShell.vbs"), "utf8");
  assert.match(installer, /Run-HiddenPowerShell\.vbs/);
  assert.match(installer, /New-ScheduledTaskAction\s+-Execute\s+\$wscript/);
  assert.match(installer, /\/\/B \/\/NoLogo/);
  assert.match(launcher, /shell\.Run\(command, 0, True\)/);
  assert.match(launcher, /CommandArgument/);
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
  assert.match(scheduler, /retryExhaustedForDay\s+-eq\s+\$true/);
  assert.match(scheduler, /automaticRetryCount\s*=\s*\$state\.automaticRetryCount/);
  assert.match(scheduler, /\$manualAttentionOnly\s*=\s*\$latestReportState\.Valid/);
  assert.match(scheduler, /function Test-SchedulerShouldRun/);
  assert.match(scheduler, /\$shouldRun\s*=\s*\[bool\]\(Test-SchedulerShouldRun/);
  assert.doesNotMatch(scheduler, /managed_challenge_timeout', 'visited', 'clicked'/);
  assert.doesNotMatch(scheduler, /'unconfirmed', 'deferred'/);
  assert.match(scheduler, /\.submissionAttempted\s+-ne\s+\$true/);
  assert.match(scheduler, /\.retryable\s+-ne\s+\$false/);
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

test("身份校验失败的 final 报告进入有界冷却重试，不进入永久等待", async (context) => {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $env:CHECKIN_TEST_ROOT 'scripts\Start-UserScheduler.ps1'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Scheduler syntax error' }
foreach ($name in @('Get-NormalizedDeferredWakeTokens', 'ConvertTo-ShanghaiIso', 'Write-SchedulerState', 'Test-SchedulerWaiting')) {
  $f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
  Invoke-Expression $f.Extent.Text
}
$script:state = [pscustomobject]@{
  lastAttemptDate = '2026-10-06'; attemptsToday = 1; invalidReportRetryCount = 0
  lastAttemptStartedAt = '2026-10-06T08:05:00+08:00'; lastFinishedAt = '2026-10-06T08:14:50+08:00'
  lastRunDate = $null; lastExitCode = 2; reportValid = $false; reportComplete = $false
  reportExecutionComplete = $false; reportBusinessComplete = $false; lastRunId = $null
  problemCount = $null; automaticRetryCount = 0; reportRunState = $null; plannedTotal = 0; processedTotal = 0
  planFingerprint = 'fixture'; deferredWakeDate = '2026-10-06'; deferredWakeTokens = @()
}
$script:written = $null
$script:writtenRaw = $null
function Read-SchedulerState { return $script:state }
function Write-AtomicTextFile([string]$Destination, [string]$Content) { $script:writtenRaw = $Content; $script:written = $Content | ConvertFrom-Json }
$report = [pscustomobject]@{ Valid = $false; Complete = $false; ExecutionComplete = $false; BusinessComplete = $false; AutomaticRetryCount = $null; NextEligibleAt = $null; RunId = $null; ProblemCount = $null; RunState = $null; PlannedTotal = 0; ProcessedTotal = 0 }
$finished = [DateTime]::SpecifyKind([datetime]'2026-10-06T00:14:50', [DateTimeKind]::Utc)
$config = [pscustomobject]@{ schedulerFailureRetryMinutes = 60; schedulerMaxDailyAttempts = 5; taskTimeoutMinutes = 25 }
Write-SchedulerState $finished 2 $report $config
$waiting = Test-SchedulerWaiting $script:written $finished.AddMinutes(60) $config @()
[ordered]@{
  valid = $script:written.reportValid
  runState = $script:written.reportRunState
  retryCount = [int]$script:written.invalidReportRetryCount
  automaticRetryCount = [int]$script:written.automaticRetryCount
  nextEligibleAt = ([regex]::Match($script:writtenRaw, '"nextEligibleAt"\s*:\s*"([^"]+)"')).Groups[1].Value
  waitingWhenDue = [bool]$waiting
} | ConvertTo-Json -Compress
`;
  let stdout;
  try {
    ({ stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root, encoding: "utf8", env: { ...process.env, CHECKIN_TEST_ROOT: root },
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return context.skip("PowerShell unavailable");
    throw error;
  }
  const observed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(observed.valid, false);
  assert.equal(observed.runState, "invalid_report");
  assert.equal(observed.retryCount, 1);
  assert.equal(observed.automaticRetryCount, 1);
  assert.equal(observed.nextEligibleAt, "2026-10-06T09:14:50+08:00");
  assert.equal(observed.waitingWhenDue, false);
});

test("延迟站点用身份和时间窗令牌获得有界补跑机会", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /function Get-UnclaimedDeferredWakeups/);
  assert.match(scheduler, /RetrySequence\s*-lt\s*\$perIdentityLimit/);
  assert.match(scheduler, /\$claimed\s+-notcontains\s+\[string\]\$_.Token/);
  assert.match(scheduler, /deferredWakeDate/);
  assert.match(scheduler, /deferredWakeTokens/);
  assert.match(scheduler, /Write-SchedulerClaim\s+\$runStartedAt\s+\$deferredWakeups/);
  assert.match(scheduler, /Ordinary retries and due site wakeups have separate bounded budgets/i);
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
  assert.match(scheduler, /\$resultIdentities\s*=\s*@\(\$results[\s\S]*?Get-PlanCompatibleResultIdentity/);
  assert.match(scheduler, /Get-PlanDefaultOrigins\s+@\(\$latest\.bookmarkSummary\.targets\)/);
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
foreach ($name in @('Test-SchedulerWaiting', 'Test-SchedulerShouldRun', 'Get-UnclaimedDeferredWakeups', 'Get-NormalizedDeferredWakeTokens')) {
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
$state.attemptsToday = 100
$blockedAtAbsoluteLimit = Test-SchedulerShouldRun $state $now $config @($due) $false $scheduledToday
$wakeState=[pscustomobject]@{deferredWakeDate='2026-09-03';deferredWakeTokens=@()}
$wakeReport=[pscustomobject]@{Valid=$true;DeferredWakeups=@(
  [pscustomobject]@{Token='late';NextEligibleAt=([datetimeoffset]$now);RetrySequence=5;RetryExhaustedForDay=$false;LateRetryPending=$true;RetryCause='upstream_unavailable'},
  [pscustomobject]@{Token='exhausted';NextEligibleAt=([datetimeoffset]$now);RetrySequence=5;RetryExhaustedForDay=$false;LateRetryPending=$false;RetryCause='upstream_unavailable'},
  [pscustomobject]@{Token='harvest';NextEligibleAt=([datetimeoffset]$now);RetrySequence=0;RetryExhaustedForDay=$false;LateRetryPending=$false;RetryCause='harvest_waiting'}
)}
$eligibleTokens=@(Get-UnclaimedDeferredWakeups $wakeState $wakeReport $now $config | ForEach-Object {$_.Token})
[ordered]@{
  blocked = [bool]$blocked
  blockedAtGlobalLimit = [bool]$blockedAtGlobalLimit
  allowedBelowGlobalLimit = [bool]$allowedBelowGlobalLimit
  blockedAtAbsoluteLimit = [bool]$blockedAtAbsoluteLimit
  eligibleTokens = $eligibleTokens
} | ConvertTo-Json -Compress
`;
  const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CHECKIN_TEST_ROOT: root },
  });
  const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(result.blocked, false);
  assert.equal(result.blockedAtGlobalLimit, true);
  assert.equal(result.allowedBelowGlobalLimit, true);
  assert.equal(result.blockedAtAbsoluteLimit, false);
  assert.deepEqual(result.eligibleTokens,['late','harvest']);
});

test("调度状态分别记录执行完成与业务完成", async () => {
  const scheduler = await schedulerSource();
  assert.match(scheduler, /ExecutionComplete = \$contractComplete/);
  assert.match(scheduler, /BusinessComplete = \$contractComplete -and \$problems\.Count -eq 0/);
  assert.match(scheduler, /reportExecutionComplete = \[bool\]\$reportState\.ExecutionComplete/);
  assert.match(scheduler, /reportBusinessComplete = \[bool\]\$reportState\.BusinessComplete/);
  assert.match(scheduler, /lastRunDate = if \(\$reportState\.ExecutionComplete\)/);
});

test('连续补跑逐次持久化回执，在调度 finally 中只投递一次', async () => {
  const command = String.raw`
$ErrorActionPreference = 'Stop'
function Read-Ast([string]$name) {
  $tokens=$null; $errors=$null
  $ast=[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:CHECKIN_TEST_ROOT "scripts/$name"),[ref]$tokens,[ref]$errors)
  if($errors.Count){throw 'parse error'}
  return $ast
}
$runner = Read-Ast 'Run-Checkin.ps1'
$scheduler = Read-Ast 'Start-UserScheduler.ps1'
$runnerTry = $runner.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] } | Select-Object -Last 1
$batchFinally = $scheduler.FindAll({param($n) $n -is [System.Management.Automation.Language.TryStatementAst] -and $n.Finally.Extent.Text -match 'deferredNotificationDelivery'},$true) | Select-Object -First 1
if(-not $batchFinally){throw 'batch finally missing'}
$script:queued=0; $script:delivered=0
function Invoke-FixtureReporter { $script:queued++ }
function Invoke-FixtureOutbox { $script:delivered++ }
function Get-FreshResumeReport { [pscustomobject]@{Path='fixture'} }
$reporterScript='Invoke-FixtureReporter'; $outboxScript='Invoke-FixtureOutbox'
$DryRun=$false; $SuppressReport=$false; $DeferNotificationDelivery=$true
$locationPushed=$false; $wrapperMutexOwned=$false; $wrapperMutex=$null
$startedAt=Get-Date; $runnerStatus='completed'; $runnerMessage='fixture'
foreach($pass in 1..3){foreach($statement in $runnerTry.Finally.Statements){Invoke-Expression $statement.Extent.Text}}
$during=$script:delivered
$deferredNotificationDelivery=$true
foreach($statement in $batchFinally.Finally.Statements){Invoke-Expression $statement.Extent.Text}
$after=$script:delivered
$DeferNotificationDelivery=$false
foreach($statement in $runnerTry.Finally.Statements){Invoke-Expression $statement.Extent.Text}
[ordered]@{queued=$script:queued;during=$during;after=$after;manual=$script:delivered}|ConvertTo-Json -Compress
`;
  const {stdout} = await execFileAsync(powershell, ['-NoProfile','-NonInteractive','-Command',command], {
    cwd:root,encoding:'utf8',env:{...process.env,CHECKIN_TEST_ROOT:root},
  });
  assert.deepEqual(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)), {queued:4,during:0,after:1,manual:2});
  assert.match(await schedulerSource(), /\$runArguments \+= '-DeferNotificationDelivery'/);
});

for (const shell of process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : [powershell]) {
  test(`Harvest 等待队列在同一轮依次续跑，保留冷却和提交保护 (${shell})`, async (t) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-wake-drain-"));
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    const reportFile = path.join(fixture, "latest.json");
    const result = (name, nextEligibleAt, extra = {}) => ({
      origin: `https://${name}.example`, status: "deferred", retryCause: "harvest_waiting",
      nextEligibleAt, submissionAttempted: false, retrySequence: 0, ...extra,
    });
    const results = [
      result("first", "2026-10-01T01:10:00Z"),
      result("second", "2026-10-01T01:11:00Z"),
      result("third", "2026-10-01T01:12:00Z"),
      result("depth", "2026-10-01T01:35:08Z"),
      result("future", "2026-10-01T06:20:00Z"),
      result("unknown", "2026-10-01T01:10:00Z", { submissionAttempted: true, failureCode: "submission_outcome_unknown" }),
      result("disabled", "2026-10-01T01:10:00Z", { retryable: false }),
      result("exhausted", "2026-10-01T01:10:00Z", { retryExhaustedForDay: true }),
      result("signed", "2026-10-01T01:10:00Z", { status: "already_signed" }),
    ];
    await fs.writeFile(reportFile, JSON.stringify({
      runId: "20261001-fixture", runState: "final", isComplete: true,
      plannedTotal: results.length, processedTotal: results.length, results,
      bookmarkSummary: { planFingerprint: "fixture", targets: results.map(({ origin }) => ({ origin })) },
    }));
    const command = String.raw`
$ErrorActionPreference = 'Stop'
. (Join-Path $env:CHECKIN_TEST_ROOT 'scripts/ResultIdentity.ps1')
. (Join-Path $env:CHECKIN_TEST_ROOT 'scripts/ResultContract.ps1')
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $env:CHECKIN_TEST_ROOT 'scripts/Start-UserScheduler.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Scheduler syntax error' }
foreach ($name in @('Get-LatestReportState', 'Get-UnclaimedDeferredWakeups', 'Get-NormalizedDeferredWakeTokens', 'Get-SchedulerDrainWakeups', 'Test-SchedulerWaiting', 'Test-SchedulerShouldRun')) {
  $f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true) | Select-Object -First 1
  Invoke-Expression $f.Extent.Text
}
$latestReportPath = $env:CHECKIN_TEST_REPORT
$latest = Get-Content -Raw $latestReportPath | ConvertFrom-Json
$plan = [pscustomobject]@{ targetCount = $latest.plannedTotal; planFingerprint = 'fixture'; identities = @($latest.results | ForEach-Object { Get-CanonicalResultIdentity $_ }) }
$config = [pscustomobject]@{ schedulerMaxDailyAttempts = 5; taskTimeoutMinutes = 25 }
$start = [datetime]::SpecifyKind([datetime]'2026-10-01T01:35:02', [DateTimeKind]::Utc)
$now = $start
$report = Get-LatestReportState $now $config $plan
$state = [pscustomobject]@{ lastRunDate = '2026-10-01'; lastAttemptDate = '2026-10-01'; attemptsToday = 5; reportComplete = $false; automaticRetryCount = 4; phase = 'finished'; nextEligibleAt = '2026-10-01T06:20:00Z'; deferredWakeDate = '2026-10-01'; deferredWakeTokens = @() }
$visited = @()
$due = @(Get-UnclaimedDeferredWakeups $state $report $now $config | Sort-Object NextEligibleAt, Identity | Select-Object -First 1)
while ($due.Count -and (Test-SchedulerShouldRun $state $now $config $due $false $start.Date)) {
  $visited += [string]$due[0].Identity
  $state.attemptsToday += 1
  $state.deferredWakeTokens += [string]$due[0].Token
  $now = $now.AddSeconds(15)
  $report = Get-LatestReportState $now $config $plan
  $due = @(Get-SchedulerDrainWakeups $state $report $now $config $start $visited)
  if ($visited.Count -gt 6) { throw 'Unbounded drain' }
}
$state.deferredWakeTokens = @()
$six = @('a', 'b', 'c', 'd', 'e', 'f')
$bounded = @(Get-SchedulerDrainWakeups $state $report $now $config $start $six).Count
$timedOut = @(Get-SchedulerDrainWakeups $state $report $start.AddMinutes(25) $config $start @()).Count
$crossDay = @(Get-SchedulerDrainWakeups $state $report $start.AddDays(1) $config $start @()).Count
$invalid = @(Get-SchedulerDrainWakeups $state ([pscustomobject]@{ Valid = $false }) $now $config $start @()).Count
$accountReport = [pscustomobject]@{ Valid = $true; DeferredWakeups = @([pscustomobject]@{ Identity = 'https://multi.example#account=second'; NextEligibleAt = [datetimeoffset]$now; RetrySequence = 0; RetryCause = 'harvest_waiting'; SubmissionAttempted = $false; Token = 'account'; RetryExhaustedForDay = $false }) }
$account = @(Get-SchedulerDrainWakeups $state $accountReport $now $config $start @())
$claimed = @(Get-SchedulerDrainWakeups $state $accountReport $now $config $start @('https://multi.example#account=second')).Count
[ordered]@{ valid = $report.Valid; visited = $visited; bounded = $bounded; timedOut = $timedOut; crossDay = $crossDay; invalid = $invalid; account = $account[0].Identity; repeated = $claimed } | ConvertTo-Json -Compress
`;
    const { stdout } = await execFileAsync(shell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, CHECKIN_TEST_ROOT: root, CHECKIN_TEST_REPORT: reportFile },
    });
    const observed = JSON.parse(stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(observed.valid, true);
    assert.deepEqual(observed.visited, ["first", "second", "third", "depth"].map(name => `https://${name}.example`));
    for (const key of ["bounded", "timedOut", "crossDay", "invalid", "repeated"]) assert.equal(observed[key], 0, key);
    assert.equal(observed.account, "https://multi.example#account=second");
    const source = await schedulerSource();
    assert.match(source, /while \(\$shouldRun\)/);
    assert.match(source, /\$latestReportState = Get-LatestReportState \$now \$config \$currentPlan \$runStartedAt[\s\S]*?Get-SchedulerDrainWakeups/);
  });
}
