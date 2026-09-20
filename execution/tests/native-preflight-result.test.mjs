import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { nativePreflightFailure } from "../src/native-preflight-result.mjs";

test("unavailable readers never claim a failed security challenge", () => {
  for (const failureCode of ["accessibility_unavailable", "window_not_created", "target_not_loaded", "window_merged"]) {
    const result = nativePreflightFailure({ status: "unconfirmed", failureCode, diagnosticStage: "window_discovery" });
    assert.equal(result.retryCause, "native_readback_unavailable");
    assert.equal(result.failureCode, failureCode);
    assert.equal(result.diagnosticStage, "window_discovery");
  }
  assert.equal(nativePreflightFailure(null).retryCause, "native_readback_unavailable");
  assert.equal(nativePreflightFailure({ status: "prepared" }).retryCause, "native_readback_unavailable");
});

test("observed challenge and failed readback remain distinct", () => {
  assert.equal(nativePreflightFailure({ status: "managed_challenge" }).retryCause, "managed_challenge_timeout");
  assert.equal(nativePreflightFailure({ inspectionStatus: "managed_challenge" }).retryCause, "managed_challenge_timeout");
  assert.equal(nativePreflightFailure({ status: "managed_challenge", failureCode: "accessibility_unavailable" }).retryCause, "native_readback_unavailable");
});

test("native readers recognize short NexusPHP completion messages", async () => {
  for (const file of ["Invoke-PlainWafAccessibility.ps1", "Invoke-MainChromeCheckinAccessibility.ps1"]) {
    const source = await fs.readFile(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    const pattern = source.match(/\$success = \$bodyText -match '([^']+)'/)[1];
    assert.match("抱歉 您今天已经签到过了，请勿重复刷新。", new RegExp(pattern, "i"));
    assert.match("今日已签到", new RegExp(pattern, "i"));
    assert.doesNotMatch("今日签到 尚未签到", new RegExp(pattern, "i"));
    assert.match(source, /if \(\$last\.success -and \$last\.sameOrigin -and -not \$last\.waf -and -not \$last\.securityVerification -and -not \$last\.loginRoute\)/);
    assert.doesNotMatch(source, /if \(\$last\.success -and \$last\.siteBodyLoaded\)/);
  }
});

test("main-profile background startup precedes URI discovery and cleanup keeps evidence", async () => {
  const source = await fs.readFile(new URL("../scripts/Invoke-MainChromeCheckinAccessibility.ps1", import.meta.url), "utf8");
  assert.match(source, /'--start-minimized'/);
  assert.match(source, /Start-Process[^\r\n]+-WindowStyle Hidden/);
  assert.doesNotMatch(source, /--window-position=-/);
  const cleanup = source.slice(source.lastIndexOf("finally {"));
  assert.match(cleanup, /cleanupFailureCode/);
  assert.doesNotMatch(cleanup, /\$result = \[pscustomobject\]/);
});

test("hidden native windows are discovered by isolated profile process IDs", async () => {
  const source = await fs.readFile(new URL("../scripts/Invoke-PlainWafAccessibility.ps1", import.meta.url), "utf8");
  assert.match(source, /Get-ProfileChromeProcesses \| Select-Object -ExpandProperty ProcessId/);
  assert.match(source, /\[CheckinProfileWindows\]::Find\(\[int\[\]\]\$ids\)/);
  assert.match(source, /if \(!ids.Contains\(\(int\)id\)\) return true/);
  assert.match(source, /SW_SHOWNOACTIVATE/);
  assert.doesNotMatch(source, /MainWindowHandle -ne 0/);
});
