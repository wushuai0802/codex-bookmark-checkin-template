import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  configuredNativeWafOrigins,
  requiresTrustedDeviceInitialization,
  selectPreflightOrigins,
} from "../src/preflight-policy.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("只有明确 2FA 或不可重试的可信设备初始化才映射为 2FA", () => {
  assert.equal(requiresTrustedDeviceInitialization({ status: "needs_attention" }), false);
  assert.equal(requiresTrustedDeviceInitialization({ inspectionStatus: "needs_attention" }), false);
  assert.equal(requiresTrustedDeviceInitialization({ failureCode: "two_factor_required" }), true);
  assert.equal(requiresTrustedDeviceInitialization({
    attentionKind: "trusted_device_initialization",
    retryableLoginRecovery: false,
  }), true);
  assert.equal(requiresTrustedDeviceInitialization({
    attentionKind: "trusted_device_initialization",
    retryableLoginRecovery: true,
  }), false);
});

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

test("主 Chrome 回退可把迁移目标归属到原书签来源", () => {
  const config = {
    mainChromeFallbackUrls: [{
      sourceOrigin: "https://old.example",
      url: "https://new.example/checkin",
    }],
  };
  const plan = {
    targets: [{
      origin: "https://old.example",
      allowedOrigins: ["https://old.example", "https://new.example"],
    }],
  };
  assert.deepEqual(selectPreflightOrigins(plan, config), ["https://old.example"]);
  assert.deepEqual([...configuredNativeWafOrigins(config)], ["https://old.example"]);
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
  assert.match(helper, /Safe-UIAutomation\.ps1/);
  assert.match(helper, /safe_interaction_unavailable/);
  assert.doesNotMatch(helper, /SendKeys|SetFocus\(|LegacyIAccessiblePattern|DoDefaultAction/);
});

test("专用 Chrome 无障碍助手不发送系统按键或抢占前台", async () => {
  const helpers = await Promise.all([
    "Invoke-PlainSavedPasswordAccessibility.ps1",
    "Invoke-PlainWafAccessibility.ps1",
    "Invoke-PlainOAuthAccessibility.ps1",
    "Plain-CredentialLoginAccessibility.ps1",
  ].map((name) => fs.readFile(path.join(root, "scripts", name), "utf8")));
  for (const helper of helpers) {
    assert.match(helper, /Safe-UIAutomation\.ps1/);
    assert.doesNotMatch(helper, /System\.Windows\.Forms|SendKeys|SetFocus\(|LegacyIAccessiblePattern|DoDefaultAction/);
  }
  assert.match(helpers[3], /Urls\s*=\s*@\(\$verificationUri\.AbsoluteUri\)/);
  assert.match(helpers[3], /UserDataDirOverride\s*=\s*\$profilePath/);
});

test("原生预热规则使用被动等待或离屏签到且最长检查两分钟", async () => {
  const publicRules = JSON.parse(await fs.readFile(path.join(root, "config", "site-rules.public.json"), "utf8"));
  const preflightScript = await fs.readFile(path.join(root, "scripts", "Prepare-NativeWafSession.ps1"), "utf8");
  const inspector = await fs.readFile(path.join(root, "src", "native-browser-inspect.mjs"), "utf8");
  const plainWaf = await fs.readFile(path.join(root, "scripts", "Invoke-PlainWafAccessibility.ps1"), "utf8");
  const safeAutomation = await fs.readFile(path.join(root, "scripts", "Safe-UIAutomation.ps1"), "utf8");
  const openChrome = await fs.readFile(path.join(root, "scripts", "Open-PlainLoginChrome.ps1"), "utf8");
  const browser = await fs.readFile(path.join(root, "src", "browser.mjs"), "utf8");

  assert.deepEqual(publicRules.nativeWafPreflightUrls, [
    { url: "https://piggo.me/attendance.php", waitSeconds: 120, passiveOnly: true, trustAsSigned: false, automationUserDataDir: "data/sites/piggo/chrome-user-data" },
    { url: "https://www.hdkyl.in/attendance.php", waitSeconds: 90, passiveOnly: true, trustAsSigned: false, windowMode: "minimized" },
    { url: "https://ubits.club/attendance.php", waitSeconds: 120, passiveOnly: true },
  ]);
  assert.deepEqual(publicRules.nativeChallengePreflight.slice(0, 2), [
    { url: "https://audiences.me/attendance.php", waitSeconds: 90, action: "checkin" },
    { url: "https://ourbits.club/attendance.php", waitSeconds: 120, action: "checkin" },
  ]);
  assert.match(preflightScript, /passiveOnly[\s\S]*Invoke-PlainWafAccessibility\.ps1[\s\S]*-AllowPreparedSiteBody/);
  assert.match(preflightScript, /passiveOnly[\s\S]*\$passiveInspection\.status/);
  assert.match(preflightScript, /windowMode/);
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
  assert.match(preflightScript, /\$windowMode\s*=\s*if\s*\(\$_\.windowMode\)[\s\S]*?'offscreen'/);
  assert.match(preflightScript, /windowMode\s*=\s*\$windowMode/);
  assert.match(preflightScript, /\$inspectionMode \(\[int\]\$item\.reloadOnChallengeAfterSeconds\)/);
  assert.match(inspector, /challengeReloaded/);
  assert.match(inspector, /page\.reload\(/);
  assert.match(plainWaf, /Open-PlainLoginChrome\.ps1'\) @openParameters/);
  assert.match(plainWaf, /Offscreen\s*=\s*\$true/);
  assert.match(plainWaf, /Minimized\s*=\s*\$true/);
  assert.match(plainWaf, /DisableExtensions\s*=\s*\$true/);
  assert.match(plainWaf, /UserDataDirOverride\s*=\s*\$profilePath/);
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
  assert.match(plainWaf, /Invoke-SafeAutomationControl/);
  assert.match(safeAutomation, /InvokePattern/);
  assert.match(safeAutomation, /TogglePattern/);
  assert.match(safeAutomation, /SelectionItemPattern/);
  assert.doesNotMatch(safeAutomation, /System\.Windows\.Forms|SendKeys|SetFocus\(|LegacyIAccessiblePattern|DoDefaultAction/);
  assert.match(plainWaf, /客户端异常\.\*确认\.\*合法用户/);
  assert.match(plainWaf, /confirmationClickAttempted/);
  assert.match(plainWaf, /confirmationClicked/);
  assert.match(plainWaf, /cloudflareWaf/);
  assert.match(plainWaf, /AllowPreparedSiteBody/);
  assert.match(plainWaf, /AllowCloudflareChallengeClick/);
  assert.match(plainWaf, /ValidateSet\('offscreen', 'minimized', 'visible'\)/);
  assert.match(plainWaf, /WindowMode/);
  assert.match(plainWaf, /function Invoke-CloudflareChallengeClick/);
  assert.match(plainWaf, /请验证您是真人/);
  assert.match(plainWaf, /cloudflareChallengeClicked/);
  assert.match(preflightScript, /autoClickTurnstileOrigins/);
  assert.match(preflightScript, /-AllowCloudflareChallengeClick/);
  assert.match(preflightScript, /function Clear-StaleAutomationChrome/);
  assert.match(preflightScript, /Get-Date\)\.AddMinutes\(-5\)/);
  assert.match(preflightScript, /Resolve-NativeProfilePath/);
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

test("原生 WAF 与凭据回退使用命名参数，避免 PowerShell 数组错位", async () => {
  const waf = await fs.readFile(new URL("../scripts/Invoke-PlainWafAccessibility.ps1", import.meta.url), "utf8");
  const credential = await fs.readFile(new URL("../scripts/Plain-CredentialLoginAccessibility.ps1", import.meta.url), "utf8");
  for (const source of [waf, credential]) {
    assert.match(source, /\$openParameters\s*=\s*@\{/);
    assert.match(source, /Open-PlainLoginChrome\.ps1'\)\s+@openParameters/);
    assert.doesNotMatch(source, /\$openArguments\s*=\s*@\([\s\S]{0,300}Open-PlainLoginChrome/);
  }
  assert.match(waf, /DisableExtensions\s*=\s*\$true/);
  assert.match(waf, /UserDataDirOverride\s*=\s*\$profilePath/);
  assert.match(credential, /Urls\s*=\s*@\(\$loginUri\.AbsoluteUri\)/);
});

test("原生预热保留 2FA 终态且专属 Profile 不落入调试恢复", async () => {
  const plainWaf = await fs.readFile(new URL("../scripts/Invoke-PlainWafAccessibility.ps1", import.meta.url), "utf8");
  const mainChrome = await fs.readFile(new URL("../scripts/Invoke-MainChromeCheckinAccessibility.ps1", import.meta.url), "utf8");
  const protectedLogin = await fs.readFile(new URL("../scripts/Recover-ProtectedLogin.ps1", import.meta.url), "utf8");
  const preflight = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  const indexSource = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  for (const source of [plainWaf, mainChrome]) {
    assert.match(source, /failureCode\s*=\s*'two_factor_required'/);
    assert.match(source, /status\s*=\s*'needs_attention'/);
  }
  assert.doesNotMatch(mainChrome, /二級驗證碼\|验证码\|驗證碼/);
  assert.match(preflight, /Test-TwoFactorResult/);
  assert.match(preflight, /trusted_device_initialization/);
  assert.match(indexSource, /requiresTrustedDeviceInitialization\(preflight\)/);
  assert.doesNotMatch(indexSource, /preflight\?\.(?:status|inspectionStatus) === "needs_attention"/);
  assert.match(indexSource, /if \(!nativeWafOrigins\.has\(current\.origin\)\)/);
  assert.match(indexSource, /method: "protected_credential"[\s\S]{0,700}nativeRecoveryProfile \? \["-UserDataDirOverride", nativeRecoveryProfile\] : \[\]/);
  assert.match(protectedLogin, /\[string\]\$UserDataDirOverride/);
  assert.match(protectedLogin, /StartsWith\(\$dataPrefix, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.doesNotMatch(protectedLogin, /nativeWafPreflightUrls|nativeChallengePreflight/);
  assert.match(protectedLogin, /-AutomationUserDataDirOverride \$profilePath/);
  assert.match(protectedLogin, /-UserDataDirOverride \$profilePath/);
  assert.doesNotMatch(protectedLogin, /\$config\.automationUserDataDir\)\*/);
});

test("主 Chrome 回退严格限制白名单并只关闭任务创建的窗口", async () => {
  const helper = await fs.readFile(path.join(root, "scripts", "Invoke-MainChromeCheckinAccessibility.ps1"), "utf8");
  const preflight = await fs.readFile(path.join(root, "scripts", "Prepare-NativeWafSession.ps1"), "utf8");
  const indexSource = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  const defaults = JSON.parse(await fs.readFile(path.join(root, "config", "defaults.json"), "utf8"));

  assert.deepEqual(defaults.mainChromeFallbackUrls, []);
  assert.match(helper, /mainChromeFallbackUrls/);
  assert.match(helper, /不在明确白名单中/);
  assert.match(helper, /\$beforeHandles/);
  assert.match(helper, /-not \$beforeHandles\.ContainsKey/);
  assert.match(helper, /\$targetWindows/);
  assert.doesNotMatch(helper, /elseif\s*\(\$newWindows\.Count -eq 1\)/);
  assert.match(helper, /window_not_created/);
  assert.match(helper, /target_not_loaded/);
  assert.match(helper, /window_merged/);
  assert.match(helper, /accessibility_unavailable/);
  assert.match(helper, /function Close-TaskWindow/);
  assert.match(helper, /WindowPattern/);
  assert.doesNotMatch(helper, /Stop-Process|Kill\(/);
  assert.doesNotMatch(helper, /RemoteDebuggingPort|remote-debugging-port/);
  assert.doesNotMatch(helper, /--window-position=-32000,-32000/);
  assert.match(helper, /ShowWindow\(\$taskHandle, 6\)/);
  assert.match(helper, /SetWindowPos\(\$handle, \[IntPtr\]::Zero, 80, 80, 1400, 900/);
  assert.match(helper, /签到成功\|今日已签到\|今天已签到/);
  assert.match(helper, /\$topMatches\.Count -ne 1/);
  for (const forbidden of [
    /System\.Windows\.Forms/,
    /SetForegroundWindow/,
    /keybd_event/,
    /SendKeys/,
    /Send-VirtualKey/,
    /Get-LoginEditControls/,
    /Get-UniqueLoginButton/,
    /Invoke-SavedLoginSelection/,
    /LegacyIAccessiblePattern|DoDefaultAction/,
    /savedLoginAllowed|savedLoginAttempted|savedLoginSubmitted|savedLoginDiagnostics/,
  ]) assert.doesNotMatch(helper, forbidden);
  assert.doesNotMatch(helper, /SetValue\(|\.fill\(|password\s*=/i);
  assert.match(preflight, /Invoke-MainChromeCheckinAccessibility\.ps1/);
  assert.match(preflight, /\$fallbackAttempt -le 2/);
  assert.match(preflight, /failureCode/);
  assert.match(preflight, /mainChromeFallbackOnly/);
  assert.match(indexSource, /config\.mainChromeFallbackUrls/);
  assert.match(indexSource, /value\?\.sourceOrigin \?\? new URL\(value\?\.url\)\.origin/);
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
