import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backupScript = path.join(root, "scripts", "Backup-CheckinProfiles.ps1");

async function runBackup(args) {
  const { stdout } = await execFileAsync("pwsh.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", backupScript, ...args,
  ], { cwd: root, encoding: "utf8" });
  return JSON.parse(stdout);
}

async function createRuntimeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-profile-backup-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  const runtimeRoot = path.join(base, "runtime");
  const backupRoot = path.join(base, "backups");
  const dataRoot = path.join(runtimeRoot, "data");
  const configDir = path.join(runtimeRoot, "config");
  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "tmp"), { recursive: true });

  const profiles = [
    path.join(dataRoot, "chrome-user-data"),
    path.join(dataRoot, "sites", "alpha", "chrome-user-data"),
    path.join(dataRoot, "accounts", "acct-a", "chrome-user-data"),
    path.join(dataRoot, "sessions", "shared-a", "chrome-user-data"),
  ];
  for (const profileDir of profiles) {
    await fs.mkdir(path.join(profileDir, "Default", "Network"), { recursive: true });
    await fs.mkdir(path.join(profileDir, "Default", "Cache"), { recursive: true });
    await fs.mkdir(path.join(profileDir, "Default", "Code Cache"), { recursive: true });
    await fs.mkdir(path.join(profileDir, "Default", "Service Worker", "CacheStorage"), { recursive: true });
    await fs.mkdir(path.join(profileDir, "GPUCache"), { recursive: true });
    await fs.writeFile(path.join(profileDir, "Local State"), JSON.stringify({ os_crypt: { ok: true } }), "utf8");
    await fs.writeFile(path.join(profileDir, "Default", "Preferences"), JSON.stringify({ profile: { name: "Synthetic" } }), "utf8");
    await fs.writeFile(path.join(profileDir, "Default", "Network", "Cookies"), "synthetic-state-bytes", "utf8");
    await fs.writeFile(path.join(profileDir, "Default", "Cache", "transient.bin"), Buffer.alloc(256, 1));
    await fs.writeFile(path.join(profileDir, "Default", "Code Cache", "transient.js"), "cache");
    await fs.writeFile(path.join(profileDir, "Default", "Service Worker", "CacheStorage", "blob.bin"), "sw-cache");
    await fs.writeFile(path.join(profileDir, "GPUCache", "gpu.bin"), Buffer.alloc(128, 2));
  }

  const configPath = path.join(configDir, "config.json");
  await fs.writeFile(configPath, JSON.stringify({ automationUserDataDir: profiles[0] }), "utf8");
  return { base, runtimeRoot, backupRoot, configPath, profiles };
}

test("自动发现全部 Profile、排除易失缓存、生成 SHA-256 清单并通过离线校验", async (t) => {
  const f = await createRuntimeFixture(t);

  const preview = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-DryRun",
  ]);
  assert.equal(preview.ok, true);
  assert.equal(preview.mode, "dry_run");
  assert.equal(preview.profileCount, 4);
  assert.equal(preview.totalFileCount, 12); // 4 profiles * (Local State + Preferences + Cookies)
  assert.equal(await fs.stat(f.backupRoot).then(() => true).catch(() => false), false);

  const result = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261128-090000",
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "backup");
  assert.equal(result.profileCount, 4);
  assert.equal(result.totalFileCount, 12);
  assert.ok(result.verifiedAt);
  assert.doesNotMatch(JSON.stringify(result), /acct-a|synthetic-state-bytes/);

  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, "chrome_profile_backup");
  assert.equal(manifest.profiles.length, 4);
  assert.ok(manifest.verifiedAt);

  const verified = await runBackup(["-VerifyArchive", result.manifestPath]);
  assert.equal(verified.ok, true);
  assert.equal(verified.mode, "verify");
  assert.equal(verified.verifiedProfiles, 4);
  assert.equal(verified.totalExtractedFiles, 12);

  // Tampering a zip must be detected by -VerifyArchive
  const firstZip = path.join(path.dirname(result.manifestPath), manifest.profiles[0].archiveFile);
  await fs.appendFile(firstZip, Buffer.from("tampered"));
  await assert.rejects(runBackup(["-VerifyArchive", result.manifestPath]), /SHA-256/);
});

test("存在活跃 run.lock 或人工会话时拒绝热备份且不破坏既有备份", async (t) => {
  const f = await createRuntimeFixture(t);
  const existing = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261127-090000",
  ]);
  assert.equal(existing.ok, true);

  const runLock = path.join(f.runtimeRoot, "tmp", "run.lock");
  await fs.writeFile(runLock, JSON.stringify({ pid: process.pid, nonce: "active" }), "utf8");
  await assert.rejects(runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261128-090000",
  ]), /run\.lock/);
  await fs.unlink(runLock);

  const manualSession = path.join(f.runtimeRoot, "tmp", "manual-session.json");
  await fs.writeFile(manualSession, JSON.stringify({ state: "awaiting_login" }), "utf8");
  await assert.rejects(runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261128-090000",
  ]), /人工会话/);
  await fs.unlink(manualSession);

  // Existing verified backup stays intact
  const verified = await runBackup(["-VerifyArchive", existing.manifestPath]);
  assert.equal(verified.ok, true);
});

test("拒绝备份到运行根、Git 仓库内部或包含联接点的 Profile", async (t) => {
  const f = await createRuntimeFixture(t);

  await assert.rejects(runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", path.join(f.runtimeRoot, "backups"),
  ]), /运行副本目录内/);

  const gitBackup = path.join(f.base, "repo", "backups");
  await fs.mkdir(path.join(f.base, "repo", ".git"), { recursive: true });
  await assert.rejects(runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", gitBackup,
  ]), /Git 仓库/);

  if (process.platform === "win32") {
    const outside = path.join(f.base, "outside-secret");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, "note.txt"), "outside", "utf8");
    const junction = path.join(f.profiles[0], "linked-outside");
    await fs.symlink(outside, junction, "junction");
    try {
      await assert.rejects(runBackup([
        "-RuntimeRoot", f.runtimeRoot,
        "-ConfigPath", f.configPath,
        "-BackupRoot", f.backupRoot,
      ]), /联接点|符号链接/);
    } finally {
      await fs.unlink(junction).catch(() => {});
    }
  }
});

test("保留策略仅在验证后生效：保留 3 份近期备份与 1 份跨月备份，且不误删无关目录", async (t) => {
  const f = await createRuntimeFixture(t);
  await fs.mkdir(path.join(f.backupRoot, "unrelated-archive"), { recursive: true });
  await fs.writeFile(path.join(f.backupRoot, "unrelated-archive", "keep.txt"), "keep", "utf8");

  const labels = [
    "20260930-090000",
    "20261015-090000",
    "20261031-090000",
    "20261125-090000",
    "20261126-090000",
    "20261127-090000",
  ];
  for (const label of labels) {
    await runBackup([
      "-RuntimeRoot", f.runtimeRoot,
      "-ConfigPath", f.configPath,
      "-BackupRoot", f.backupRoot,
      "-TimestampLabel", label,
      "-SkipRetention",
    ]);
  }

  const finalResult = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261128-090000",
    "-KeepDaily", "3",
    "-KeepMonthly", "1",
  ]);
  assert.equal(finalResult.retainedCount, 4);
  assert.equal(finalResult.prunedCount, 3);

  const remaining = (await fs.readdir(f.backupRoot)).sort();
  assert.deepEqual(remaining, [
    "profiles-20261031-090000",
    "profiles-20261126-090000",
    "profiles-20261127-090000",
    "profiles-20261128-090000",
    "unrelated-archive",
  ]);
  // Verify backup released its temporary run.lock cleanly
  assert.equal(await fs.stat(path.join(f.runtimeRoot, "tmp", "run.lock")).then(() => true).catch(() => false), false);
});

test("离线校验拒绝越界 id 与未校验目录不占用保留名额", async (t) => {
  const f = await createRuntimeFixture(t);
  const first = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261127-090000",
    "-SkipRetention",
  ]);
  assert.equal(first.ok, true);

  // Inject an unverified profiles-* directory; retention must ignore it so valid backups are never evicted
  const unverifiedDir = path.join(f.backupRoot, "profiles-20261128-080000");
  await fs.mkdir(unverifiedDir, { recursive: true });
  await fs.writeFile(path.join(unverifiedDir, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "chrome_profile_backup",
    createdAt: "2026-11-28T00:00:00Z",
    verifiedAt: null,
    profileCount: 1,
    profiles: [{ id: "../escape", archiveFile: "bad.zip", fileCount: 1, sha256: "a".repeat(64) }],
  }), "utf8");

  await assert.rejects(runBackup(["-VerifyArchive", path.join(unverifiedDir, "manifest.json")]), /Profile ID 非法/);

  const second = await runBackup([
    "-RuntimeRoot", f.runtimeRoot,
    "-ConfigPath", f.configPath,
    "-BackupRoot", f.backupRoot,
    "-TimestampLabel", "20261128-090000",
    "-KeepDaily", "2",
    "-KeepMonthly", "0",
  ]);
  assert.equal(second.retainedCount, 2);
  assert.equal(second.prunedCount, 0);
  // 20261127-090000 must still exist (not evicted by unverified 20261128-080000)
  assert.equal(await fs.stat(path.join(f.backupRoot, "profiles-20261127-090000")).then(() => true).catch(() => false), true);
});
