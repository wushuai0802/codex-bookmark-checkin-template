import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteJson, ensurePrivateDirectory } from "./security.mjs";

function localRunId(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  const suffix = randomBytes(3).toString("hex");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${milliseconds}-${suffix}`;
}

export async function createRunLog(rootDirectory) {
  const runId = localRunId();
  const directory = path.join(rootDirectory, runId);
  await ensurePrivateDirectory(directory);
  return { runId, directory };
}

export async function writeRunResult(rootDirectory, runLog, result, { updateLatest = true } = {}) {
  const runFile = path.join(runLog.directory, "result.json");
  const latestFile = path.join(rootDirectory, "latest.json");
  await atomicWriteJson(runFile, result);
  if (updateLatest) await atomicWriteJson(latestFile, result);
  return runFile;
}

export async function cleanupOldLogs(rootDirectory, retentionDays) {
  const resolvedRoot = path.resolve(rootDirectory);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(rootDirectory, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const fullPath = path.resolve(rootDirectory, entry.name);
    if (!fullPath.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (stat?.isSymbolicLink()) continue;
    if (stat && stat.mtimeMs < cutoff) await fs.rm(fullPath, { recursive: true, force: true });
  }
}
