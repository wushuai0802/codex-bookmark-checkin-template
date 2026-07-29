import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runner = path.join(root, "scripts", "Run-Checkin.ps1");
const mutexName = "Local\\CodexBookmarkCheckinRun";

test("第二个 wrapper 在命名互斥被占用时快速退出且不启动签到", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "wrapper-mutex-test-"));
  const configPath = path.join(sandbox, "config.json");
  await fs.writeFile(configPath, `${JSON.stringify({ runMutexName: mutexName })}\n`, "utf8");
  const holderCommand = [
    `$mutex=[System.Threading.Mutex]::new($false,'${mutexName}')`,
    "$owned=$mutex.WaitOne()",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "try { Start-Sleep -Seconds 20 } finally { if($owned){$mutex.ReleaseMutex()};$mutex.Dispose() }",
  ].join("; ");
  const holder = spawn("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", holderCommand], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    let startupTimer;
    const startupTimeout = new Promise((_, reject) => {
      startupTimer = setTimeout(() => reject(new Error("mutex holder startup timeout")), 5000);
    });
    const [ready] = await Promise.race([once(holder.stdout, "data"), startupTimeout])
      .finally(() => clearTimeout(startupTimer));
    assert.match(String(ready), /READY/);
    const started = Date.now();
    const { stdout } = await execFileAsync("pwsh.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", runner, "-DryRun", "-SuppressReport", "-ConfigPath", configPath,
    ], { cwd: root, encoding: "utf8", windowsHide: true });
    assert.ok(Date.now() - started < 5000);
    assert.equal(stdout.trim(), "");
  } finally {
    holder.kill();
    await once(holder, "exit").catch(() => {});
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
