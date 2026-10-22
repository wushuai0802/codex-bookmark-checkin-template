import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const helper = fs.readFileSync(new URL("../scripts/Invoke-MainChromeCheckinAccessibility.ps1", import.meta.url), "utf8");

test("main Chrome task never visibly restores a minimized window or rejects a readable off-screen control", () => {
  assert.match(helper, /if \(IsIconic\(window\)\) throw/);
  assert.match(helper, /SetWindowPos\(window, IntPtr\.Zero, OffscreenX, OffscreenY, 1400, 900, 0x0054\)/);
  assert.doesNotMatch(helper, /ShowWindow\([^\r\n]+, [47]\)/);
  assert.doesNotMatch(helper, /Current\.IsOffscreen/);
  const discovery = helper.slice(helper.indexOf("function Get-ChromeWindows"), helper.indexOf("function Get-MainProfileChromeProcessIds"));
  assert.match(discovery, /FindWindows\(\[int\[\]\]\$ids\)/);
  assert.match(discovery, /AutomationElement\]::FromHandle\(\$handle\)/);
  assert.doesNotMatch(discovery, /RootElement|TreeScope\]::Children/);
  assert.match(helper, /\$beforeHandles\[\$handle\.ToInt32\(\)\]/);
  assert.match(helper, /\$_.Current.ProcessId -notin \$mainIds/);
  assert.match(helper, /\$_.Current.NativeWindowHandle -ne \$ownedStartupWindow.Current.NativeWindowHandle/);
  assert.match(helper, /GetForegroundWindow\(\) == window/);
  const close = helper.slice(helper.indexOf("function Close-TaskWindow"), helper.indexOf("$beforeHandles ="));
  assert.match(close, /try \{ \[CheckinWindowNative\]::PrepareToClose\(\$handle\) \} catch \{ \$placementError = \$_ \}/);
  assert.ok(close.indexOf("PostMessage") < close.indexOf("if ($placementError)"));
});

const chrome = process.env.CHECKIN_TEST_CHROME || [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].find((file) => fs.existsSync(file));
const enabled = process.platform === "win32" && process.env.CHECKIN_NATIVE_WINDOW_FIXTURE === "1" && Boolean(chrome);

test("real cold and warm Chrome windows render and Invoke off screen, then close with hidden safe bounds", {
  skip: enabled ? false : "Set CHECKIN_NATIVE_WINDOW_FIXTURE=1 on an interactive Windows desktop with Chrome",
  timeout: 120_000,
}, async (t) => {
  const fixture = fileURLToPath(new URL("fixtures/native-main-window-offscreen.ps1", import.meta.url));
  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    const { stdout } = await run(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture,
      "-ChromeExecutable", chrome], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
    const result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ""));
    assert.ok(result.samples > 0, shell);
    assert.equal(result.onscreen, 0, shell);
    for (const field of ["hiddenDiscovered", "hiddenLifecycleOwned", "coldUriRead", "warmUriRead", "invoked", "hiddenForClose", "firstUnchanged", "secondClosed", "minimizedRejected", "remainedMinimized", "unownedRejected", "unownedStillOpen", "timeoutClosed"])
      assert.equal(result[field], true, `${shell}/${field}`);
    assert.deepEqual(result.safeBounds, { Left: 80, Top: 80, Right: 1480, Bottom: 980 }, shell);
    assert.ok(result.phases.some((row) => row.phase === "cold_startup"), shell);
    assert.ok(result.phases.some((row) => row.phase === "warm_startup"), shell);
    // Foreground restoration is best effort under Windows activation policy;
    // record its observed boundary without claiming it proves hidden rendering.
    t.diagnostic(`${shell}: ${result.samples} window samples, onscreen=${result.onscreen}, foreground=${result.foreground}`);
  }
});
