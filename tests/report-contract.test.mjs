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
  assert.match(report.summary, /已处理 2\/5 个签到项（任务未完成）/);
  assert.match(report.summary, /\n2 个签到正常/);
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
  assert.match(report.summary, /已处理 1\/5 个签到项（任务未完成）/);
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
  assert.match(report.summary, /^共 2 个签到项：\n/);
});

test("同一逻辑站点的两个取消任务只统计一次", async () => {
  const report = await previewReport({
    runId: "20260723-120002-logical-group",
    runState: "final",
    plannedTotal: 2,
    processedTotal: 2,
    isComplete: true,
    results: [
      { origin: "https://checkin.example", status: "not_available", disabledByConfig: true },
      { origin: "https://console.example", status: "not_available", disabledByConfig: true },
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
  assert.match(report.summary, /^共 1 个签到项：\n/);
  assert.match(report.summary, /\n1 个已取消签到/);
  assert.doesNotMatch(report.summary, /2 个未开放签到/);
});

test("同一站点的三个账号分别统计并显示签到结果", async () => {
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
  assert.match(report.summary, /^共 3 个签到项：/);
  for (const accountId of accountIds) assert.match(report.summary, new RegExp(accountId));
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
  assert.match(report.summary, /待自动重试 2 个：/);
  assert.doesNotMatch(report.summary, /需关注/);
  assert.match(report.summary, /login\.example\.test：登录恢复未成功，计划/);
  assert.match(report.summary, /challenge\.example\.test：验证未自动通过，计划/);
});

test("站点故障在通知中显示为自动重试而不是人工关注", async () => {
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

  assert.equal(report.status, "retrying");
  assert.match(report.summary, /待自动重试 1 个：/);
  assert.match(report.summary, /offline\.example\.test：站点暂时不可用，计划/);
  assert.doesNotMatch(report.summary, /需关注/);
});

test("完整报告中的弱结果和可恢复异常统一显示为自动重试", async () => {
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

  assert.equal(report.status, "retrying");
  assert.match(report.summary, /待自动重试 6 个：/);
  assert.doesNotMatch(report.summary, /需关注/);
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
    assert.match(report.summary, /需关注 1 个：/);
  }
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
      reason: "站点维护或网络不可用，今日停止重试，明日自动恢复",
    }],
  });

  assert.equal(report.status, "skipped");
  assert.match(report.summary, /1 个站点暂不可用（今日不再重试）/);
  assert.match(report.summary, /0 个未开放签到/);
  assert.doesNotMatch(report.summary, /待自动重试/);
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
