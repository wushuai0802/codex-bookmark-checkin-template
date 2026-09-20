import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunLog, writeRunResult } from "../src/logger.mjs";

test("同一秒内连续运行也会使用不同日志目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-logger-id-"));
  try {
    const [first, second] = await Promise.all([createRunLog(root), createRunLog(root)]);
    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.directory, second.directory);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("单站诊断结果不会覆盖完整 latest 报告", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-logger-"));
  try {
    const latest = { runId: "full", results: Array.from({ length: 40 }, (_, index) => ({ index })) };
    await fs.writeFile(path.join(root, "latest.json"), JSON.stringify(latest));
    const runDirectory = path.join(root, "single");
    await fs.mkdir(runDirectory);

    await writeRunResult(root, { directory: runDirectory }, { runId: "single", results: [{}] }, { updateLatest: false });

    assert.equal(JSON.parse(await fs.readFile(path.join(root, "latest.json"), "utf8")).runId, "full");
    assert.equal(JSON.parse(await fs.readFile(path.join(runDirectory, "result.json"), "utf8")).runId, "single");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
