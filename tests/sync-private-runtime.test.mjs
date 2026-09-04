import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";
const sourceScript = new URL("../scripts/Sync-PrivateRuntime.ps1", import.meta.url);

async function makeProject(root, name = "codex-bookmark-checkin") {
  await fs.mkdir(path.join(root, "scripts"), { recursive: true });
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), `${JSON.stringify({ name })}\n`, "utf8");
  await fs.writeFile(path.join(root, "config", "defaults.json"), `${JSON.stringify({ externalOcr: false })}\n`, "utf8");
  await fs.writeFile(path.join(root, "requirements-ocr.txt"), "offline-ocr==1.0.0\n", "utf8");
}

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-sync-"));
  const publicRoot = path.join(root, "public");
  const privateRoot = path.join(root, "private");
  await makeProject(publicRoot);
  await makeProject(privateRoot);
  await fs.copyFile(sourceScript, path.join(publicRoot, "scripts", "Sync-PrivateRuntime.ps1"));
  await fs.copyFile(sourceScript, path.join(privateRoot, "scripts", "Sync-PrivateRuntime.ps1"));
  await fs.writeFile(path.join(publicRoot, "src", "sample.mjs"), "export const value = 2;\n", "utf8");
  await fs.writeFile(path.join(privateRoot, "src", "sample.mjs"), "export const value = 1;\n", "utf8");
  return { root, publicRoot, privateRoot, script: path.join(publicRoot, "scripts", "Sync-PrivateRuntime.ps1") };
}

test("私有运行版同步默认只报告，Apply 时备份并原子替换", async () => {
  const fixture = await makeFixture();
  try {
    await assert.rejects(execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", fixture.privateRoot,
    ], { encoding: "utf8" }), (error) => {
      const report = JSON.parse(String(error.stdout).trim());
      return report.pendingCount === 1 && report.mode === "dry_run";
    });

    const { stdout } = await execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", fixture.privateRoot, "-Apply",
    ], { encoding: "utf8" });
    const report = JSON.parse(stdout.trim());
    assert.equal(report.pendingCount, 1);
    assert.match(await fs.readFile(path.join(fixture.privateRoot, "src", "sample.mjs"), "utf8"), /value = 2/);
    assert.match(await fs.readFile(path.join(report.backupRoot, "src", "sample.mjs"), "utf8"), /value = 1/);
    assert.deepEqual((await fs.readdir(path.join(fixture.privateRoot, "src")))
      .filter((name) => name.includes("replace-backup")), []);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("私有运行版同步拒绝错误项目和嵌套目标", async () => {
  const fixture = await makeFixture();
  try {
    await fs.writeFile(path.join(fixture.privateRoot, "package.json"), `${JSON.stringify({ name: "other-project" })}\n`, "utf8");
    await assert.rejects(execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", fixture.privateRoot,
    ], { encoding: "utf8" }), /project identity mismatch/);

    const nested = path.join(fixture.publicRoot, "nested-private");
    await makeProject(nested);
    await assert.rejects(execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", nested,
    ], { encoding: "utf8" }), /must be separate/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("私有运行版同步通用默认项但保留私有配置", async () => {
  const fixture = await makeFixture();
  try {
    const publicDefaults = path.join(fixture.publicRoot, "config", "defaults.json");
    const privateDefaults = path.join(fixture.privateRoot, "config", "defaults.json");
    const privateConfig = path.join(fixture.privateRoot, "config", "config.local.json");
    const publicRequirements = path.join(fixture.publicRoot, "requirements-ocr.txt");
    const privateRequirements = path.join(fixture.privateRoot, "requirements-ocr.txt");
    await fs.writeFile(publicDefaults, `${JSON.stringify({ externalOcr: true })}\n`, "utf8");
    await fs.writeFile(publicRequirements, "offline-ocr==2.0.0\n", "utf8");
    await fs.writeFile(privateConfig, `${JSON.stringify({ privateMarker: "preserve" })}\n`, "utf8");

    const { stdout } = await execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", fixture.privateRoot, "-Apply",
    ], { encoding: "utf8" });
    const report = JSON.parse(stdout.trim());
    assert.equal(report.pendingCount, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(privateDefaults, "utf8")), { externalOcr: true });
    assert.equal(await fs.readFile(privateRequirements, "utf8"), "offline-ocr==2.0.0\n");
    assert.deepEqual(JSON.parse(await fs.readFile(privateConfig, "utf8")), { privateMarker: "preserve" });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test("私有运行版同步拒绝托管源码中的重解析点", async (t) => {
  const fixture = await makeFixture();
  try {
    const outside = path.join(fixture.root, "outside");
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(fixture.publicRoot, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture.script,
      "-PrivateRoot", fixture.privateRoot,
    ], { encoding: "utf8" }), /reparse point/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
