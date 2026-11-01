# 模块状态（只标记，不移动）

重新生成：在仓库根运行 `node tools/module-reachability.mjs`，将标准输出保存为本文件；用 `node tools/module-reachability.mjs --check` 校验，用 `--json` 查看逐边、npm 脚本及发布映射。脚本本身只读，不执行被分析代码、不读取运行根或私有配置。

范围：两个包的 `src/`、`scripts/`、`public/` 全部普通文件。现役表示从受管生产入口在文本调用图中可达，包含条件分支，不表示现场启用；npm 的诊断/演练命令作为人工入口，`--check` 不构成运行依赖。发布清单只证明文件被分发，不能把整个清单视为现役。

路径角色依据 `docs/architecture.md`：legacy/执行根映射 `execution/`，控制/观测及兼容 operations 根映射 `observation/`，`plan.source` 为仓库根。变量传播只处理有界字面量、路径拼接、URL 包装和条件分支；无法求值或仓库外钩子逐项保留。新增未知文件默认待确认。历史分类是退役审查依据，不授权迁移或删除。

| 类别 | 文件数 |
| --- | ---: |
| 现役 | 226 |
| 运维手动 | 65 |
| 历史审计 | 4 |
| 待确认 | 47 |

## 四个基准模块核对

| 模块 | 当前判定 | 核对依据 |
| --- | --- | --- |
| `scheduler.mjs` | 待确认 | 当前文本仅见测试和 lint:domain 语法检查，生产调用待核实，暂不迁移。 |
| `notification-delivery.mjs` | 运维手动 | observation/src/v2-notification-flush.mjs:5 (esm-static) |
| `runtime-config.mjs` | 现役 | observation/scripts/run-v1-engine.mjs:5 (esm-static) |
| `shadow-acceptance.mjs` | 现役 | observation/src/dashboard-server.mjs:12 (esm-static) |

这四个模块名字看着旧，过去的记录把它们都当作现役。当前 scheduler 仅见测试和语法检查，notification-delivery 可由 npm 人工通知刷新命令到达，未找到两者的生产调用链。不把它们强行标为现役，也不建议迁移。

## 生产入口

- `execution/scripts/Run-HiddenPowerShell.vbs`：生产入口（架构调用链）
- `execution/scripts/Start-UserScheduler.ps1`：生产入口（架构调用链）
- `observation/scripts/Start-NasShadowScheduler.ps1`：生产入口（架构调用链）
- `observation/scripts/run-v1-engine.mjs`：生产入口（架构调用链）
- `observation/src/legacy-engine.mjs`：生产入口（架构调用链）
- `observation/src/dashboard-server.mjs`：npm 生产脚本 observation/package.json:dashboard
- `tools/doctor.mjs`：发布/体检映射入口
- `tools/nas-runtime.mjs`：发布/体检映射入口
- `tools/release-gate.mjs`：发布/体检映射入口
- `tools/release-lib.mjs`：发布/体检映射入口
- `tools/release-runtime.mjs`：发布/体检映射入口
- `tools/release.mjs`：发布/体检映射入口
- `execution/src/index.mjs`：npm 生产脚本 execution/package.json:start
- `observation/src/bridge.mjs`：npm 生产脚本 observation/package.json:bridge
- `observation/src/shadow-run.mjs`：npm 生产脚本 observation/package.json:shadow

## 逐文件分类

| 文件 | 类别 | 依据 |
| --- | --- | --- |
| `execution/scripts/Backup-Sqlite.py` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/CheckinContract.generated.ps1` | 现役 | execution/scripts/ResultContract.ps1:1 (ps-call) |
| `execution/scripts/Cleanup-NativePtRead.ps1` | 现役 | execution/src/native-pt-read.mjs:105 (node-path) |
| `execution/scripts/Cleanup-PtWorker.ps1` | 现役 | observation/src/pt-worker-lifecycle.mjs:43 (node-path) |
| `execution/scripts/Clear-AutomationChromeCache.ps1` | 运维手动 | 人工用法见 execution/README.md |
| `execution/scripts/Clear-StalePrivateTemp.ps1` | 现役 | execution/scripts/Run-Checkin.ps1:144 (ps-call) |
| `execution/scripts/Close-ManualLogin.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Ensure-UserScheduler.ps1` | 现役 | execution/scripts/Test-CheckinHealth.ps1:55 (ps-join) |
| `execution/scripts/Export-PublicBundle.ps1` | 运维手动 | 人工用法见 execution/README.md |
| `execution/scripts/Extract-ChromeSessionStorage.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Gateway-Audit.ps1` | 现役 | execution/scripts/V2-EngineGateway.ps1:5 (ps-call) |
| `execution/scripts/Get-BitwardenTotp.ps1` | 现役 | execution/src/bitwarden-totp.mjs:122 (node-path) |
| `execution/scripts/HealthReportClassification.ps1` | 现役 | execution/scripts/Test-CheckinHealth.ps1:20 (ps-call) |
| `execution/scripts/Initialize-BrowserProfile.ps1` | 运维手动 | 人工用法见 docs/quickstart.md |
| `execution/scripts/Initialize-BrowserProfileFromShadow.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Initialize-Checkin.ps1` | 运维手动 | 人工用法见 execution/skills/deploy-bookmark-checkin/SKILL.md |
| `execution/scripts/Install-CaptchaOcr.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Install-ScheduledTask.ps1` | 运维手动 | 人工用法见 docs/quickstart.md |
| `execution/scripts/Install-UserScheduler.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Invoke-BoundedCommand.ps1` | 现役 | execution/scripts/Invoke-CheckinNotificationOutbox.ps1:109 (ps-call) |
| `execution/scripts/Invoke-CheckinNotificationOutbox.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:18 (ps-join) |
| `execution/scripts/Invoke-CheckinReportOutbox.ps1` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Invoke-MainChromeCheckinAccessibility.ps1` | 现役 | execution/src/native-pt-read.mjs:189 (node-path) |
| `execution/scripts/Invoke-NpmAuditWithRetry.ps1` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Invoke-PlainOAuthAccessibility.ps1` | 现役 | execution/scripts/Recover-NativeOAuthLogin.ps1:211 (ps-call) |
| `execution/scripts/Invoke-PlainSavedPasswordAccessibility.ps1` | 现役 | execution/src/index.mjs:841 (node-path) |
| `execution/scripts/Invoke-PlainWafAccessibility.ps1` | 现役 | execution/src/native-pt-read.mjs:189 (node-path) |
| `execution/scripts/Manage-BitwardenTotp.ps1` | 运维手动 | 人工用法见 execution/docs/bitwarden-totp.md |
| `execution/scripts/Native-ChromeDebug.ps1` | 现役 | execution/scripts/Recover-NativeLogin.ps1:13 (ps-call) |
| `execution/scripts/Native-PtChromeProxy.ps1` | 现役 | execution/scripts/Invoke-MainChromeCheckinAccessibility.ps1:99 (ps-call) |
| `execution/scripts/Native-PtGate.mjs` | 现役 | execution/scripts/Native-PtGuard.ps1:4 (ps-join) |
| `execution/scripts/Native-PtGuard.ps1` | 现役 | execution/scripts/Prepare-NativeWafSession.ps1:83 (ps-call) |
| `execution/scripts/Notification-Digest.ps1` | 现役 | execution/scripts/Submit-UnifiedCheckinReport.ps1:408 (ps-call) |
| `execution/scripts/OAuth-AccountConfig.ps1` | 现役 | execution/scripts/Recover-NativeOAuthLogin.ps1:19 (ps-call) |
| `execution/scripts/Open-ManualLogin.ps1` | 运维手动 | 人工用法见 docs/quickstart.md |
| `execution/scripts/Open-OAuthAccountLogin.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Open-PlainLoginChrome.ps1` | 现役 | execution/scripts/Recover-NativeLogin.ps1:44 (ps-call) |
| `execution/scripts/Plain-CredentialLoginAccessibility.ps1` | 现役 | execution/scripts/Recover-ProtectedLogin.ps1:136 (ps-call) |
| `execution/scripts/Prepare-NativeWafSession.ps1` | 现役 | execution/scripts/Run-Checkin.ps1:289 (ps-call) |
| `execution/scripts/Protect-PrivateRuntime.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Read-NativePtHeader.mjs` | 现役 | execution/scripts/Prepare-NativeWafSession.ps1:307 (ps-join) |
| `execution/scripts/Recover-NativeLogin.ps1` | 现役 | execution/src/index.mjs:779 (node-path) |
| `execution/scripts/Recover-NativeOAuthLogin.ps1` | 现役 | execution/src/index.mjs:807 (node-path) |
| `execution/scripts/Recover-NativePtTwoFactor.mjs` | 现役 | execution/scripts/Prepare-NativeWafSession.ps1:540 (ps-join) |
| `execution/scripts/Recover-ProtectedLogin.ps1` | 现役 | execution/src/index.mjs:788 (node-path) |
| `execution/scripts/Remove-ScheduledTask.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Remove-UserScheduler.ps1` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `execution/scripts/Resolve-Runtime.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:11 (ps-join) |
| `execution/scripts/ResultContract.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:13 (ps-call) |
| `execution/scripts/ResultIdentity.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:12 (ps-call) |
| `execution/scripts/Run-Checkin.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:638 (ps-join) |
| `execution/scripts/Run-HiddenPowerShell.vbs` | 现役 | 生产入口（架构调用链） |
| `execution/scripts/Run-NativePtApiCheckin.mjs` | 现役 | execution/scripts/Prepare-NativeWafSession.ps1:747 (ps-join) |
| `execution/scripts/Run-PtSupplement.mjs` | 现役 | observation/src/pt-site-execution.mjs:64 (node-path) |
| `execution/scripts/RunLock.ps1` | 现役 | execution/scripts/Run-Checkin.ps1:21 (ps-call) |
| `execution/scripts/Safe-UIAutomation.ps1` | 现役 | execution/scripts/Invoke-PlainSavedPasswordAccessibility.ps1:30 (ps-call) |
| `execution/scripts/Scan-PublicSafety.ps1` | 运维手动 | 人工用法见 execution/README.md |
| `execution/scripts/Set-ProtectedSiteCredential.ps1` | 运维手动 | 人工用法见 execution/README.md |
| `execution/scripts/Start-UserScheduler.ps1` | 现役 | 生产入口（架构调用链） |
| `execution/scripts/Submit-UnifiedCheckinReport.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:19 (ps-join) |
| `execution/scripts/Sync-ChromeSavedLogins.ps1` | 现役 | execution/scripts/Run-Checkin.ps1:241 (ps-call) |
| `execution/scripts/Sync-ChromeSavedLogins.py` | 现役 | execution/scripts/Sync-ChromeSavedLogins.ps1:32 (ps-join) |
| `execution/scripts/Sync-ChromeSiteCookies.py` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Sync-ChromeSiteSession.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Sync-ChromeSiteSessions.ps1` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Sync-PrivateRuntime.ps1` | 运维手动 | 人工用法见 execution/README.md |
| `execution/scripts/Sync-VibeCookiesWhenChromeCloses.ps1` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/scripts/Test-CheckinHealth.ps1` | 现役 | observation/src/legacy-engine.mjs:46 (node-path) |
| `execution/scripts/Test-Environment.ps1` | 运维手动 | 人工用法见 execution/AGENTS.md |
| `execution/scripts/UserSchedulerSupervisor.vbs` | 现役 | execution/scripts/Test-CheckinHealth.ps1:56 (ps-join) |
| `execution/scripts/V2-EngineGateway.ps1` | 现役 | execution/scripts/Start-UserScheduler.ps1:6 (ps-call) |
| `execution/src/anyrouter-api-checkin.mjs` | 现役 | execution/src/browser.mjs:21 (esm-static) |
| `execution/src/attention-urls.mjs` | 现役 | execution/scripts/Open-PlainLoginChrome.ps1:52 (ps-join) |
| `execution/src/baidu-ocr.mjs` | 现役 | execution/src/browser.mjs:20 (esm-static) |
| `execution/src/bitwarden-totp.mjs` | 现役 | execution/src/native-pt-two-factor.mjs:236 (esm-dynamic) |
| `execution/src/bookmarks.mjs` | 现役 | execution/src/index.mjs:8 (esm-static) |
| `execution/src/browser.mjs` | 现役 | execution/src/index.mjs:9 (esm-static) |
| `execution/src/captcha-ocr.mjs` | 现役 | execution/src/browser.mjs:9 (esm-static) |
| `execution/src/checkin-api.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/checkin-click.mjs` | 现役 | execution/src/browser.mjs:16 (esm-static) |
| `execution/src/checkin-contract.generated.mjs` | 现役 | execution/src/browser.mjs:24 (esm-static) |
| `execution/src/colored_captcha_ocr.py` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/credential-api-login.mjs` | 现役 | execution/scripts/Recover-ProtectedLogin.ps1:124 (ps-join) |
| `execution/src/credential-login.mjs` | 现役 | execution/scripts/Recover-ProtectedLogin.ps1:154 (ps-join) |
| `execution/src/credential-session-verification.mjs` | 现役 | execution/src/credential-api-login.mjs:7 (esm-static) |
| `execution/src/current-plan.mjs` | 现役 | execution/scripts/Start-UserScheduler.ps1:542 (ps-join) |
| `execution/src/deployment-integrity.mjs` | 现役 | execution/scripts/Test-CheckinHealth.ps1:480 (ps-join) |
| `execution/src/detector.mjs` | 现役 | execution/src/browser.mjs:6 (esm-static) |
| `execution/src/google-session-choice.mjs` | 现役 | execution/src/native-oauth-login.mjs:17 (esm-static) |
| `execution/src/harvest-pt-gate.mjs` | 现役 | execution/src/index.mjs:88 (esm-static) |
| `execution/src/hddolby-native-flow.mjs` | 现役 | execution/src/native-login.mjs:39 (esm-dynamic) |
| `execution/src/hddolby-readonly.mjs` | 现役 | execution/src/browser.mjs:27 (esm-static) |
| `execution/src/hddolby-two-factor.mjs` | 现役 | execution/src/browser.mjs:28 (esm-static) |
| `execution/src/hhclub-two-factor-login.mjs` | 现役 | execution/src/saved-password-login.mjs:9 (esm-static) |
| `execution/src/index.mjs` | 现役 | npm 生产脚本 execution/package.json:start |
| `execution/src/inspect-target.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/isolated-site-profiles.mjs` | 现役 | execution/src/index.mjs:60 (esm-static) |
| `execution/src/logger.mjs` | 现役 | execution/src/index.mjs:15 (esm-static) |
| `execution/src/logical-checkin.mjs` | 现役 | execution/src/index.mjs:21 (esm-static) |
| `execution/src/login-recovery.mjs` | 现役 | execution/src/index.mjs:16 (esm-static) |
| `execution/src/login-sync-origins.mjs` | 现役 | execution/scripts/Sync-ChromeSavedLogins.ps1:9 (ps-join) |
| `execution/src/manual-session.mjs` | 运维手动 | execution/scripts/Open-ManualLogin.ps1:25 (ps-join) |
| `execution/src/native-browser-inspect.mjs` | 现役 | execution/scripts/Prepare-NativeWafSession.ps1:85 (ps-join) |
| `execution/src/native-cdp.mjs` | 现役 | execution/src/native-login.mjs:7 (esm-static) |
| `execution/src/native-credential-login.mjs` | 现役 | execution/scripts/Recover-ProtectedLogin.ps1:173 (ps-join) |
| `execution/src/native-login.mjs` | 现役 | execution/scripts/Recover-NativeLogin.ps1:48 (ps-join) |
| `execution/src/native-oauth-login.mjs` | 现役 | execution/scripts/Recover-NativeOAuthLogin.ps1:119 (ps-join) |
| `execution/src/native-preflight-receipt.mjs` | 现役 | execution/src/index.mjs:53 (esm-static) |
| `execution/src/native-preflight-result.mjs` | 现役 | execution/src/index.mjs:52 (esm-static) |
| `execution/src/native-pt-api.mjs` | 现役 | execution/src/native-pt-two-factor.mjs:7 (esm-static) |
| `execution/src/native-pt-gate.mjs` | 现役 | execution/src/native-pt-two-factor.mjs:8 (esm-static) |
| `execution/src/native-pt-read.mjs` | 现役 | execution/src/index.mjs:86 (esm-static) |
| `execution/src/native-pt-two-factor.mjs` | 现役 | execution/src/index.mjs:54 (esm-static) |
| `execution/src/native-waf-profile.mjs` | 现役 | execution/src/index.mjs:84 (esm-static) |
| `execution/src/new-api-account-checkin.mjs` | 现役 | execution/src/supplemental-oauth-accounts.mjs:7 (esm-static) |
| `execution/src/new-api-signin.mjs` | 现役 | execution/src/browser.mjs:18 (esm-static) |
| `execution/src/notification-reconciliation.mjs` | 现役 | execution/scripts/Submit-UnifiedCheckinReport.ps1:131 (ps-join) |
| `execution/src/oauth-api-checkin.mjs` | 现役 | execution/src/browser.mjs:15 (esm-static) |
| `execution/src/oauth-callback.mjs` | 现役 | execution/src/oauth-login.mjs:10 (esm-static) |
| `execution/src/oauth-execution-binding.mjs` | 现役 | execution/src/index.mjs:69 (esm-static) |
| `execution/src/oauth-flow-diagnostics.mjs` | 现役 | execution/src/login-recovery.mjs:3 (esm-static) |
| `execution/src/oauth-login.mjs` | 现役 | execution/src/index.mjs:818 (node-path) |
| `execution/src/oauth-recovery-profile.mjs` | 现役 | execution/src/oauth-login.mjs:17 (esm-static) |
| `execution/src/oauth-recovery-target.mjs` | 现役 | execution/src/index.mjs:85 (esm-static) |
| `execution/src/oauth-relogin-checkin.mjs` | 现役 | execution/src/browser.mjs:14 (esm-static) |
| `execution/src/oauth-session-profiles.mjs` | 现役 | execution/src/index.mjs:64 (esm-static) |
| `execution/src/offscreen-windows.mjs` | 现役 | execution/src/browser.mjs:29 (esm-static) |
| `execution/src/open-captcha-session.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/origin-routing.mjs` | 现役 | execution/src/anyrouter-api-checkin.mjs:4 (esm-static) |
| `execution/src/powershell-runtime.mjs` | 现役 | execution/scripts/Test-CheckinHealth.ps1:491 (ps-join) |
| `execution/src/preflight-policy.mjs` | 现役 | execution/src/index.mjs:36 (esm-static) |
| `execution/src/preflight.mjs` | 运维手动 | npm 人工命令 execution/package.json:preflight |
| `execution/src/protected-credential-api.mjs` | 现役 | execution/src/credential-api-login.mjs:8 (esm-static) |
| `execution/src/protected-login-flow.mjs` | 现役 | execution/src/native-login.mjs:6 (esm-static) |
| `execution/src/pt-coordination.mjs` | 现役 | execution/src/harvest-pt-gate.mjs:4 (esm-static) |
| `execution/src/pt-diagnostics.mjs` | 现役 | execution/src/pt-supplement.mjs:7 (esm-static) |
| `execution/src/pt-initial-observation.mjs` | 现役 | execution/src/browser.mjs:26 (esm-static) |
| `execution/src/pt-login-recovery.mjs` | 现役 | execution/src/pt-supplement.mjs:11 (esm-static) |
| `execution/src/pt-login-resume-guard.mjs` | 现役 | execution/src/pt-supplement.mjs:13 (esm-static) |
| `execution/src/pt-native-diagnostic.mjs` | 现役 | execution/src/hddolby-two-factor.mjs:8 (esm-static) |
| `execution/src/pt-observation-receipt.mjs` | 现役 | execution/src/index.mjs:24 (esm-static) |
| `execution/src/pt-profile-read.mjs` | 现役 | execution/src/pt-supplement.mjs:9 (esm-static) |
| `execution/src/pt-read-policy.mjs` | 现役 | execution/src/index.mjs:87 (esm-static) |
| `execution/src/pt-submission-closure.mjs` | 现役 | execution/src/index.mjs:25 (esm-static) |
| `execution/src/pt-submission-guard.mjs` | 现役 | execution/src/browser.mjs:23 (esm-static) |
| `execution/src/pt-supplement.mjs` | 现役 | execution/scripts/Run-PtSupplement.mjs:6 (esm-static) |
| `execution/src/qa-solver.mjs` | 现役 | execution/src/index.mjs:35 (esm-static) |
| `execution/src/quota-claim-guard.mjs` | 现役 | execution/src/index.mjs:23 (esm-static) |
| `execution/src/report-reason.mjs` | 现役 | execution/src/index.mjs:82 (esm-static) |
| `execution/src/result-contract.mjs` | 现役 | execution/src/index.mjs:83 (esm-static) |
| `execution/src/result-identity.mjs` | 现役 | execution/src/index.mjs:41 (esm-static) |
| `execution/src/retry-policy.mjs` | 现役 | execution/src/index.mjs:70 (esm-static) |
| `execution/src/run-lock.mjs` | 现役 | tools/release-lib.mjs:100 (esm-dynamic) |
| `execution/src/saved-password-login.mjs` | 现役 | execution/src/index.mjs:828 (node-path) |
| `execution/src/search-site-checkin.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/security.mjs` | 现役 | execution/src/index.mjs:22 (esm-static) |
| `execution/src/session-preflight.mjs` | 现役 | execution/src/index.mjs:68 (esm-static) |
| `execution/src/setup-config.mjs` | 运维手动 | execution/scripts/Initialize-Checkin.ps1:22 (ps-join) |
| `execution/src/shared-context-lifecycle.mjs` | 现役 | execution/src/index.mjs:51 (esm-static) |
| `execution/src/site-migration.mjs` | 现役 | execution/src/browser.mjs:17 (esm-static) |
| `execution/src/site-state.mjs` | 现役 | execution/src/index.mjs:28 (esm-static) |
| `execution/src/supplemental-oauth-accounts.mjs` | 现役 | execution/src/index.mjs:55 (esm-static) |
| `execution/src/two-factor-scope.mjs` | 现役 | execution/src/saved-password-login.mjs:10 (esm-static) |
| `execution/src/u2-captcha-session.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `execution/src/u2-reference-fetch.mjs` | 现役 | execution/src/browser.mjs:11 (esm-static) |
| `execution/src/u2-vision.mjs` | 现役 | execution/src/browser.mjs:10 (esm-static) |
| `execution/src/url-routes.mjs` | 现役 | execution/src/login-recovery.mjs:2 (esm-static) |
| `execution/src/vibe-readonly.mjs` | 现役 | execution/src/index.mjs:26 (esm-static) |
| `observation/public/app.js` | 现役 | observation/public/index.html:89 (public-asset) |
| `observation/public/appearance.mjs` | 现役 | observation/public/app.js:10 (esm-static) |
| `observation/public/article-glass.css` | 现役 | observation/public/preview-styles.js:3 (literal-script) |
| `observation/public/business-day-history.mjs` | 现役 | observation/src/dashboard-server.mjs:30 (esm-static) |
| `observation/public/calendar-model.mjs` | 现役 | observation/src/calendar-records.mjs:3 (esm-static) |
| `observation/public/checkin-contract.generated.mjs` | 现役 | observation/public/dashboard-model.mjs:1 (esm-static) |
| `observation/public/controls.css` | 现役 | observation/public/index.html:10 (public-asset) |
| `observation/public/dashboard-model.mjs` | 现役 | observation/src/dashboard-server.mjs:24 (esm-static) |
| `observation/public/day-verdict.mjs` | 现役 | observation/src/dashboard-server.mjs:29 (esm-static) |
| `observation/public/glass-geometry.mjs` | 现役 | observation/public/liquid-glass.mjs:1 (esm-static) |
| `observation/public/glass-preview.css` | 现役 | observation/public/preview-styles.js:3 (literal-script) |
| `observation/public/harvest-window.mjs` | 现役 | observation/src/dashboard-server.mjs:31 (esm-static) |
| `observation/public/index.html` | 现役 | observation/src/dashboard-server.mjs:1 (dashboard-assets) |
| `observation/public/ios26-glass.css` | 现役 | observation/public/preview-styles.js:3 (literal-script) |
| `observation/public/ios26-v2.css` | 现役 | observation/public/preview-styles.js:3 (literal-script) |
| `observation/public/liquid-glass.css` | 现役 | observation/public/index.html:16 (public-asset) |
| `observation/public/liquid-glass.mjs` | 现役 | observation/public/app.js:11 (esm-static) |
| `observation/public/motion.mjs` | 现役 | observation/public/app.js:5 (esm-static) |
| `observation/public/navigation.mjs` | 现役 | observation/public/app.js:3 (esm-static) |
| `observation/public/notice-state.mjs` | 现役 | observation/public/app.js:6 (esm-static) |
| `observation/public/overview-model.mjs` | 现役 | observation/public/app.js:1 (esm-static) |
| `observation/public/overview.css` | 现役 | observation/public/index.html:12 (public-asset) |
| `observation/public/preview-styles.js` | 现役 | observation/public/index.html:14 (public-asset) |
| `observation/public/pt-evidence.mjs` | 现役 | observation/src/pt-status.mjs:10 (esm-static) |
| `observation/public/pt-status.css` | 现役 | observation/public/index.html:11 (public-asset) |
| `observation/public/select-menu.mjs` | 现役 | observation/public/app.js:8 (esm-static) |
| `observation/public/styles.css` | 现役 | observation/public/index.html:9 (public-asset) |
| `observation/public/theme.css` | 现役 | observation/public/index.html:13 (public-asset) |
| `observation/public/theme.js` | 现役 | observation/public/index.html:8 (public-asset) |
| `observation/public/topbar.mjs` | 现役 | observation/public/app.js:4 (esm-static) |
| `observation/public/workspace.css` | 现役 | observation/public/index.html:15 (public-asset) |
| `observation/scripts/Invoke-DashboardOperations.ps1` | 现役 | observation/scripts/Start-NasShadowScheduler.ps1:168 (ps-join) |
| `observation/scripts/Invoke-PtEvidenceRepair.ps1` | 现役 | observation/scripts/Start-NasShadowScheduler.ps1:174 (ps-join) |
| `observation/scripts/Start-NasShadowScheduler.ps1` | 现役 | 生产入口（架构调用链） |
| `observation/scripts/Sync-NasShadow.ps1` | 现役 | observation/scripts/Start-NasShadowScheduler.ps1:11 (ps-join) |
| `observation/scripts/Sync-OperationsSupport.ps1` | 现役 | observation/scripts/Start-NasShadowScheduler.ps1:86 (ps-call) |
| `observation/scripts/Sync-ShadowPublication.ps1` | 现役 | observation/scripts/Sync-NasShadow.ps1:137 (ps-call) |
| `observation/scripts/Sync-Transport.ps1` | 现役 | observation/scripts/Sync-OperationsSupport.ps1:3 (ps-join) |
| `observation/scripts/adopt-v2-checkin.mjs` | 历史审计 | 旧 V2 adoption 一次性迁移；project-structure.md 的迁移保留边界，未见现行入口或人工命令。 |
| `observation/scripts/archive-history.mjs` | 运维手动 | 人工用法见 docs/release-and-recovery.md |
| `observation/scripts/audit-migration.mjs` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `observation/scripts/build-v1-adapter-catalog.mjs` | 历史审计 | 为旧独立 adapter 生成迁移目录；project-structure.md 保留旧 adapter 供审计，无现行入口。 |
| `observation/scripts/captcha-solver.py` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/check-adapters.mjs` | 运维手动 | npm 人工命令 observation/package.json:check:adapters |
| `observation/scripts/check-canary-gate.mjs` | 运维手动 | npm 人工命令 observation/package.json:check:canary-gate |
| `observation/scripts/check-harvest-waiting-ui.mjs` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `observation/scripts/check-js-syntax.mjs` | 运维手动 | npm 人工命令 observation/package.json:lint |
| `observation/scripts/check-liquid-glass.mjs` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `observation/scripts/check-structure.mjs` | 运维手动 | npm 人工命令 observation/package.json:check:structure |
| `observation/scripts/check-ui-navigation.mjs` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `observation/scripts/collect-desired-plan.mjs` | 现役 | observation/scripts/Sync-NasShadow.ps1:203 (ps-join) |
| `observation/scripts/collect-monitor-catalog.mjs` | 现役 | observation/scripts/Sync-NasShadow.ps1:210 (ps-join) |
| `observation/scripts/deploy-nas-code.ps1` | 运维手动 | 人工用法见 observation/docs/nas-deployment.md |
| `observation/scripts/enroll-fresh-v2-profiles.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/enroll-v2-site-profile.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/export-dashboard-status.mjs` | 现役 | observation/scripts/sync-v2-status.ps1:37 (ps-join) |
| `observation/scripts/export-nas-bundle.mjs` | 运维手动 | npm 人工命令 observation/package.json:export:nas |
| `observation/scripts/flush-v2-notifications.mjs` | 运维手动 | npm 人工命令 observation/package.json:notifications:flush |
| `observation/scripts/harvest-fallback.mjs` | 现役 | observation/scripts/Sync-NasShadow.ps1:228 (ps-join) |
| `observation/scripts/harvest-observe.py` | 现役 | observation/scripts/Sync-NasShadow.ps1:214 (ps-join) |
| `observation/scripts/import-v1-runtime.mjs` | 历史审计 | 旧 V1→V2 运行目录导入；project-structure.md 保留旧迁移供审计，无现行入口。 |
| `observation/scripts/install-v2-canary-task.ps1` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/live-smoke.mjs` | 运维手动 | npm 人工命令 observation/package.json:smoke:live |
| `observation/scripts/m2-nas-client-smoke.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/m2-nas-fixture.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/nas-code-release.sh` | 运维手动 | observation/scripts/deploy-nas-code.ps1:144 (ps-join) |
| `observation/scripts/notify-canary-result.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/open-v2-login.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/prepare-canary.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/preview-dashboard.mjs` | 运维手动 | npm 人工命令 observation/package.json:preview:ui |
| `observation/scripts/process-dashboard-operations.mjs` | 现役 | observation/scripts/Invoke-DashboardOperations.ps1:9 (ps-join) |
| `observation/scripts/reconcile-pt-evidence.mjs` | 现役 | observation/scripts/Invoke-PtEvidenceRepair.ps1:10 (ps-join) |
| `observation/scripts/reconcile-pt-fallback.mjs` | 运维手动 | 人工用法见 observation/docs/reliability-operations.md |
| `observation/scripts/reconcile-v2-execution.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/recover-v2-execution.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/run-v1-engine.mjs` | 现役 | 生产入口（架构调用链） |
| `observation/scripts/run-v2-canary.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/run-v2-daily.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/stage-account-migration.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/sync-v2-status.ps1` | 现役 | observation/scripts/Sync-NasShadow.ps1:300 (ps-join) |
| `observation/scripts/verify-open-cd.mjs` | 运维手动 | 人工用法见 observation/docs/reliability-operations.md |
| `observation/scripts/verify-pt.mjs` | 运维手动 | 人工用法见 observation/docs/reliability-operations.md |
| `observation/scripts/verify-v2-profile.mjs` | 运维手动 | 安装/恢复/诊断人工工具；用途由文件入口实现确认。 |
| `observation/scripts/worker-dry-smoke.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/scripts/worker-once.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/adapter-contract.mjs` | 运维手动 | observation/src/new-api-execution-adapter.mjs:1 (esm-static) |
| `observation/src/adapter-observations.mjs` | 现役 | observation/src/dashboard-server.mjs:15 (esm-static) |
| `observation/src/adapter-registry.mjs` | 现役 | observation/src/dashboard-server.mjs:16 (esm-static) |
| `observation/src/anyrouter-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:4 (esm-static) |
| `observation/src/anyrouter-readonly.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/anyrouter-route.mjs` | 运维手动 | observation/src/anyrouter-execution-adapter.mjs:2 (esm-static) |
| `observation/src/attention-controls.mjs` | 现役 | observation/src/dashboard-server.mjs:19 (esm-static) |
| `observation/src/bridge.mjs` | 现役 | npm 生产脚本 observation/package.json:bridge |
| `observation/src/calendar-records.mjs` | 现役 | observation/src/shadow-ledger.mjs:6 (esm-static) |
| `observation/src/canary-gate.mjs` | 运维手动 | observation/scripts/check-canary-gate.mjs:2 (esm-static) |
| `observation/src/canary-report-view.mjs` | 现役 | observation/src/dashboard-server.mjs:17 (esm-static) |
| `observation/src/canary-runner.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/canary-task.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/candidate-protocol.mjs` | 现役 | observation/src/dry-transport-server.mjs:4 (esm-static) |
| `observation/src/candidate-simulator.mjs` | 运维手动 | npm 人工命令 observation/package.json:simulate:candidate |
| `observation/src/captcha-solver.mjs` | 运维手动 | observation/src/pt-execution-adapter.mjs:3 (esm-static) |
| `observation/src/checkin-contract.generated.mjs` | 现役 | observation/src/dashboard-server.mjs:5 (esm-static) |
| `observation/src/contracts.mjs` | 现役 | observation/src/legacy-engine.mjs:8 (esm-static) |
| `observation/src/daily-reconciliation.mjs` | 现役 | observation/src/dashboard-server.mjs:26 (esm-static) |
| `observation/src/daily-runner.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/dashboard-generation.mjs` | 现役 | observation/src/legacy-engine.mjs:11 (esm-static) |
| `observation/src/dashboard-operation-executor.mjs` | 现役 | observation/scripts/process-dashboard-operations.mjs:6 (esm-static) |
| `observation/src/dashboard-operations-cli.mjs` | 现役 | observation/scripts/process-dashboard-operations.mjs:11 (nas-command) |
| `observation/src/dashboard-operations.mjs` | 现役 | observation/src/dashboard-server.mjs:23 (esm-static) |
| `observation/src/dashboard-runtime.mjs` | 现役 | observation/src/dashboard-server.mjs:18 (esm-static) |
| `observation/src/dashboard-server.mjs` | 现役 | npm 生产脚本 observation/package.json:dashboard |
| `observation/src/dedicated-login.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/desired-plan.mjs` | 现役 | observation/src/bridge.mjs:17 (esm-static) |
| `observation/src/display-identity.mjs` | 现役 | observation/src/dashboard-server.mjs:13 (esm-static) |
| `observation/src/dry-run-worker.mjs` | 运维手动 | npm 人工命令 observation/package.json:worker:dry-run |
| `observation/src/dry-transport-server.mjs` | 现役 | observation/src/worker-gateway.mjs:3 (esm-static) |
| `observation/src/dry-transport-worker.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/effective-config.mjs` | 现役 | observation/src/bridge.mjs:16 (esm-static) |
| `observation/src/evidence-contract.mjs` | 现役 | observation/src/legacy-engine.mjs:9 (esm-static) |
| `observation/src/execution-adapter-registry.mjs` | 运维手动 | observation/scripts/check-adapters.mjs:2 (esm-static) |
| `observation/src/execution-journal.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/execution-lock.mjs` | 现役 | observation/src/legacy-engine.mjs:6 (esm-static) |
| `observation/src/freshness.mjs` | 现役 | observation/src/dashboard-server.mjs:11 (esm-static) |
| `observation/src/gateway-error.mjs` | 现役 | observation/scripts/run-v1-engine.mjs:6 (esm-static) |
| `observation/src/harvest-fallback.mjs` | 现役 | observation/scripts/harvest-fallback.mjs:8 (esm-static) |
| `observation/src/history-archive.mjs` | 运维手动 | observation/scripts/archive-history.mjs:1 (esm-static) |
| `observation/src/identity-observations.mjs` | 现役 | observation/src/bridge.mjs:15 (esm-static) |
| `observation/src/isolated-browser-worker.mjs` | 运维手动 | observation/src/profile-verifier.mjs:3 (esm-static) |
| `observation/src/legacy-engine.mjs` | 现役 | 生产入口（架构调用链） |
| `observation/src/migration-state.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/monitor-catalog.mjs` | 现役 | observation/scripts/collect-monitor-catalog.mjs:3 (esm-static) |
| `observation/src/new-api-captcha-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:7 (esm-static) |
| `observation/src/new-api-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:1 (esm-static) |
| `observation/src/new-api-readonly-adapter.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/notification-delivery.mjs` | 运维手动 | observation/src/v2-notification-flush.mjs:5 (esm-static) |
| `observation/src/oauth-api-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:5 (esm-static) |
| `observation/src/oauth-browser-flow.mjs` | 运维手动 | observation/src/oauth-reward-execution-adapter.mjs:2 (esm-static) |
| `observation/src/oauth-reward-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:2 (esm-static) |
| `observation/src/ownership-transition.mjs` | 历史审计 | 独立 V2 所有权切换模型；project-structure.md 保留旧迁移供回滚审计，只有测试/语法检查引用。 |
| `observation/src/profile-handoff.mjs` | 运维手动 | observation/src/isolated-browser-worker.mjs:7 (esm-static) |
| `observation/src/profile-verifier.mjs` | 运维手动 | observation/scripts/verify-v2-profile.mjs:7 (esm-static) |
| `observation/src/pt-capabilities.mjs` | 现役 | observation/src/dashboard-operations.mjs:6 (esm-static) |
| `observation/src/pt-catalog.mjs` | 现役 | observation/src/harvest-fallback.mjs:13 (esm-static) |
| `observation/src/pt-coordination.generated.mjs` | 现役 | observation/src/pt-status.mjs:7 (esm-static) |
| `observation/src/pt-evidence-repair.mjs` | 现役 | observation/scripts/reconcile-pt-evidence.mjs:3 (esm-static) |
| `observation/src/pt-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:3 (esm-static) |
| `observation/src/pt-native-diagnostic.generated.mjs` | 现役 | observation/src/pt-site-execution.mjs:8 (esm-static) |
| `observation/src/pt-readonly-adapter.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/pt-reconciliation.mjs` | 现役 | observation/src/legacy-engine.mjs:12 (esm-static) |
| `observation/src/pt-site-execution.mjs` | 现役 | observation/src/dashboard-server.mjs:21 (esm-static) |
| `observation/src/pt-status.mjs` | 现役 | observation/src/dashboard-server.mjs:25 (esm-static) |
| `observation/src/pt-verification.mjs` | 现役 | observation/src/harvest-fallback.mjs:10 (esm-static) |
| `observation/src/pt-worker-lifecycle.mjs` | 现役 | observation/src/legacy-engine.mjs:4 (esm-static) |
| `observation/src/readonly-adapters.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/release-info.mjs` | 现役 | observation/src/dashboard-server.mjs:22 (esm-static) |
| `observation/src/runtime-config.mjs` | 现役 | observation/scripts/run-v1-engine.mjs:5 (esm-static) |
| `observation/src/schedule-gate.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/scheduler.mjs` | 待确认 | 当前文本仅见测试和 lint:domain 语法检查，生产调用待核实，暂不迁移。 |
| `observation/src/shadow-acceptance.mjs` | 现役 | observation/src/dashboard-server.mjs:12 (esm-static) |
| `observation/src/shadow-ledger.mjs` | 现役 | observation/src/legacy-engine.mjs:10 (esm-static) |
| `observation/src/shadow-run.mjs` | 现役 | npm 生产脚本 observation/package.json:shadow |
| `observation/src/site-identity-index.mjs` | 现役 | observation/src/pt-status.mjs:3 (esm-static) |
| `observation/src/task-coordinator.mjs` | 运维手动 | observation/src/isolated-browser-worker.mjs:6 (esm-static) |
| `observation/src/task-state.mjs` | 运维手动 | observation/src/task-coordinator.mjs:2 (esm-static) |
| `observation/src/transport-store.mjs` | 现役 | observation/src/dry-transport-server.mjs:3 (esm-static) |
| `observation/src/v1-account-handoff.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/v1-adapter-catalog.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/v1-runtime-import.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/v1-v2-adapter-plan.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/v2-notification-flush.mjs` | 运维手动 | observation/scripts/flush-v2-notifications.mjs:3 (esm-static) |
| `observation/src/v2-profile-registry.mjs` | 待确认 | 未见生产可达或明确人工用途；缺少足够的退役依据。 |
| `observation/src/vibe-entitlement-execution-adapter.mjs` | 运维手动 | observation/src/execution-adapter-registry.mjs:6 (esm-static) |
| `observation/src/worker-gateway.mjs` | 现役 | observation/src/dashboard-server.mjs:14 (esm-static) |
| `observation/src/workload-view.mjs` | 现役 | observation/src/dashboard-server.mjs:27 (esm-static) |

## 未解析引用

下表包含人工工具的动态边界；“生产”列仅指调用方可达。候选为空表示目标/命令无法由文本确定，不能用它证明某个文件已退役；JSON 保留完整候选集合。

| 调用位置 | 类型 | 生产 | 未解析依据 / 有界候选 |
| --- | --- | --- | --- |
| `execution/src/native-pt-read.mjs:120` | node-process | 是 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/scripts/check-js-syntax.mjs:8` | node-process | 否 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/scripts/deploy-nas-code.ps1:146` | ps-join | 否 | 仓库内无对应文件；不读取运行副本；`observation/outputs/nas-bundle-deploy/nas-code-release.sh` |
| `observation/scripts/m2-nas-client-smoke.mjs:14` | node-process | 否 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/scripts/m2-nas-client-smoke.mjs:30` | node-process | 否 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/scripts/Start-NasShadowScheduler.ps1:173` | ps-join | 是 | 仓库内无对应文件；不读取运行副本；`observation/scripts/Invoke-DryWorkerIfDue.ps1` |
| `observation/scripts/Start-NasShadowScheduler.ps1:225` | ps-call | 是 | 仓库内无对应文件；不读取运行副本；`observation/scripts/Invoke-DryWorkerIfDue.ps1` |
| `observation/src/captcha-solver.mjs:86` | node-process | 否 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/src/isolated-browser-worker.mjs:32` | node-process | 否 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/src/legacy-engine.mjs:149` | node-process | 是 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `observation/src/pt-site-execution.mjs:85` | node-process | 是 | 子进程命令/参数由函数或配置提供，不能静态展开 |
| `tools/doctor.mjs:258` | node-process | 是 | 子进程命令/参数由函数或配置提供，不能静态展开 |

## 结构围栏

`observation/scripts/check-structure.mjs` 读取本表已审阅的“历史审计”集合，再检查当前生产可达文件的静态/动态 import（含 re-export）。新 import 即使让目标变得可达，也不会自动撤销历史禁入；先处理引用和退役审查，再显式更新分类。现有历史 import 例外白名单为空；新增例外必须逐边写明原因。

发布兼容映射：`operations/scripts/Sync-NasShadow.ps1` → `observation/scripts/Sync-NasShadow.ps1`；`operations/scripts/Start-NasShadowScheduler.ps1` → `observation/scripts/Start-NasShadowScheduler.ps1`；`operations/scripts/Run-HiddenPowerShell.vbs` → `execution/scripts/Run-HiddenPowerShell.vbs`；`operations/scripts/Sync-OperationsSupport.ps1` → `observation/scripts/Sync-OperationsSupport.ps1`；`operations/scripts/Sync-Transport.ps1` → `observation/scripts/Sync-Transport.ps1`。
