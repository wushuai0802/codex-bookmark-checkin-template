import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acquireRunLock, classifyLockOwner, releaseRunLock } from "../src/run-lock.mjs";

const execFileAsync = promisify(execFile);
const startedAt = "2026-07-23T08:00:00.000Z";

test("锁所有者分类能区分活进程、死亡进程和 PID 复用", () => {
  const owner = { pid: 123, nonce: "owner", processStartedAt: startedAt };
  assert.equal(classifyLockOwner(owner, { alive: true, startedAt }), "active");
  assert.equal(classifyLockOwner(owner, { alive: false, startedAt: null }), "stale");
  assert.equal(classifyLockOwner(owner, { alive: true, startedAt: "2026-07-23T09:00:00.000Z" }), "stale");
  assert.equal(classifyLockOwner({ pid: 0 }, { alive: true, startedAt }), "invalid");
});

test("旧版锁仍按 PID 活性判断，避免升级时并发运行", () => {
  const legacyOwner = { pid: 123, startedAt };
  assert.equal(classifyLockOwner(legacyOwner, { alive: true, startedAt }), "active");
  assert.equal(classifyLockOwner(legacyOwner, { alive: false, startedAt: null }), "stale");
});

test("死亡进程锁立即回收，活进程锁拒绝并发且 nonce 防止误删", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "public-checkin-lock-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "run.lock");
  const identities = new Map([
    [101, { alive: true, startedAt }],
    [202, { alive: true, startedAt: "2026-07-23T08:01:00.000Z" }],
  ]);
  const inspectProcess = async (pid) => identities.get(pid) ?? { alive: false, startedAt: null };

  const first = await acquireRunLock(lockPath, { pid: 101, nonce: "first", inspectProcess, now: () => Date.parse(startedAt) });
  await assert.rejects(
    acquireRunLock(lockPath, { pid: 202, nonce: "second", inspectProcess, now: () => Date.parse(startedAt) }),
    /已有一个签到任务正在运行/,
  );

  identities.set(101, { alive: false, startedAt: null });
  const second = await acquireRunLock(lockPath, { pid: 202, nonce: "second", inspectProcess, now: () => Date.parse(startedAt) + 60000 });
  assert.equal(JSON.parse(await fs.readFile(lockPath, "utf8")).nonce, "second");
  assert.equal(await releaseRunLock(first), false);
  assert.equal(await releaseRunLock(second), true);
  await assert.rejects(fs.access(lockPath));
});

test("PowerShell 超时清理仅删除匹配 PID 与启动时间的锁", { skip: process.platform !== "win32" }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "public-checkin-lock-ps-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const lockPath = path.join(directory, "run.lock");
  const helperPath = path.resolve("scripts", "RunLock.ps1");
  await fs.writeFile(lockPath, JSON.stringify({ pid: 4242, nonce: "owned", processStartedAt: startedAt }), "utf8");

  const invoke = async (pid, processStart) => execFileAsync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    `. '${helperPath.replaceAll("'", "''")}'; Remove-RunLockOwnedByProcess -LockPath '${lockPath.replaceAll("'", "''")}' -ProcessId ${pid} -ProcessStartedAt ([datetime]'${processStart}')`,
  ], { encoding: "utf8" });

  await invoke(9999, startedAt);
  await fs.access(lockPath);
  await invoke(4242, "2026-07-23T09:00:00.000Z");
  await fs.access(lockPath);
  await invoke(4242, startedAt);
  await assert.rejects(fs.access(lockPath));
});
