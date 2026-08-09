import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("原生自动恢复使用已验证的本机回环非零调试端口", async () => {
  const helper = await fs.readFile(path.join(root, "scripts", "Native-ChromeDebug.ps1"), "utf8");
  assert.match(helper, /TcpListener.*IPAddress\]::Loopback, 0/s);
  assert.match(helper, /http:\/\/127\.0\.0\.1:\$Port\/json\/version/);
  assert.match(helper, /\$webSocket\.Port -eq \$Port/);
  assert.match(helper, /\$expectedPortArgument = "--remote-debugging-port=\$ExpectedPort"/);
  assert.match(helper, /\$matchingChrome\.Count -gt 0 -and \(Test-NativeChromeDebugEndpoint \$ExpectedPort\)/);
  assert.match(helper, /Chrome only writes DevToolsActivePort when started with port 0/);

  for (const relativePath of [
    "scripts/Recover-NativeOAuthLogin.ps1",
    "scripts/Recover-NativeLogin.ps1",
    "scripts/Prepare-NativeWafSession.ps1",
  ]) {
    const source = await fs.readFile(path.join(root, relativePath), "utf8");
    assert.match(source, /Get-NativeChromeDebugPort/);
    assert.match(source, /RemoteDebuggingPort/);
    assert.match(source, /Wait-NativeChromeDebugPort \$profilePath \$debugPort 25/);
    assert.doesNotMatch(source, /DynamicRemoteDebuggingPort/);
  }

  const preflight = await fs.readFile(path.join(root, "scripts", "Prepare-NativeWafSession.ps1"), "utf8");
  assert.match(preflight, /try \{[\s\S]*Open-PlainLoginChrome\.ps1[\s\S]*Wait-NativeChromeDebugPort[\s\S]*finally \{\s*if \(\$nativeChromeStarted\) \{ Close-AutomationChrome \}/);
});
