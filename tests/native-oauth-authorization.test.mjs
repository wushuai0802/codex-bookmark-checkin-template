import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const source = await fs.readFile(new URL("../src/native-oauth-login.mjs", import.meta.url), "utf8");
const plainAccessibility = await fs.readFile(new URL("../scripts/Invoke-PlainOAuthAccessibility.ps1", import.meta.url), "utf8");
const recoveryScript = await fs.readFile(new URL("../scripts/Recover-NativeOAuthLogin.ps1", import.meta.url), "utf8");

test("LinuxDO 授权仅在 connect.linux.do 使用明确控件", () => {
  assert.match(source, /const CONNECT_LINUX_DO_ORIGIN = "https:\/\/connect\.linux\.do"/);
  assert.match(source, /parseObservedBrowserUrl\(page\.url\(\)\)\?\.origin === CONNECT_LINUX_DO_ORIGIN/);
  assert.match(source, /if \(location\.origin === CONNECT_LINUX_DO_ORIGIN\)/);
  for (const label of [
    "同意", "确认授权", "同意并继续", "继续", "Approve",
    "Continue", "允许", "授权", "Allow", "Authorize",
  ]) {
    assert.equal(source.includes(`"${label}"`), true, `缺少授权控件文案：${label}`);
  }
  assert.match(source, /getByRole\("button", \{ name: label, exact: true \}\)/);
  assert.match(source, /getByRole\("link", \{ name: label, exact: true \}\)/);
  assert.match(source, /tagName === "input" && type === "submit"/);
});

test("LinuxDO 授权点击有次数和时间双重边界", () => {
  assert.match(source, /const MAX_CONNECT_AUTHORIZATION_CLICKS = 3/);
  assert.match(source, /const MIN_CONNECT_AUTHORIZATION_CLICK_INTERVAL_MS = 5000/);
  assert.match(source, /state\.clicks >= MAX_CONNECT_AUTHORIZATION_CLICKS/);
  assert.match(source, /MIN_CONNECT_AUTHORIZATION_CLICK_INTERVAL_MS - \(Date\.now\(\) - state\.lastClickedAt\)/);
  assert.match(source, /if \(remainingInterval > 0\) await page\.waitForTimeout\(remainingInterval\)/);
  assert.match(source, /state\.clicks \+= 1/);
});

test("connect.linux.do Turnstile 先被动等待且最多安全交互一次", () => {
  assert.match(source, /const CONNECT_TURNSTILE_PASSIVE_WAIT_MS = 3000/);
  assert.match(source, /if \(!isConnectLinuxDoAuthorizationPage\(page\)\) return \{ present: false, ready: false \}/);
  assert.match(source, /cf-turnstile-response/);
  assert.match(source, /challenges\.cloudflare\.com/);
  assert.match(source, /#challenge-stage:visible/);
  assert.match(source, /#turnstile-wrapper:visible/);
  assert.match(source, /CONNECT_MANAGED_CHALLENGE_TITLE/);
  assert.match(source, /page\.evaluate\(\(\) => \(\{ width: innerWidth, height: innerHeight \}\)\)/);
  assert.match(source, /page\.mouse\.click\(\(viewport\.width \/ 2\) - 120, viewport\.height \* 0\.6\)/);
  assert.match(source, /element\.value\.length > 20/);
  assert.match(source, /if \(await findConnectLinuxDoAuthorizationControl\(page\)\) return true/);
  assert.match(source, /if \(!challenge\.present \|\| challenge\.ready \|\| state\.interactionAttempted\) return true/);
  assert.match(source, /frameLocator\([\s\S]*?input\[type="checkbox"\]:visible/);
  assert.match(source, /boundingBox\(\)/);
  assert.match(source, /page\.mouse\.click\(box\.x \+ leftOffset, box\.y \+ box\.height \/ 2\)/);
  assert.match(source, /state\.interactionAttempted = true/);

  const authorizationCall = source.indexOf("if (await clickConnectLinuxDoAuthorization(page, connectAuthorizationState))");
  const turnstileCall = source.indexOf("if (await handleConnectLinuxDoTurnstile(page, connectTurnstileState))");
  assert.ok(authorizationCall >= 0 && turnstileCall > authorizationCall);
  assert.equal([...source.matchAll(/interactWithConnectLinuxDoTurnstileOnce\(/g)].length, 2);
});

test("不在 GitHub 自动授权且不读取 OAuth 正文或浏览器秘密", () => {
  assert.match(source, /机器人 Chrome 需要人工确认一次 GitHub 授权/);
  assert.doesNotMatch(source, /button\[name=["']authorize/);
  assert.doesNotMatch(source, /response\.text\(|document\.body|innerText|textContent/);
  assert.doesNotMatch(source, /document\.cookie|cookies\(|storageState|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /CHECKIN_OAUTH_CONTROL_DIAGNOSTIC|oauth-connect-debug|screenshot\(/);
});

test("GitHub 登录页会在隔离 profile 中尝试保存凭据填充后再提交", () => {
  assert.match(source, /async function restoreSavedGitHubLogin\(page, state\)/);
  assert.match(source, /#login_field:visible/);
  assert.match(source, /#password:visible/);
  assert.match(source, /for \(const field of \[username, password, username\]\)/);
  assert.match(source, /field\.press\("ArrowDown"\)/);
  assert.match(source, /button\[type="submit"\]:visible/);
  assert.match(source, /restoreSavedGitHubLogin\(page, githubSavedLoginState\)/);
  assert.match(recoveryScript, /EnablePasswordManager\s*=\s*\$true/);
  assert.doesNotMatch(source, /console\.log\([^\n]*(username|password)/i);
});

test("LinuxDO 上游登录接管 popup 或同页导航并更新活动页", () => {
  assert.match(source, /page\.waitForEvent\("popup", \{ timeout: 7000 \}\)/);
  assert.match(source, /page\.waitForURL\(\(url\) =>/);
  assert.match(source, /const activePage = await Promise\.race\(\[/);
  assert.match(source, /const upstreamPage = await startLinuxDoUpstreamLogin\(page, upstreamProvider\)/);
  assert.match(source, /page = upstreamPage/);
  assert.match(source, /resumeTargetAfterUpstream[\s\S]*connectTurnstileState\.passiveWaitCompleted = false/);
  assert.match(source, /resumeTargetAfterUpstream[\s\S]*connectTurnstileState\.interactionAttempted = false/);
  assert.doesNotMatch(source, /if \(await startLinuxDoUpstreamLogin\(page, upstreamProvider\)\) continue/);
});

test("OAuth 结果仍强制核对配置账号 ID 且不输出观察到的错误 ID", () => {
  assert.match(source, /if \(!configuredExpectedAccountId\) throw new Error\("原生 OAuth 恢复必须配置预期账号 ID"\)/);
  assert.match(source, /existingAccountId === configuredExpectedAccountId/);
  assert.match(source, /if \(observedAccountId !== configuredExpectedAccountId\)/);
  assert.match(source, /accountId: configuredExpectedAccountId/);
  assert.doesNotMatch(source, /accountId: observedAccountId|实际 \$\{/);
});

test("OAuth 超时诊断仅输出有界流程状态", () => {
  assert.match(source, /授权点击=\$\{connectAuthorizationState\.clicks\}/);
  assert.match(source, /验证交互=\$\{connectTurnstileState\.interactionAttempted \? 1 : 0\}/);
  assert.match(source, /上游恢复=\$\{upstreamLoginAttempted \? 1 : 0\}/);
  assert.match(source, /等待重建=\$\{resumeTargetAfterUpstream \? 1 : 0\}/);
});

test("LinuxDO 受调试端口拦截时只使用一次无调试端口后台恢复", () => {
  assert.match(recoveryScript, /if \(\$Provider -eq 'LinuxDO'\)/);
  assert.match(recoveryScript, /Invoke-PlainOAuthAccessibility\.ps1/);
  assert.match(recoveryScript, /\$plainExitCode -eq 0 -and \$plainResult\.status -eq 'callback_reached'/);
  assert.match(recoveryScript, /\$verificationRound = Invoke-NativeOAuthRound/);
  assert.doesNotMatch(plainAccessibility, /RemoteDebuggingPort|connectOverCDP|DevToolsActivePort/);
  assert.match(plainAccessibility, /Open-PlainLoginChrome\.ps1'[\s\S]*-Offscreen -EnablePasswordManager/);
  assert.match(plainAccessibility, /Safe-UIAutomation\.ps1/);
  assert.match(plainAccessibility, /Get-PrivateCurrentUri/);
});

test("无调试端口 OAuth 只调用固定无障碍控件并保持有界", () => {
  assert.match(plainAccessibility, /Get-UniqueProviderControl/);
  assert.match(plainAccessibility, /Get-UniqueNamedControl/);
  assert.match(plainAccessibility, /\$authorizationClicks -lt 3/);
  assert.match(plainAccessibility, /\$challengeInteractions -eq 0/);
  assert.match(plainAccessibility, /'Verify you are human'/);
  assert.match(plainAccessibility, /'同意', '确认授权'/);
  assert.match(plainAccessibility, /\[ValidateRange\(30, 180\)\]\[int\]\$TimeoutSeconds = 120/);
  assert.match(plainAccessibility, /\$location\.Host -eq 'github\.com'/);
  assert.match(plainAccessibility, /upstreamSavedLoginSubmitAttempted/);
  assert.doesNotMatch(plainAccessibility, /document\.cookie|cookies\(|localStorage|sessionStorage|response\.text\(|innerText|textContent|screenshot\(/);
});
