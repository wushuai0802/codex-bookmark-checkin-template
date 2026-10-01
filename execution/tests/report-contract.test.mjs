import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const logsRoot = path.join(root, "logs");
const reporter = path.join(root, "scripts", "Submit-UnifiedCheckinReport.ps1");
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";

async function previewReport(report, runnerStatus = "completed", configOverride = null) {
  await fs.mkdir(logsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(logsRoot, "report-contract-test-"));
  const reportPath = path.join(directory, "report.json");
  const configPath = path.join(directory, "config.json");
  try {
    const reportWithContract = report.runState === "final" && !report.bookmarkSummary
      ? { ...report, bookmarkSummary: { targets: report.results.map(({ origin, accountKey }) => ({ origin, accountKey })) } }
      : report;
    await fs.writeFile(reportPath, JSON.stringify(reportWithContract), "utf8");
    if (configOverride) await fs.writeFile(configPath, JSON.stringify(configOverride), "utf8");
    const reporterArguments = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", reporter,
      "-RunnerStatus", runnerStatus,
      "-ReportPath", reportPath,
      "-Preview",
    ];
    if (configOverride) reporterArguments.push("-ConfigPath", configPath);
    const { stdout } = await execFileAsync(powershell, [
      ...reporterArguments,
    ], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim());
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("部分进度即使全部已签到也不会报告成功", async () => {
  const report = await previewReport({
    runId: "20260723-120000",
    runState: "in_progress",
    plannedTotal: 5,
    processedTotal: 2,
    isComplete: true,
    results: [
      { origin: "https://one.test", status: "signed" },
      { origin: "https://two.test", status: "already_signed" },
    ],
  });

  assert.equal(report.status, "unconfirmed");
  assert.equal(report.isComplete, false);
  assert.match(report.summary, /任务未完成：已处理 2\/5 项/);
  assert.match(report.summary, /已签到 2\/5/);
});

test("部分进度在运行器超时时保持超时状态", async () => {
  const report = await previewReport({
    runId: "20260723-120001",
    runState: "in_progress",
    plannedTotal: 5,
    processedTotal: 1,
    isComplete: false,
    results: [{ origin: "https://one.test", status: "signed" }],
  }, "timeout");

  assert.equal(report.status, "timeout");
  assert.match(report.summary, /任务未完成：已处理 1\/5 项/);
});

test("只有完整的 final 报告可以映射为今日已完成", async () => {
  const report = await previewReport({
    runId: "20260723-120002",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      { origin: "https://one.test", status: "already_signed" },
      { origin: "https://two.test", status: "already_signed" },
    ],
  });

  assert.equal(report.status, "already_done");
  assert.equal(report.isComplete, true);
  assert.equal(report.summary, '已签到 2/2');
});

test("同一逻辑站点的两个取消任务只统计一次", async () => {
  const report = await previewReport({
    runId: "20260723-120002-logical-group",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      {
        origin: "https://checkin.example", status: "not_available", disabledByConfig: true,
        availabilityKind: "task_disabled",
        evidence: { source: "configuration", authoritative: true, confirmedAt: "2026-07-23T00:00:00Z" },
      },
      {
        origin: "https://console.example", status: "not_available", disabledByConfig: true,
        availabilityKind: "task_disabled",
        evidence: { source: "configuration", authoritative: true, confirmedAt: "2026-07-23T00:00:00Z" },
      },
    ],
  }, "completed", {
    logicalCheckinGroups: {
      "https://checkin.example": "example-service",
      "https://console.example": "example-service",
    },
    notification: { mode: "none" },
  });

  assert.equal(report.status, "skipped");
  assert.equal(report.siteCount, 1);
  assert.equal(report.summary, '已签到 0/1 · 已取消 1');
  assert.doesNotMatch(report.summary, /未开放/);
});

test("同一站点的三个成功账号分别统计，通知不重复列出明细", async () => {
  const accountIds = ["10001", "20002", "30003"];
  const report = await previewReport({
    runId: "20260723-120002-three-accounts",
    runState: "final",
    plannedTotal: 3,
    processedTotal: 3,
    isComplete: true,
    bookmarkSummary: {
      targets: accountIds.map((accountId) => ({
        origin: "https://agentrouter.example",
        accountKey: `agentrouter-${accountId}`,
      })),
    },
    results: accountIds.map((accountId) => ({
      origin: "https://agentrouter.example",
      accountKey: `agentrouter-${accountId}`,
      accountId,
      accountLabel: accountId,
      status: "signed",
      evidence: { rewardAmount: 25 },
    })),
  });

  assert.equal(report.status, "success");
  assert.equal(report.siteCount, 3);
  assert.equal(report.summary, '已签到 3/3');
  for (const accountId of accountIds) assert.doesNotMatch(report.summary, new RegExp(accountId));
});

test("通知事件键对相同状态稳定并在结果变化后更新", async () => {
  const base = {
    runId: "20260723-120003",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
  };
  const deferred = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "deferred", retryCause: "rate_limit" }],
  });
  const repeated = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "deferred", retryCause: "rate_limit" }],
  });
  const completed = await previewReport({
    ...base,
    results: [{ origin: "https://one.test", status: "signed" }],
  });

  assert.equal(deferred.eventKey, repeated.eventKey);
  assert.notEqual(deferred.eventKey, completed.eventKey);
});

test("延迟重试按原因区分登录恢复和安全验证", async () => {
  const report = await previewReport({
    runId: "20260723-120003",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      {
        origin: "https://login.example.test",
        status: "deferred",
        retryCause: "login_required",
        nextEligibleAt: "2026-07-23T11:00:00Z",
      },
      {
        origin: "https://challenge.example.test",
        status: "deferred",
        retryCause: "managed_challenge_timeout",
        nextEligibleAt: "2026-07-23T06:00:00Z",
      },
    ],
  });

  assert.equal(report.status, "retrying");
  assert.match(report.summary, /待重试 2/);
  assert.doesNotMatch(report.summary, /需处理/);
  assert.match(report.summary, /login\.example\.test：登录待恢复 · /);
  assert.match(report.summary, /challenge\.example\.test：验证待通过 · /);
});

test("native readback errors are not reported as failed verification, including saved legacy results", async () => {
  for (const retryCause of ["native_readback_unavailable", "managed_challenge_timeout"]) {
    const report = await previewReport({
      runId: "20260905-120004", runState: "final", plannedTotal: 1, processedTotal: 1, isComplete: true,
      results: [{ origin: "https://readback.example.test", status: "deferred", retryCause,
        nativePreflight: true, inspectionStatus: "accessibility_unavailable" }],
    });
    assert.match(report.summary, /未读到结果，状态待确认/);
    assert.doesNotMatch(report.summary, /验证未自动通过/);
  }
});

test("cleanup warning preserves confirmed checkin but remains visible", async () => {
  const base = { runId: "20260905-120005", runState: "final", plannedTotal: 1, processedTotal: 1, isComplete: true };
  const result = { origin: "https://cleanup.example.test", status: "signed" };
  const clean = await previewReport({ ...base, results: [result] });
  const warning = await previewReport({ ...base, results: [{ ...result, cleanupFailureCode: "window_cleanup_failed" }] });
  assert.equal(warning.status, clean.status);
  assert.match(warning.summary, /窗口清理异常/);
  assert.match(warning.summary, /已签到 1\/1/);
  assert.notEqual(warning.eventKey, clean.eventKey);
});

test("站点故障单列外部条件，保留有限复核时间而不误报本地失败", async () => {
  const report = await previewReport({
    runId: "20260723-120004",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://offline.example.test",
      status: "deferred",
      retryCause: "upstream_unavailable",
      nextEligibleAt: "2026-07-23T06:00:00Z",
    }],
  });

  assert.equal(report.status, "unconfirmed");
  assert.equal(report.externalPendingCount,1);
  assert.match(report.summary, /等待外部 1/);
  assert.match(report.summary, /offline\.example\.test：上游暂不可用/);
  assert.match(report.summary, /复核|等待调度/);
  assert.doesNotMatch(report.summary, /需处理|待重试|❌/);
});

test('unknown submissions stay in verification even if the site is under maintenance',async()=>{
  const report=await previewReport({runId:'20260930-review',runState:'final',plannedTotal:1,processedTotal:1,isComplete:true,
    results:[{origin:'https://review.example.test',status:'needs_attention',failureCode:'submission_outcome_unknown',
      submissionAttempted:true,siteCondition:'site_maintenance',reason:'站点维护，之前提交结果不明'}]});
  assert.equal(report.externalPendingCount,0);assert.equal(report.verificationPendingCount,1);
  assert.match(report.summary,/待核验 1（不重复提交）/);
  assert.doesNotMatch(report.summary,/待重试|❌/);
});

test("动作结果未知转为关注，只有可恢复异常进入自动重试", async () => {
  const statuses = ["visited", "clicked", "no_action", "unconfirmed", "error", "managed_challenge_timeout"];
  const report = await previewReport({
    runId: "20260723-120005",
    runState: "final",
    plannedTotal: statuses.length,
    processedTotal: statuses.length,
    isComplete: true,
    results: statuses.map((status, index) => ({
      origin: `https://retry-${index}.example.test`,
      status,
      reason: "尚未取得权威签到终态",
    })),
  });

  assert.equal(report.status, "needs_attention");
  assert.match(report.summary, /待重试 3/);
  assert.match(report.summary, /需处理 3/);
});

test("真正需要登录或交互验证时仍明确要求人工处理", async () => {
  for (const status of ["login_required", "interactive_challenge", "needs_attention"]) {
    const report = await previewReport({
      runId: `20260723-attention-${status}`,
      runState: "final",
      plannedTotal: 1,
      processedTotal: 1,
      isComplete: true,
      results: [{ origin: `https://${status}.example.test`, status }],
    });

    assert.equal(report.status, "needs_attention");
    assert.match(report.summary, /需处理 1/);
  }
});

test("无证据的未开放签到不能伪装成业务完成", async () => {
  const report = await previewReport({
    runId: "20260903-invalid-not-available",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{ origin: "https://invalid.example.test", status: "not_available" }],
  });
  assert.equal(report.businessComplete, false);
  assert.equal(report.problemCount, 1);
  assert.equal(report.status, "retrying");
  assert.match(report.summary, /待重试 1/);
});

test("带账号身份的无效未开放结果显示重试而不是跳过", async () => {
  const report = await previewReport({
    runId: "20260903-invalid-account-not-available",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://invalid-account.example.test",
      accountKey: "primary",
      accountLabel: "Primary",
      status: "not_available",
    }],
  });
  assert.equal(report.status, "retrying");
  assert.match(report.summary, /待重试 1\n• invalid-account\.example\.test（Primary）/);
  assert.equal((report.summary.match(/Primary/g) ?? []).length, 1);
});

test("二次验证报告明确提示可信设备初始化", async () => {
  const report = await previewReport({
    runId: "20260903-two-factor",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://two-factor.example.test",
      status: "needs_attention",
      failureCode: "two_factor_required",
      reason: "2FA",
    }],
  });
  assert.equal(report.status, "needs_attention");
  assert.match(report.summary, /建立可信设备会话/);
  assert.doesNotMatch(report.summary, /待重试/);
});

test("当天已停止重试的维护站点不计入未开放签到", async () => {
  const report = await previewReport({
    runId: "20260723-120004-settled",
    runState: "final",
    plannedTotal: 1,
    processedTotal: 1,
    isComplete: true,
    results: [{
      origin: "https://maintenance.example.test",
      status: "not_available",
      temporarilyUnavailable: true,
      availabilityKind: "temporary_unavailable",
      evidence: { source: "operator_confirmation", authoritative: true, confirmedAt: "2026-07-23T00:00:00Z" },
      reason: "站点维护或网络不可用，今日停止重试，明日自动恢复",
    }],
  });

  assert.equal(report.status, "skipped");
  assert.match(report.summary, /暂不可用 1（今日暂停）/);
  assert.doesNotMatch(report.summary, /未开放|待重试/);
});

test("伪造相同数量的重复 signed 结果不能冒充完整报告", async () => {
  const targets = Array.from({ length: 52 }, (_, index) => ({ origin: `https://site-${index}.example` }));
  const report = await previewReport({
    runId: "20260723-duplicate-results",
    runState: "final",
    plannedTotal: targets.length,
    processedTotal: targets.length,
    isComplete: true,
    bookmarkSummary: { targets },
    results: targets.map(() => ({ origin: targets[0].origin, status: "signed" })),
  });

  assert.equal(report.status, "unconfirmed");
  assert.equal(report.isComplete, false);
  assert.match(report.summary, /任务未完成/);
});

test('摘要只列异常账号一次，成功账号不会挤掉待处理结果', async () => {
  const successes = Array.from({length: 24}, (_, i) => ({origin: 'https://multi.example', accountKey: `ok-${i}`, accountLabel: `ok-${i}`, status: 'signed'}));
  const report = await previewReport({runId: '20261001-compact', runState: 'final', plannedTotal: 26, processedTotal: 26, isComplete: true,
    results: [...successes,
      {origin: 'https://multi.example', accountKey: 'problem', accountLabel: 'Primary', status: 'needs_attention', reason: '请登录'},
      {origin: 'https://multi.example', accountKey: 'review', accountLabel: 'Secondary', status: 'needs_attention', submissionAttempted: true},
    ]});
  assert.equal(report.siteCount, 26);
  assert.equal(report.problemCount, 2);
  assert.match(report.summary, /^已签到 24\/26 · 待处理 2/);
  assert.equal((report.summary.match(/Primary/g) ?? []).length, 1);
  assert.equal((report.summary.match(/Secondary/g) ?? []).length, 1);
  assert.doesNotMatch(report.summary, /账号结果|ok-\d|更多明细/);
  assert.ok(report.summary.length < 240);
});

test('重试暂停会更新通知事件键，过期时间不再写成未来计划', async () => {
  const base = {runId: '20261001-retry', runState: 'final', plannedTotal: 1, processedTotal: 1, isComplete: true};
  const result = {origin: 'https://retry.example', status: 'deferred', retryCause: 'login_required', nextEligibleAt: '2000-01-01T00:00:00Z'};
  const retry = await previewReport({...base, results: [result]});
  const stopped = await previewReport({...base, results: [{...result, retryExhaustedForDay: true}]});
  assert.match(retry.summary, /已到期，等待调度/);
  assert.doesNotMatch(retry.summary, /计划|00:00/);
  assert.match(stopped.summary, /今日停止，次日复核/);
  assert.notEqual(retry.eventKey, stopped.eventKey);
  const harvest = await previewReport({...base, results: [{...result, retryCause: 'harvest_waiting', submissionAttempted: false}]});
  assert.match(harvest.summary, /待本项目续跑，先复核 Harvest/);
  assert.doesNotMatch(harvest.summary, /等待 Harvest 完成/);
});

test('重试时间固定使用上海时间，跨日包含日期', async () => {
  const report = await previewReport({runId: '20261001-timezone', runState: 'final', plannedTotal: 1, processedTotal: 1, isComplete: true,
    results: [{origin: 'https://time.example', status: 'deferred', retryCause: 'login_required', nextEligibleAt: '2099-01-01T16:15:00Z'}]});
  assert.match(report.summary, /01-02 00:15 后复核/);
});

test('精简保留权益过期原因，但历史提交仍列为待核验', async () => {
  const report = await previewReport({runId: '20261001-entitlement', runState: 'final', plannedTotal: 1, processedTotal: 1, isComplete: true,
    results: [{origin: 'https://entitlement.example', status: 'needs_attention', submissionAttempted: true, failureCode: 'submission_outcome_unknown',
      evidence: {source: 'vibe_entitlement_status', authoritative: false, statusSignal: 'expired_subscription'}}]});
  assert.equal(report.verificationPendingCount, 1);
  assert.equal(report.externalPendingCount, 0);
  assert.equal(report.businessComplete, false);
  assert.match(report.summary, /权益已过期，历史提交待核验/);
  assert.doesNotMatch(report.summary, /待重试/);
});

test('同原因同时间的重试只显示一次安排，人工处理排在长列表前', async () => {
  const retries = Array.from({length: 30}, (_, i) => ({origin: `https://retry-${i}.example`, status: 'deferred', retryCause: 'login_required', nextEligibleAt: '2099-01-01T16:15:00Z'}));
  const report = await previewReport({runId: '20261001-grouping', runState: 'final', plannedTotal: 32, processedTotal: 32, isComplete: true,
    results: [...retries,
      {origin: 'https://manual.example', status: 'needs_attention', reason: '请登录'},
      {origin: 'https://unknown.example', status: 'needs_attention', submissionAttempted: true},
    ]});
  assert.equal((report.summary.match(/登录待恢复/g) ?? []).length, 1);
  assert.equal((report.summary.match(/01-02 00:15/g) ?? []).length, 1);
  assert.ok(report.summary.indexOf('manual.example') < report.summary.indexOf('retry-0.example'));
  assert.ok(report.summary.indexOf('unknown.example') < report.summary.indexOf('retry-0.example'));
  assert.ok(report.summary.length <= 950);
  assert.match(report.summary, /待处理 32/);
  assert.doesNotMatch(report.summary, /账号结果/);
});
