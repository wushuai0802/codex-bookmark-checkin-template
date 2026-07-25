import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { selectPreflightOrigins } from "../src/preflight-policy.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("原生预热只保留实际书签目标及其明确关联来源", () => {
  const plan = {
    targets: [{
      origin: "https://bookmarked.test",
      allowedOrigins: ["https://bookmarked.test", "https://related.test"],
    }],
  };
  const config = {
    nativeWafPreflightUrls: [
      { url: "https://bookmarked.test/attendance.php" },
      { url: "https://unrelated.test/attendance.php" },
    ],
    nativeChallengePreflight: [
      { url: "https://related.test/dashboard", action: "checkin" },
      { url: "https://also-unrelated.test/dashboard", action: "checkin" },
    ],
  };

  assert.deepEqual(selectPreflightOrigins(plan, config), [
    "https://bookmarked.test",
    "https://related.test",
  ]);
});

test("没有匹配书签时不会生成原生预热范围", () => {
  assert.deepEqual(selectPreflightOrigins({ targets: [] }, {
    nativeWafPreflightUrls: [{ url: "https://unrelated.test/attendance.php" }],
  }), []);
});

test("已取消的书签目标不会进入原生预热", () => {
  assert.deepEqual(selectPreflightOrigins({
    targets: [{ origin: "https://disabled.test", allowedOrigins: ["https://disabled.test"] }],
  }, {
    nativeChallengePreflight: [{ url: "https://disabled.test/checkin", action: "checkin" }],
    disabledCheckinOrigins: ["https://disabled.test"],
  }), []);
});

test("原生预热脚本拒绝未显式指定范围", async () => {
  const script = path.join(root, "scripts", "Prepare-NativeWafSession.ps1");
  await assert.rejects(
    execFileAsync("pwsh.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ], { cwd: root, encoding: "utf8" }),
    (error) => /必须显式传入非空 -Origins/.test(`${error.stdout}\n${error.stderr}`),
  );
});
