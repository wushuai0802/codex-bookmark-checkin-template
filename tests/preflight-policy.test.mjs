import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { configuredNativeWafOrigins, selectPreflightOrigins } from "../src/preflight-policy.mjs";

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
    mainChromeFallbackUrls: [
      { url: "https://bookmarked.test/profile" },
      { url: "https://fallback-unrelated.test/profile" },
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

test("WAF 目标集合包含无调试原生预热和主 Chrome 回退站点", () => {
  assert.deepEqual([...configuredNativeWafOrigins({
    nativeWafPreflightUrls: [{ url: "https://waf.test/attendance.php" }],
    nativeChallengePreflight: [{ url: "https://other.test/checkin" }],
    mainChromeFallbackUrls: [{ url: "https://main-profile.test/profile" }],
  })], ["https://waf.test", "https://main-profile.test"]);
});

test("主 Chrome 回退只选择当前书签范围内的来源", () => {
  assert.deepEqual(selectPreflightOrigins({
    targets: [{ origin: "https://selected.test", allowedOrigins: ["https://selected.test"] }],
  }, {
    mainChromeFallbackUrls: [
      { url: "https://selected.test/profile" },
      { url: "https://not-selected.test/profile" },
    ],
  }), ["https://selected.test"]);
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

test("定向续跑只预热选中的来源或账号", async () => {
  const runner = await fs.readFile(path.join(root, "scripts", "Run-Checkin.ps1"), "utf8");
  assert.match(runner, /\$selectedOrigins -contains \[string\]\$_\.origin/);
  assert.match(runner, /\$selectedAccountKeys -contains \[string\]\$_\.accountKey/);
  assert.match(runner, /\$preflightResults[\s\S]*Sort-Object -Unique/);
});

test("原生保存密码恢复显式启用 Chrome 账户密码库", async () => {
  const recoverScript = await fs.readFile(path.join(root, "scripts", "Recover-NativeLogin.ps1"), "utf8");
  const openScript = await fs.readFile(path.join(root, "scripts", "Open-PlainLoginChrome.ps1"), "utf8");
  const nativeLogin = await fs.readFile(path.join(root, "src", "native-login.mjs"), "utf8");
  const syncScript = await fs.readFile(path.join(root, "scripts", "Sync-ChromeSavedLogins.ps1"), "utf8");
  assert.match(recoverScript, /Open-PlainLoginChrome\.ps1'[\s\S]*-EnablePasswordManager/);
  assert.match(recoverScript, /for\s*\(\$loginAttempt\s*=\s*1;\s*\$loginAttempt\s*-le\s*3/);
  assert.match(openScript, /if\s*\(-not\s+\$EnablePasswordManager\)\s*\{[\s\S]*--disable-sync/);
  assert.match(nativeLogin, /for\s*\(const field of \[username, password, username\]\)/);
  assert.match(syncScript, /syncAccountSavedLoginsToLocalStore/);
  assert.match(syncScript, /app_bound_encrypted_key/);
  assert.match(syncScript, /SourceName\s*=\s*'Login Data For Account'[\s\S]*TargetName\s*=\s*'Login Data'/);
});

test("保存密码恢复在 CDP 自动填充失败后使用无调试端口无障碍兜底", async () => {
  const indexSource = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  const helper = await fs.readFile(path.join(root, "scripts", "Invoke-PlainSavedPasswordAccessibility.ps1"), "utf8");
  assert.match(indexSource, /method:\s*"plain_saved_password_accessibility"/);
  assert.match(indexSource, /Invoke-PlainSavedPasswordAccessibility\.ps1/);
  assert.match(helper, /Open-PlainLoginChrome\.ps1'[\s\S]*-EnablePasswordManager/);
  assert.doesNotMatch(helper, /RemoteDebuggingPort/);
  assert.match(helper, /UIAutomationClient/);
  assert.match(helper, /SendKeys\]::SendWait\('\{DOWN\}'\)/);
});

test("原生预热规则使用被动等待或离屏签到且最长检查两分钟", async () => {
  const publicRules = JSON.parse(await fs.readFile(path.join(root, "config", "site-rules.public.json"), "utf8"));
  const preflightScript = await fs.readFile(path.join(root, "scripts", "Prepare-NativeWafSession.ps1"), "utf8");
  const inspector = await fs.readFile(path.join(root, "src", "native-browser-inspect.mjs"), "utf8");
  const plainWaf = await fs.readFile(path.join(root, "scripts", "Invoke-PlainWafAccessibility.ps1"), "utf8");
  const openChrome = await fs.readFile(path.join(root, "scripts", "Open-PlainLoginChrome.ps1"), "utf8");
  const browser = await fs.readFile(path.join(root, "src", "browser.mjs"), "utf8");

  assert.deepEqual(publicRules.nativeWafPreflightUrls, [
    { url: "https://piggo.me/attendance.php", waitSeconds: 120, passiveOnly: true, trustAsSigned: false, automationUserDataDir: "data/sites/piggo/chrome-user-data" },
    { url: "https://www.hdkyl.in/attendance.php", waitSeconds: 90, passiveOnly: true },
    { url: "https://ubits.club/attendance.php", waitSeconds: 120, passiveOnly: true },
  ]);
  assert.deepEqual(publicRules.nativeChallengePreflight.slice(0, 2), [
    { url: "https://audiences.me/attendance.php", waitSeconds: 90, action: "checkin" },
    { url: "https://ourbits.club/attendance.php", waitSeconds: 120, action: "checkin" },
  ]);
  assert.match(preflightScript, /passiveOnly[\s\S]*Invoke-PlainWafAccessibility\.ps1[\s\S]*-AllowPreparedSiteBody/);
  assert.match(preflightScript, /passiveOnly[\s\S]*\$passiveInspection\.status/);
  assert.match(preflightScript, /Invoke-PlainWafAccessibility\.ps1/);
  assert.match(preflightScript, /for\s*\(\$plainAttempt\s*=\s*1;\s*\$plainAttempt\s*-le\s*2/);
  assert.match(preflightScript, /\[bool\]\$item\.trustAsSigned/);
  assert.match(preflightScript, /\$trustAsSigned = if \(\$_ -isnot \[string\]/);
  assert.match(preflightScript, /Resolve-NativeProfilePath/);
  assert.match(preflightScript, /UserDataDirOverride['"]?,?\s*\$profilePath/);
  assert.match(preflightScript, /\$preparedOnly/);
  assert.match(preflightScript, /elseif\s*\(\$preparedOnly\)\s*\{\s*'prepared'/);
  assert.doesNotMatch(preflightScript, /inspectionStatus\s*=\s*if\s*\(\$passivePrepared\)\s*\{\s*'passive_wait'/);
  assert.match(preflightScript, /Offscreen\s*=\s*\$true/);
  assert.doesNotMatch(preflightScript, /action\s+-ne\s+'checkin'[\s\S]*?Offscreen/);
  assert.match(inspector, /Math\.min\(120,/);
  assert.match(inspector, /nativeCheckinActionOrigins = new Set\(\[/);
  assert.match(inspector, /https:\/\/audiences\.me/);
  assert.match(inspector, /https:\/\/ourbits\.club/);
  assert.match(inspector, /nativeCheckinActionOrigins\.has\(expectedOrigin\)/);
  assert.match(inspector, /findNativeCheckinAction\(page/);
  assert.match(inspector, /scoreActionText\(candidate\.text\)/);
  assert.match(inspector, /new URL\(candidate\.formAction\)\.origin === expectedOrigin/);
  assert.match(inspector, /findNativeCheckinAction\(page, "challenge-submit"\)/);
  assert.match(inspector, /!checkinStarted && snapshot\.challengeSelectors/);
  assert.match(inspector, /candidate\.id === "checkin-submit"/);
  assert.match(inspector, /challengeSubmitAttempted\s*=\s*true/);
  assert.doesNotMatch(inspector, /lastCheckboxClickAt/);
  assert.match(preflightScript, /reloadOnChallengeAfterSeconds/);
  assert.match(preflightScript, /\$inspectionMode \(\[int\]\$item\.reloadOnChallengeAfterSeconds\)/);
  assert.match(inspector, /challengeReloaded/);
  assert.match(inspector, /page\.reload\(/);
  assert.match(plainWaf, /Open-PlainLoginChrome\.ps1'[\s\S]*-Offscreen[\s\S]*-DisableExtensions/);
  assert.match(plainWaf, /UserDataDirOverride/);
  assert.match(plainWaf, /正在进行安全检测/);
  assert.match(plainWaf, /正在进行安全验证/);
  assert.match(plainWaf, /本网站使用安全服务防护恶意自动程序/);
  assert.match(plainWaf, /签到已得\\s\*\\d\+/);
  assert.match(plainWaf, /function Test-EquivalentWafOrigin/);
  assert.match(plainWaf, /-replace '\^www\\\.', ''/);
  assert.match(plainWaf, /Test-EquivalentWafOrigin \$originUri \$currentUri/);
  assert.doesNotMatch(plainWaf, /Invoke-PlainPageRefresh/);
  assert.doesNotMatch(plainWaf, /\{F5\}/);
  assert.match(plainWaf, /function Invoke-LeichiConfirmationClick/);
  assert.match(plainWaf, /AutomationId/);
  assert.match(plainWaf, /sl-check/);
  assert.match(plainWaf, /InvokePattern/);
  assert.match(plainWaf, /客户端异常\.\*确认\.\*合法用户/);
  assert.match(plainWaf, /confirmationClickAttempted/);
  assert.match(plainWaf, /confirmationClicked/);
  assert.match(plainWaf, /cloudflareWaf/);
  assert.match(plainWaf, /AllowPreparedSiteBody/);
  assert.match(plainWaf, /AllowCloudflareChallengeClick/);
  assert.match(plainWaf, /function Invoke-CloudflareChallengeClick/);
  assert.match(plainWaf, /请验证您是真人/);
  assert.match(plainWaf, /cloudflareChallengeClicked/);
  assert.match(plainWaf, /securityVerification/);
  assert.match(plainWaf, /异地登录安全验证/);
  assert.match(plainWaf, /站点要求完成异地登录 2FA 验证/);
  assert.match(preflightScript, /autoClickTurnstileOrigins/);
  assert.match(preflightScript, /-AllowCloudflareChallengeClick/);
  assert.match(preflightScript, /站点要求完成异地登录 2FA 验证/);
  assert.doesNotMatch(plainWaf, /RemoteDebuggingPort/);
  assert.match(openChrome, /\[switch\]\$DisableExtensions/);
  assert.match(openChrome, /\[switch\]\$Minimized/);
  assert.match(openChrome, /--start-minimized/);
  assert.match(openChrome, /不能同时指定离屏和最小化窗口/);
  assert.match(openChrome, /--disable-extensions/);
  assert.match(openChrome, /directConnectionOrigins/);
  assert.match(openChrome, /--proxy-bypass-list=/);
  assert.match(browser, /directConnectionOrigins/);
  assert.match(browser, /--proxy-bypass-list=/);
});

test("主 Chrome 回退严格限制白名单并只关闭任务创建的窗口", async () => {
  const helper = await fs.readFile(path.join(root, "scripts", "Invoke-MainChromeCheckinAccessibility.ps1"), "utf8");
  const preflight = await fs.readFile(path.join(root, "scripts", "Prepare-NativeWafSession.ps1"), "utf8");
  const defaults = JSON.parse(await fs.readFile(path.join(root, "config", "defaults.json"), "utf8"));

  assert.deepEqual(defaults.mainChromeFallbackUrls, []);
  assert.match(helper, /mainChromeFallbackUrls/);
  assert.match(helper, /不在明确白名单中/);
  assert.match(helper, /\$beforeHandles/);
  assert.match(helper, /-not \$beforeHandles\.ContainsKey/);
  assert.match(helper, /function Close-TaskWindow/);
  assert.match(helper, /WindowPattern/);
  assert.doesNotMatch(helper, /Stop-Process|Kill\(/);
  assert.doesNotMatch(helper, /RemoteDebuggingPort|remote-debugging-port/);
  assert.match(helper, /--window-position=-32000,-32000/);
  assert.match(helper, /签到成功\|今日已签到\|今天已签到/);
  assert.match(helper, /\$topMatches\.Count -ne 1/);
  assert.match(helper, /protectedCredentialOrigins/);
  assert.match(helper, /keybd_event/);
  assert.match(helper, /Get-UniqueLoginButton/);
  assert.doesNotMatch(helper, /SetValue\(|\.fill\(|password\s*=/i);
  assert.match(preflight, /Invoke-MainChromeCheckinAccessibility\.ps1/);
  assert.match(preflight, /mainChromeFallbackOnly/);
});

test("斑马验证码过期只重启一次且成功状态来自 API", async () => {
  const inspector = await fs.readFile(path.join(root, "src", "native-browser-inspect.mjs"), "utf8");
  assert.match(inspector, /BMAPI_EXPIRED_CHALLENGE/);
  assert.match(inspector, /验证码\|驗證碼/);
  assert.match(inspector, /重新\(\?:验证\|驗證\)/);
  assert.match(inspector, /checkinRestartCount\s*<\s*1/);
  assert.match(inspector, /checkinRestartCount\s*\+=\s*1/);
  assert.match(inspector, /state\s*=\s*bmapiState\s*\?\?/);
  assert.match(inspector, /getBmapiCheckinState\(page\)/);
});
