import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("受保护凭据可在原生 Chrome 中安全恢复", async () => {
  const helper = await fs.readFile(path.join(root, "src", "native-credential-login.mjs"), "utf8");
  const recovery = await fs.readFile(path.join(root, "scripts", "Recover-ProtectedLogin.ps1"), "utf8");
  assert.match(helper, /connectOverCdpWithRetry/);
  assert.match(helper, /connectOverCdpWithRetry\(chromium, port, \{ timeoutMs: 30000 \}\)/);
  assert.match(helper, /for await \(const chunk of process\.stdin\)/);
  assert.match(helper, /loginUrl\.origin !== origin/);
  assert.match(helper, /explicitCaptcha/);
  assert.match(helper, /providerState\.widgetVisible && !providerState\.tokenReady/);
  assert.match(helper, /verifyCredentialSession/);
  assert.doesNotMatch(helper, /!passwordVisible && !isCredentialLoginRoute\(page\.url\(\)\)/);
  assert.match(helper, /credential\.username = ""/);
  assert.match(helper, /credential\.password = ""/);
  assert.doesNotMatch(helper, /cookies\(\)|localStorage|sessionStorage/);
  assert.match(recovery, /native-credential-login\.mjs/);
  assert.match(recovery, /Invoke-CredentialProcess/);
  assert.match(recovery, /Wait-NativeChromeDebugPort/);
  assert.match(recovery, /verification_path_missing/);
  assert.match(recovery, /\$preferNative/);
  assert.match(recovery, /Plain-CredentialLoginAccessibility\.ps1/);
  assert.match(recovery, /Invoke-PlainCredentialLoginAccessibility/);
  assert.match(recovery, /\$plainStatus -eq 'logged_in'[\s\S]{0,220}\$preferNative/);
  assert.ok(recovery.indexOf("Invoke-PlainCredentialLoginAccessibility") < recovery.indexOf("src\\credential-login.mjs"));
  assert.match(recovery, /protectedCredentialApiLoginRules/);
  assert.match(recovery, /credential-api-login\.mjs/);
  assert.match(recovery, /Invoke-CredentialProcess[\s\S]{0,260}apiHelper/);
  const apiHelper = await fs.readFile(path.join(root, "src", "credential-api-login.mjs"), "utf8");
  assert.match(apiHelper, /context\.request\.post/);
  assert.match(apiHelper, /context\.clearCookies/);
  assert.match(apiHelper, /credentialApiUserData/);
  assert.match(apiHelper, /credential_api_self/);
});

test("WAF 凭据恢复使用无调试无障碍登录并要求权威验证", async () => {
  const helper = await fs.readFile(path.join(root, "scripts", "Plain-CredentialLoginAccessibility.ps1"), "utf8");
  assert.match(helper, /Open-PlainLoginChrome\.ps1/);
  assert.match(helper, /DisableExtensions\s*=\s*\$true/);
  assert.match(helper, /Urls\s*=\s*@\(\$loginUri\.AbsoluteUri\)/);
  assert.match(helper, /@openParameters/);
  assert.match(helper, /ValuePattern/);
  assert.match(helper, /VerificationUrl/);
  assert.match(helper, /submitted = \$true/);
  assert.match(helper, /wait_for_post_fill_challenge/);
  assert.match(helper, /\[switch\]\$ProbeOnly/);
  assert.match(helper, /Resolve-LoginControls/);
  assert.match(helper, /semanticUserControls/);
  assert.match(helper, /formShape = \$resolvedControls\.shape/);
  assert.match(helper, /用户名[\s\S]{0,160}user\\s\*name/);
  assert.doesNotMatch(helper, /connectOverCDP|remote-debugging-port/);
});
