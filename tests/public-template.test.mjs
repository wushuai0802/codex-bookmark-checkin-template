import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const powershell = process.platform === "win32" ? "pwsh.exe" : "pwsh";

test("公开默认配置不启用外部通知", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  assert.equal(defaults.notification.mode, "none");
  assert.equal(defaults.notification.executable, "");
  assert.equal(defaults.syncBookmarkSavedLogins, false);
  assert.equal(defaults.syncAccountSavedLoginsToLocalStore, true);
  assert.deepEqual(defaults.syncSavedLoginOrigins, []);
  assert.equal(defaults.qaWebSearchEnabled, false);
  assert.equal(defaults.disableOptimizationGuideOnDeviceModel, true);
  assert.deepEqual(defaults.configuredTargets, []);
  assert.deepEqual(defaults.disabledCheckinOrigins, []);
  assert.deepEqual(defaults.loginAsCheckinOrigins, []);
  assert.deepEqual(defaults.newApiCaptchaRules, {});
  assert.deepEqual(defaults.newApiSignInRules, {});
  assert.deepEqual(defaults.oauthReloginCheckinRules, {});
});

test("CI 使用最小权限、固定 Action 提交并扫描 Git 历史", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /permissions:\s*\r?\n\s+contents:\s*read/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.match(workflow, /gitleaks_\$\{version\}_windows_x64\.zip/);
  assert.match(workflow, /Get-FileHash -Algorithm SHA256/);
  assert.match(workflow, /gitleaks git --config \.gitleaks\.toml --redact --no-banner --exit-code 1/);
  assert.match(workflow, /fetch-depth:\s*0/);
});

test("简直了使用个人中心和有界图片验证码签到规则", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  assert.equal(rules.extendedDiscoveryOrigins.includes("https://jianzhile.vip"), true);
  assert.equal(rules.newApiCheckinOrigins.includes("https://jianzhile.vip"), true);
  assert.deepEqual(rules.newApiCaptchaRules["https://jianzhile.vip"], {
    checkinPath: "/api/user/checkin",
    captchaPath: "/api/user/checkin/captcha",
    maxAttempts: 6,
  });
});

test("AnyRouter 使用真实 sign_in 接口且不再以访问页面判成功", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const anyRouter = rules.newApiSignInRules["https://anyrouter.top"];
  assert.equal(rules.visitCheckinRules["https://anyrouter.top"], undefined);
  assert.equal(anyRouter.signInPath, "/api/user/sign_in");
  assert.equal(anyRouter.selfPath, "/api/user/self");
  assert.equal(anyRouter.logPath, "/api/log/self");
  assert.equal(anyRouter.logType, 4);
  assert.equal(anyRouter.rewardAmount, 25);
  assert.equal(anyRouter.emptySuccessMeansAlreadySigned, true);
  assert.match(anyRouter.responseSuccessText, /签到成功/);
  assert.match(anyRouter.logSuccessText, /每日签到成功/);
});

test("AgentRouter 重新 OAuth 后只以当日额度日志确认成功", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const agentRouter = rules.oauthReloginCheckinRules["https://agentrouter.org"];
  assert.equal(rules.loginAsCheckinOrigins.includes("https://agentrouter.org"), false);
  assert.equal(rules.automaticOAuthProviders["https://agentrouter.org"], "LinuxDO");
  assert.equal(rules.oauthLoginUrls["https://agentrouter.org"], "https://agentrouter.org/login");
  assert.equal(rules.extendedDiscoveryOrigins.includes("https://new.bxacc.xyz"), true);
  assert.equal(rules.automaticOAuthProviders["https://new.bxacc.xyz"], "LinuxDO");
  assert.equal(rules.oauthLoginUrls["https://new.bxacc.xyz"], "https://new.bxacc.xyz/sign-in");
  assert.deepEqual(
    rules.nativeChallengePreflight.find((entry) => entry.url === "https://new.bxacc.xyz/profile"),
    { url: "https://new.bxacc.xyz/profile", waitSeconds: 120, action: "checkin" },
  );
  const browser = await fs.readFile(new URL("../src/browser.mjs", import.meta.url), "utf8");
  assert.match(browser, /\(\?:用户\\s\*\)\?ID\\s\*\[:：\]\?\\s\*\(\\d\+\)/);
  assert.match(browser, /const discoveredApiResult = await tryNewApiCheckin\(page\)/);
  assert.equal(agentRouter.forceLogout, true);
  assert.equal(agentRouter.nativeBrowser, true);
  assert.equal(agentRouter.logoutPath, "/api/user/logout");
  assert.equal(agentRouter.logPath, "/api/log/self");
  assert.equal(agentRouter.logType, 4);
  assert.equal(agentRouter.rewardAmount, 25);
  assert.match(agentRouter.successText, /每日签到成功/);
});

test("AgentRouter 原生 OAuth 恢复不接触或输出浏览器凭据", async () => {
  const runner = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  const nativeOAuth = await fs.readFile(new URL("../src/native-oauth-login.mjs", import.meta.url), "utf8");
  const nativeCdp = await fs.readFile(new URL("../src/native-cdp.mjs", import.meta.url), "utf8");
  const recovery = await fs.readFile(new URL("../scripts/Recover-NativeOAuthLogin.ps1", import.meta.url), "utf8");
  assert.match(runner, /native_oauth/);
  assert.match(runner, /Recover-NativeOAuthLogin\.ps1/);
  assert.match(nativeOAuth, /connectOverCdpWithRetry/);
  assert.match(nativeCdp, /connectOverCDP/);
  assert.match(nativeOAuth, /tryOAuthReloginCheckinStatus/);
  assert.match(nativeOAuth, /session cookie|callback evidence is optional/i);
  assert.doesNotMatch(nativeOAuth, /document\.cookie|cookies\(|storageState/);
  assert.match(recovery, /AutomationUserDataDir/i);
  assert.match(recovery, /Open-PlainLoginChrome\.ps1/);
});

test("AgentRouter 当天已有奖励日志时不会重复退出并触发 OAuth", async () => {
  const nativeOAuth = await fs.readFile(new URL("../src/native-oauth-login.mjs", import.meta.url), "utf8");
  const reuseCheck = nativeOAuth.indexOf("const existingDailyCheckin");
  const forcedLogout = nativeOAuth.indexOf("forceConfiguredOAuthLogout(page");
  assert.ok(reuseCheck >= 0);
  assert.ok(forcedLogout > reuseCheck);
  assert.match(nativeOAuth, /reusedExistingDailyEvidence:\s*true/);
  assert.match(nativeOAuth, /\["signed", "already_signed"\]\.includes\(existingDailyCheckin\?\.status\)/);
});

test("AgentRouter PowerShell 恢复链固定使用 UTF-8 传递 JSON", async () => {
  const recovery = await fs.readFile(new URL("../scripts/Recover-NativeOAuthLogin.ps1", import.meta.url), "utf8");
  assert.match(recovery, /\$OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.match(recovery, /\[Console\]::OutputEncoding\s*=\s*\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
});

test("首次运行原生预热必须使用已校验书签范围", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  const preflight = await fs.readFile(new URL("../scripts/Prepare-NativeWafSession.ps1", import.meta.url), "utf8");
  assert.match(runner, /--preflight-origins/);
  assert.match(runner, /Prepare-NativeWafSession\.ps1'\) -Origins \$preflightOrigins/);
  assert.doesNotMatch(runner, /Prepare-NativeWafSession\.ps1'\)\s*\}\s*$/m);
  assert.match(preflight, /必须显式传入非空 -Origins/);
  assert.match(preflight, /\[switch\]\$AllConfigured/);
});

test("保存密码同步必须经过显式总开关授权", async () => {
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  assert.match(runner, /syncBookmarkSavedLogins -eq \$true/);
  assert.doesNotMatch(runner, /syncSavedLoginOrigins\)\.Count -gt 0 -or/);
  assert.match(runner, /try\s*\{[\s\S]*Sync-ChromeSavedLogins\.ps1'[\s\S]*\}\s*catch\s*\{/);
  assert.match(runner, /保存密码同步未完成，继续使用现有机器人会话/);
});

test("机器人 Chrome 缓存清理有目录边界和会话数据保护", async () => {
  const cleaner = await fs.readFile(new URL("../scripts/Clear-AutomationChromeCache.ps1", import.meta.url), "utf8");
  assert.match(cleaner, /Join-Path \$root 'data'/);
  assert.match(cleaner, /机器人 Chrome 正在运行/);
  assert.match(cleaner, /\[switch\]\$Apply/);
  assert.match(cleaner, /FileAttributes\]::ReparsePoint/);
  assert.match(cleaner, /Assert-NoReparsePointInPath \$profileRoot \$allowedParent/);
  assert.match(cleaner, /Assert-NoReparsePointTree \$target/);
  for (const protectedName of ["Cookies", "Local Storage", "Session Storage", "IndexedDB", "Service Worker", "Login Data"]) {
    assert.match(cleaner, new RegExp(protectedName.replace(" ", "\\s")));
  }
  assert.doesNotMatch(cleaner, /Remove-Item\s+-LiteralPath\s+\$profileRoot\b/);
});

test("wrapper 覆盖前置步骤并且只在子进程退出后清理运行锁", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const runner = await fs.readFile(new URL("../scripts/Run-Checkin.ps1", import.meta.url), "utf8");
  assert.match(defaults.runMutexName, /^Local\\/);
  assert.match(runner, /WaitOne\(0\)/);
  assert.match(runner, /AbandonedMutexException/);
  assert.match(runner, /\$processExited\s*=\s*\$process\.WaitForExit\(10000\)/);
  assert.match(runner, /if \(-not \$processExited\)[\s\S]*?保留运行锁/);
  assert.match(runner, /Remove-RunLockOwnedByProcess/);
});

test("用户级调度器包含独立守护并在健康检查中验证三层进程", async () => {
  const installer = await fs.readFile(new URL("../scripts/Install-UserScheduler.ps1", import.meta.url), "utf8");
  const remover = await fs.readFile(new URL("../scripts/Remove-UserScheduler.ps1", import.meta.url), "utf8");
  const health = await fs.readFile(new URL("../scripts/Test-CheckinHealth.ps1", import.meta.url), "utf8");
  const scheduler = await fs.readFile(new URL("../scripts/Start-UserScheduler.ps1", import.meta.url), "utf8");
  const supervisor = await fs.readFile(new URL("../scripts/UserSchedulerSupervisor.vbs", import.meta.url), "utf8");
  assert.match(installer, /UserSchedulerSupervisor\.vbs/);
  assert.match(installer, /wscript\.exe/);
  assert.match(installer, /if \(-not \(Test-Path -LiteralPath \$runKey\)\)/);
  assert.doesNotMatch(installer, /New-Item -Path \$runKey -Force/);
  assert.match(installer, /CreateShortcut\(\$startupShortcutPath\)/);
  assert.match(installer, /primary/);
  assert.match(installer, /fallback/);
  assert.match(remover, /UserSchedulerSupervisor\.vbs/);
  assert.match(remover, /startupShortcutPath/);
  assert.match(health, /supervisorProcessCount/);
  assert.match(health, /\$supervisorCount -eq 1/);
  assert.match(health, /latestRunToday/);
  assert.match(health, /runState\s+-eq\s+'final'/);
  assert.match(health, /processedTotal\s+-ge\s+\$plannedTotal/);
  assert.match(health, /latestMatchesCurrentPlan/);
  assert.match(health, /currentPlannedTotal/);
  assert.match(health, /latestPlannedTotal/);
  assert.match(health, /Compare-Object -ReferenceObject \$currentPlanIdentities -DifferenceObject \$latestPlanIdentities/);
  assert.match(health, /schedulerStartupShortcutPresent/);
  assert.match(health, /schemaVersion\s*=\s*1/);
  assert.match(health, /failedChecks/);
  assert.match(health, /if \(-not \$healthy\) \{ exit 2 \}/);
  assert.match(supervisor, /WatchdogIsRunning/);
  assert.match(supervisor, /WScript\.Arguments/);
  assert.match(supervisor, /launchRole = "fallback"/);
  assert.match(supervisor, /If WatchdogIsRunning\(\) Then WScript\.Quit 0/);
  assert.match(scheduler, /Get-LatestReportState \$now \$config/);
  assert.match(scheduler, /\$hasNewExternalReport = \$latestReportState\.Valid/);
  assert.match(scheduler, /\[string\]\$state\.lastRunId -ne \[string\]\$latestReportState\.RunId/);
  assert.match(scheduler, /\[datetimeoffset\]\$_\.nextEligibleAt/);
  assert.match(scheduler, /\[datetimeoffset\]\$reportState\.NextEligibleAt\)\.ToLocalTime\(\)\.ToString\('o'\)/);
  assert.match(scheduler, /已接收外部续跑报告/);
});

test("公开健康检查提供稳定的只读调用入口", async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const readme = await fs.readFile(new URL("../README.md", import.meta.url), "utf8");
  const health = await fs.readFile(new URL("../scripts/Test-CheckinHealth.ps1", import.meta.url), "utf8");

  assert.equal(packageJson.scripts.health, "pwsh -NoProfile -File scripts/Test-CheckinHealth.ps1");
  assert.match(readme, /npm run --silent health/);
  assert.match(readme, /不会启动签到、修改配置或发送通知/);
  assert.match(readme, /退出码为 `2`/);
  assert.match(readme, /退出码为 `3`/);
  assert.match(health, /reason = 'health_check_error'/);
  assert.doesNotMatch(health, /Run-Checkin\.ps1|Start-Process/);
});

test("非 Git 安全扫描忽略依赖环境和本地运行数据", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "bookmark-safety-scan-"));
  try {
    await fs.mkdir(path.join(sandbox, "scripts"), { recursive: true });
    await fs.copyFile(new URL("../scripts/Scan-PublicSafety.ps1", import.meta.url), path.join(sandbox, "scripts", "Scan-PublicSafety.ps1"));
    await fs.writeFile(path.join(sandbox, "README.md"), "public template fixture", "utf8");
    for (const relative of [
      ".venv/private.txt",
      "venv/private.txt",
      "data/private.txt",
      "logs/private.txt",
      "inputs/private.txt",
      "src/__pycache__/private.txt",
      ".pytest_cache/private.txt",
      ".env/private.txt",
      "progress.md",
      "scripts/Install-CaptchaOcr.ps1",
      "scripts/Invoke-CheckinReportOutbox.ps1",
    ]) {
      const target = path.join(sandbox, ...relative.split("/"));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "C:\\Users\\private-user private" + "@" + "example.net", "utf8");
    }
    const { stdout } = await execFileAsync(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.join(sandbox, "scripts", "Scan-PublicSafety.ps1"),
    ], { cwd: sandbox, encoding: "utf8" });
    const report = JSON.parse(stdout.trim());
    assert.equal(report.safe, true);
    assert.equal(report.scannedFiles, 2);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("安装配置优先使用 PowerShell 7，5.1 仅作为可用回退", async () => {
  const setup = await fs.readFile(new URL("../src/setup-config.mjs", import.meta.url), "utf8");
  const preflight = await fs.readFile(new URL("../scripts/Test-Environment.ps1", import.meta.url), "utf8");
  assert.match(setup, /findOnPath\("pwsh\.exe"\)/);
  assert.match(setup, /answers\.powershellExecutable \|\| preferredPowerShell/);
  assert.match(preflight, /--scope-json-base64/);
});

test("OAuth 恢复可以展开其他登录选项并关闭 LinuxDO 遮罩", async () => {
  const oauth = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(oauth, /其他登录选项/);
  assert.match(oauth, /revealAlternateLoginOptions/);
  assert.match(oauth, /getByRole\("button"\)\.filter\(\{ hasText: label \}\)/);
  assert.match(oauth, /button\.modal-close\[title="关闭"\]/);
  assert.match(oauth, /session\\\/sso_provider/);
});

test("公开模板不预设任何用户的书签文件夹名称", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const answers = JSON.parse(await fs.readFile(new URL("../setup/answers.example.json", import.meta.url), "utf8"));
  const questions = JSON.parse(await fs.readFile(new URL("../setup/questions.json", import.meta.url), "utf8"));
  assert.deepEqual(defaults.mobileFolderNames, []);
  assert.deepEqual(defaults.targetFolderNames, []);
  assert.deepEqual(answers.mobileFolderNames, []);
  assert.deepEqual(answers.targetFolderNames, []);
  const scope = questions.groups.find((group) => group.id === "bookmark_scope");
  assert.deepEqual(scope.askBefore, ["automation_policy", "notification"]);

  const bookmarksSource = await fs.readFile(new URL("../src/bookmarks.mjs", import.meta.url), "utf8");
  const browserSource = await fs.readFile(new URL("../src/browser.mjs", import.meta.url), "utf8");
  const runnerSource = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(bookmarksSource, /options\.mobileFolderNames\s*\?\?\s*\[\s*["']移动设备书签/);
  assert.doesNotMatch(bookmarksSource, /options\.targetFolderNames\s*\?\?\s*\[\s*["']签到/);
  assert.doesNotMatch(browserSource, /folderNames\.includes\(["']公益站["']\)/);
  assert.doesNotMatch(runnerSource, /folderNames\.includes\(["']公益站["']\)/);
});

test("公开站点规则只包含无凭据 HTTPS URL", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(rules);
  assert.doesNotMatch(serialized, /(?:password|passwd|cookie|access_token|authorization)[=:]/i);
  const collectStrings = (value) => typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectStrings(nested)])
        : [];
  for (const value of collectStrings(rules).filter((item) => item.startsWith("http"))) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
});

test("本机配置、结果和凭据目录被 Git 忽略", async () => {
  const ignore = await fs.readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of ["config/config.json", "config/config.local.json", "setup/answers.json", "data/", "logs/*", "tmp/*"]) {
    assert.match(ignore, new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});

test("DPAPI 凭据恢复默认关闭且强制同源验证", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const loginSource = await fs.readFile(new URL("../src/credential-login.mjs", import.meta.url), "utf8");
  const setter = await fs.readFile(new URL("../scripts/Set-ProtectedSiteCredential.ps1", import.meta.url), "utf8");
  const recovery = await fs.readFile(new URL("../scripts/Recover-ProtectedLogin.ps1", import.meta.url), "utf8");

  assert.deepEqual(defaults.protectedCredentialOrigins, []);
  assert.deepEqual(defaults.protectedLoginVerificationPaths, {});
  assert.match(loginSource, /new URL\(loginUrl\)\.origin !== origin/);
  assert.match(loginSource, /verificationUrl\.origin !== origin/);
  assert.match(setter, /ConvertFrom-SecureString/);
  assert.match(recovery, /RedirectStandardInput = \$true/);
  assert.doesNotMatch(recovery, /ArgumentList\.Add\(\$passwordPlain\)/);
});
