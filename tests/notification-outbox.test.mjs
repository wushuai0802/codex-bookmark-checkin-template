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
const tmpRoot = path.join(root, "tmp");
const reporter = path.join(root, "scripts", "Submit-UnifiedCheckinReport.ps1");
const worker = path.join(root, "scripts", "Invoke-CheckinNotificationOutbox.ps1");

async function runPowerShell(script, args = []) {
  const { stdout } = await execFileAsync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args,
  ], { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

function completeReport(result) {
  return {
    runId: "20260723-230000", runState: "final", plannedTotal: 1,
    processedTotal: 1, isComplete: true, results: [result],
  };
}

async function writeConfig(filePath, notification) {
  await fs.writeFile(filePath, JSON.stringify({ notification }), "utf8");
}

async function enqueue(outboxPath, configPath, report) {
  await fs.mkdir(logsRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(logsRoot, "public-outbox-report-"));
  const reportPath = path.join(directory, "report.json");
  try {
    await fs.writeFile(reportPath, JSON.stringify(report), "utf8");
    return JSON.parse(await runPowerShell(reporter, [
      "-ReportPath", reportPath, "-OutboxPath", outboxPath, "-ConfigPath", configPath,
    ]));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readItem(outboxPath) {
  const files = (await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  return JSON.parse(await fs.readFile(path.join(outboxPath, files[0]), "utf8"));
}

async function readItems(outboxPath) {
  const files = (await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json"));
  return Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(outboxPath, name), "utf8"))));
}

async function readQuarantineItems(outboxPath) {
  const quarantinePath = path.join(outboxPath, "quarantine");
  const files = await fs.readdir(quarantinePath).catch(() => []);
  return files.filter((name) => name.endsWith(".invalid.json"));
}

async function writeFakeCommand(filePath, acknowledgement, exitCode = 0) {
  const body = `console.log(${JSON.stringify(JSON.stringify(acknowledgement))}); process.exit(${exitCode});\n`;
  await fs.writeFile(filePath, body, "utf8");
}

async function writeHangingCommand(filePath) {
  const body = "setInterval(() => {}, 1000);\n";
  await fs.writeFile(filePath, body, "utf8");
}

async function writeArgumentCheckingCommand(filePath, expectedSummary) {
  const body = `
const args = process.argv.slice(2);
const summaryIndex = args.indexOf("--summary");
if (summaryIndex < 0 || args[summaryIndex + 1] !== ${JSON.stringify(expectedSummary)}) process.exit(11);
console.log(JSON.stringify({accepted:true,duplicate:false}));
`;
  await fs.writeFile(filePath, body, "utf8");
}

function commandNotification(executable, prefixArguments = []) {
  return {
    mode: "command", executable,
    arguments: [...prefixArguments, "--task-id", "{taskId}", "--name", "{name}", "--source", "{source}", "--status", "{status}", "--event-key", "{eventKey}", "--summary", "{summary}"],
    taskId: "public_test", name: "公开模板测试", source: "test-suite",
  };
}

test("none 和 Preview 模式不创建通知 outbox", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-none-"));
  const configPath = path.join(sandbox, "config.json");
  const outboxPath = path.join(sandbox, "outbox");
  const reportDirectory = await fs.mkdtemp(path.join(logsRoot, "public-outbox-preview-"));
  const reportPath = path.join(reportDirectory, "report.json");
  try {
    await writeConfig(configPath, { mode: "none", executable: "", arguments: [] });
    await fs.writeFile(reportPath, JSON.stringify(completeReport({ origin: "https://none.test", status: "signed" })), "utf8");
    await runPowerShell(reporter, ["-ReportPath", reportPath, "-OutboxPath", outboxPath, "-ConfigPath", configPath]);
    assert.equal(await fs.stat(outboxPath).then(() => true).catch(() => false), false);

    await writeConfig(configPath, commandNotification("missing-command"));
    await runPowerShell(reporter, ["-ReportPath", reportPath, "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-Preview"]);
    assert.equal(await fs.stat(outboxPath).then(() => true).catch(() => false), false);
  } finally {
    await fs.rm(reportDirectory, { recursive: true, force: true });
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("command 报告先以最小脱敏 payload 原子写入 outbox", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-persist-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  try {
    await writeConfig(configPath, commandNotification("not-invoked-during-enqueue"));
    await enqueue(outboxPath, configPath, completeReport({
      origin: "https://attention.test", status: "needs_attention",
      reason: "password=NeverPersist token=SecretToken 密码：ChineseSecret",
    }));
    const item = await readItem(outboxPath);
    assert.equal(item.schemaVersion, 1);
    assert.equal(item.taskId, "public_test");
    assert.equal(item.source, "test-suite");
    assert.match(item.payloadHash, /^[a-f0-9]{64}$/);
    assert.equal(item.delivered, false);
    assert.equal(item.attempts, 0);
    assert.match(item.summary, /\[REDACTED\]/);
    assert.doesNotMatch(JSON.stringify(item), /NeverPersist|SecretToken|ChineseSecret/);
    assert.equal((await fs.readdir(outboxPath)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

for (const disposition of ["accepted", "duplicate"]) {
  test(`${disposition}=true 会将 outbox 标记为已送达`, async () => {
    await fs.mkdir(tmpRoot, { recursive: true });
    const sandbox = await fs.mkdtemp(path.join(tmpRoot, `public-outbox-${disposition}-`));
    const outboxPath = path.join(sandbox, "outbox");
    const configPath = path.join(sandbox, "config.json");
    const commandPath = path.join(sandbox, "receiver.mjs");
    try {
      await writeFakeCommand(commandPath, { accepted: disposition === "accepted", duplicate: disposition === "duplicate" });
      await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
      await enqueue(outboxPath, configPath, completeReport({ origin: "https://ok.test", status: "signed" }));
      const result = JSON.parse(await runPowerShell(worker, [
        "-OutboxPath", outboxPath, "-ConfigPath", configPath,
        "-MutexName", `Local\\PublicOutbox${process.pid}${disposition}`,
      ]));
      assert.equal(result.delivered, 1);
      const item = await readItem(outboxPath);
      assert.equal(item.delivered, true);
      assert.equal(item.disposition, disposition);
      assert.equal(item.attempts, 1);
      assert.equal(item.nextAttemptAt, null);
      assert.ok(item.deliveredAt);
    } finally {
      await fs.rm(sandbox, { recursive: true, force: true });
    }
  });
}

test("多行中文摘要作为一个参数传给通知程序", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-argument-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "argument-receiver.mjs");
  try {
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({
      origin: "https://argument.example",
      status: "needs_attention",
      reason: "第一行有空格\n第二行是中文",
    }));
    const item = await readItem(outboxPath);
    await writeArgumentCheckingCommand(commandPath, item.summary);
    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxArgument${process.pid}`,
    ]));
    assert.equal(output.delivered, 1);
    assert.equal((await readItem(outboxPath)).delivered, true);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("同一天只投递最新回执并淘汰旧状态", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-supersede-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({
      origin: "https://supersede.example", status: "needs_attention", reason: "旧异常",
    }));
    await enqueue(outboxPath, configPath, completeReport({
      origin: "https://supersede.example", status: "signed", reason: "最终成功",
    }));
    const initialItems = await readItems(outboxPath);
    assert.equal(initialItems.length, 2);
    const files = (await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(outboxPath, file);
      const item = JSON.parse(await fs.readFile(filePath, "utf8"));
      item.createdAt = item.status === "success" ? "2026-07-23T13:00:00+08:00" : "2026-07-23T12:00:00+08:00";
      item.nextAttemptAt = "2099-01-01T00:00:00Z";
      await fs.writeFile(filePath, JSON.stringify(item), "utf8");
    }
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-MutexName", `Local\\PublicOutboxSupersede${process.pid}`,
    ]));
    assert.equal(output.processed, 1);
    assert.equal(output.delivered, 1);
    assert.equal(output.superseded, 1);
    const items = await readItems(outboxPath);
    assert.equal(items.find((item) => item.status === "success").disposition, "accepted");
    assert.equal(items.find((item) => item.status === "needs_attention").disposition, "superseded");
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("payloadHash 不匹配的 outbox 条目会被隔离且不会发送", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-integrity-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({ origin: "https://integrity.test", status: "signed" }));
    const [itemFile] = await fs.readdir(outboxPath);
    const itemPath = path.join(outboxPath, itemFile);
    const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
    item.summary += " altered";
    await fs.writeFile(itemPath, JSON.stringify(item), "utf8");

    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-MutexName", `Local\\PublicOutboxIntegrity${process.pid}`,
    ]));
    assert.equal(output.processed, 0);
    assert.equal(output.delivered, 0);
    assert.equal(output.invalid, 1);
    assert.equal((await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json")).length, 0);
    assert.equal((await readQuarantineItems(outboxPath)).length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("缺失 payloadHash 的 outbox 条目会被隔离", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-missing-hash-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({ origin: "https://missing-hash.test", status: "signed" }));
    const [itemFile] = await fs.readdir(outboxPath);
    const itemPath = path.join(outboxPath, itemFile);
    const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
    delete item.payloadHash;
    await fs.writeFile(itemPath, JSON.stringify(item), "utf8");
    const output = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-MutexName", `Local\\PublicOutboxMissingHash${process.pid}`,
    ]));
    assert.equal(output.invalid, 1);
    assert.equal((await readQuarantineItems(outboxPath)).length, 1);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("通知命令超时会记录 timeout 并进入退避，不会卡住 worker", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-timeout-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "hanging.mjs");
  try {
    await writeHangingCommand(commandPath);
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({ origin: "https://timeout.test", status: "signed" }));
    const [itemFile] = await fs.readdir(outboxPath);
    const itemPath = path.join(outboxPath, itemFile);
    const item = JSON.parse(await fs.readFile(itemPath, "utf8"));
    item.nextAttemptAt = "2026-07-23T12:00:00.000Z";
    await fs.writeFile(itemPath, JSON.stringify(item), "utf8");

    const started = Date.now();
    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-NowUtc", "2026-07-23T12:00:00Z", "-TimeoutSeconds", "1",
      "-MutexName", `Local\\PublicOutboxTimeout${process.pid}`,
    ]));
    assert.ok(Date.now() - started < 10000);
    assert.equal(result.deferred, 1);
    const deferred = await readItem(outboxPath);
    assert.equal(deferred.lastError, "timeout");
    assert.equal(deferred.attempts, 1);
    assert.equal(deferred.delivered, false);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("命令失败只延后通知并按 nextAttemptAt 重试", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-retry-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  const mutex = `Local\\PublicOutboxRetry${process.pid}`;
  try {
    await writeFakeCommand(commandPath, {}, 9);
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({ origin: "https://retry.test", status: "signed" }));
    const initial = await readItem(outboxPath);
    const fileName = (await fs.readdir(outboxPath))[0];
    initial.nextAttemptAt = "2026-07-23T12:00:00.000Z";
    await fs.writeFile(path.join(outboxPath, fileName), JSON.stringify(initial), "utf8");

    const failed = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:00:00Z",
      "-BaseRetryMinutes", "2", "-MutexName", mutex,
    ]));
    assert.equal(failed.deferred, 1);
    let item = await readItem(outboxPath);
    assert.equal(item.attempts, 1);
    assert.equal(item.lastError, "exit_code_9");

    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    const early = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:01:00Z", "-MutexName", mutex,
    ]));
    assert.equal(early.processed, 0);
    const retried = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-NowUtc", "2026-07-23T12:02:00Z", "-MutexName", mutex,
    ]));
    assert.equal(retried.delivered, 1);
    item = await readItem(outboxPath);
    assert.equal(item.delivered, true);
    assert.equal(item.attempts, 2);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("已送达通知超过保留期后自动清理", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tmpRoot, "public-outbox-retention-"));
  const outboxPath = path.join(sandbox, "outbox");
  const configPath = path.join(sandbox, "config.json");
  const commandPath = path.join(sandbox, "receiver.mjs");
  const mutex = `Local\\PublicOutboxRetention${process.pid}`;
  try {
    await writeFakeCommand(commandPath, { accepted: true, duplicate: false });
    await writeConfig(configPath, commandNotification(process.execPath, [commandPath]));
    await enqueue(outboxPath, configPath, completeReport({ origin: "https://retention.test", status: "signed" }));
    await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath, "-ForceDue",
      "-NowUtc", "2026-07-01T00:00:00Z", "-MutexName", mutex,
    ]);
    const item = await readItem(outboxPath);
    assert.equal(item.delivered, true);

    const result = JSON.parse(await runPowerShell(worker, [
      "-OutboxPath", outboxPath, "-ConfigPath", configPath,
      "-NowUtc", "2026-08-01T00:00:00Z", "-RetentionDays", "30", "-MutexName", mutex,
    ]));
    assert.equal(result.pruned, 1);
    assert.equal((await fs.readdir(outboxPath)).filter((name) => name.endsWith(".json")).length, 0);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
