import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const START_TIME_TOLERANCE_MS = 5000;
const INCOMPLETE_LOCK_GRACE_MS = 5000;
const GUARD_STALE_MS = 10000;

function validPid(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function timestamp(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function classifyLockOwner(owner, processIdentity) {
  if (!owner || !validPid(owner.pid)) return "invalid";
  if (!processIdentity?.alive) return "stale";

  const recordedStart = timestamp(owner.processStartedAt);
  const actualStart = timestamp(processIdentity.startedAt);
  if (recordedStart !== null && actualStart !== null
    && Math.abs(recordedStart - actualStart) > START_TIME_TOLERANCE_MS) {
    return "stale";
  }
  return "active";
}

export function sameLockOwner(left, right) {
  return validPid(left?.pid)
    && Number(left.pid) === Number(right?.pid)
    && typeof left?.nonce === "string"
    && left.nonce.length > 0
    && left.nonce === right?.nonce;
}

async function inspectWindowsProcess(pid) {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const command = "$p=Get-Process -Id ([int]$env:CHECKIN_LOCK_PID) -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.StartTime.ToUniversalTime().ToString('o') }";
  try {
    const { stdout } = await execFileAsync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      env: { ...process.env, CHECKIN_LOCK_PID: String(pid) },
    });
    const startedAt = String(stdout).trim();
    return startedAt ? { alive: true, startedAt } : { alive: false, startedAt: null };
  } catch {
    return null;
  }
}

export async function inspectProcessIdentity(pid) {
  if (!validPid(pid)) return { alive: false, startedAt: null };
  try {
    process.kill(Number(pid), 0);
  } catch (error) {
    if (error?.code === "ESRCH") return { alive: false, startedAt: null };
    if (error?.code !== "EPERM") return { alive: false, startedAt: null };
  }

  if (process.platform === "win32") {
    const identity = await inspectWindowsProcess(pid);
    if (identity) return identity;
  }
  return { alive: true, startedAt: null };
}

async function readLock(lockPath) {
  const [raw, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  let owner = null;
  try { owner = JSON.parse(raw); } catch { /* interrupted or legacy write */ }
  return { owner, stat };
}

async function writeOwnedLock(lockPath, owner) {
  const handle = await fs.open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withLockGuard(lockPath, action, now) {
  const guardPath = `${lockPath}.guard`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.mkdir(guardPath);
      try {
        return await action();
      } finally {
        await fs.rm(guardPath, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(guardPath).catch(() => null);
      if (!stat) continue;
      if (now() - stat.mtimeMs > GUARD_STALE_MS) {
        await fs.rm(guardPath, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("签到任务锁协调超时");
}

export async function acquireRunLock(lockPath, options = {}) {
  const inspectProcess = options.inspectProcess ?? inspectProcessIdentity;
  const now = options.now ?? (() => Date.now());
  const pid = Number(options.pid ?? process.pid);
  const ownIdentity = await inspectProcess(pid);
  const owner = {
    version: 1,
    pid,
    processStartedAt: ownIdentity?.startedAt ?? new Date(now() - Math.round(process.uptime() * 1000)).toISOString(),
    acquiredAt: new Date(now()).toISOString(),
    nonce: options.nonce ?? crypto.randomUUID(),
  };

  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  return withLockGuard(lockPath, async () => {
    try {
      await writeOwnedLock(lockPath, owner);
      return { lockPath, owner };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let current;
    try {
      current = await readLock(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        await writeOwnedLock(lockPath, owner);
        return { lockPath, owner };
      }
      throw error;
    }

    if (!current.owner) {
      if (now() - current.stat.mtimeMs <= INCOMPLETE_LOCK_GRACE_MS) {
        throw new Error("已有一个签到任务正在启动");
      }
    } else {
      const identity = await inspectProcess(Number(current.owner.pid));
      if (classifyLockOwner(current.owner, identity) === "active") {
        throw new Error("已有一个签到任务正在运行");
      }
    }

    await fs.rm(lockPath, { force: true });
    await writeOwnedLock(lockPath, owner);
    return { lockPath, owner };
  }, now);
}

export async function releaseRunLock(lease) {
  if (!lease?.lockPath || !lease?.owner) return false;
  return withLockGuard(lease.lockPath, async () => {
    const current = await fs.readFile(lease.lockPath, "utf8").then((text) => JSON.parse(text)).catch(() => null);
    if (!sameLockOwner(lease.owner, current)) return false;
    await fs.rm(lease.lockPath, { force: true });
    return true;
  }, () => Date.now());
}
