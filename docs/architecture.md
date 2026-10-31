# 现行架构速查

这是 `executionEngine: v1` 统一模式的一页代码地图，只有执行层负责站点动作。引用均为仓库相对文件及行号；线上任务参数和可选组件启用状态待核实。

## 三个运行根目录

| 占位符 | 职责与发布映射 |
| --- | --- |
| `<execution-root>` | 执行器、站点规则、账号/Profile、原始报告；受管 `execution/*` 去掉包前缀后发布到这里。 |
| `<observation-root>` | 控制租约、Harvest/PT 归并、账本、generation、面板代码；受管 `observation/*` 去掉包前缀后发布到这里。 |
| `<operations-root>` | Windows 同步调度、私有运维配置及暂存；兼容旧入口，接收观测层受管代码副本，以及执行层的隐藏启动器，不是第三个签到引擎。 |

映射见 `tools/release-lib.mjs:17`、`tools/release-lib.mjs:75`；三个根须不同，私有配置不在覆盖集合内。

## 两个 Windows 任务的调用链

主任务：`execution/scripts/Run-HiddenPowerShell.vbs:20` → `execution/scripts/Start-UserScheduler.ps1:7` → `execution/scripts/V2-EngineGateway.ps1:38` → `observation/scripts/run-v1-engine.mjs:21` → `observation/src/legacy-engine.mjs:30` → 同一 `Start-UserScheduler.ps1 -Once` → `execution/scripts/Start-UserScheduler.ps1:638` 的 `Run-Checkin.ps1` → `execution/scripts/Run-Checkin.ps1:295` 启动 `src/index.mjs` → `execution/src/index.mjs:601` 的 `browser.processTarget`（`execution/src/browser.mjs:1789`）；隔离账号走既有 OAuth 分支（`execution/src/index.mjs:631`）。

防循环：控制器持观测租约，把根和 nonce 传给子进程；子调度器及执行 wrapper 再进网关时，校验绑定根、nonce、锁的活跃 PID 后直接继续原执行器，失败则拒绝（`observation/src/legacy-engine.mjs:149`、`execution/scripts/V2-EngineGateway.ps1:27`、`observation/src/legacy-engine.mjs:16`）。调度互斥锁在网关之后获取；执行另持 wrapper mutex 与 `tmp/run.lock`（`execution/scripts/Start-UserScheduler.ps1:22`、`execution/scripts/Run-Checkin.ps1:147`、`execution/src/index.mjs:244`）。

同步任务：`observation/scripts/Start-NasShadowScheduler.ps1:125` → 上述隐藏启动器 → `Sync-NasShadow.ps1`。后者依次做健康检查、采集当前计划/PT 目录、SSH 运行只读 `harvest-observe.py`、有条件派发 fallback，再运行 `shadow-run.mjs` → `bridge.buildSnapshot` → 账本/快照/generation → NAS（据点：`observation/scripts/Sync-NasShadow.ps1:187,203,210,219,253,266,300`、`observation/src/shadow-run.mjs:77,90`）。fallback 的常规目标交回 `runLegacyEngine`；PT-only 经 `runPtSite` → `Run-PtSupplement.mjs` → `runPtSupplement`，仍须私有 opt-in、精确目录与双层执行锁（`observation/src/harvest-fallback.mjs:613,622`、`observation/src/pt-site-execution.mjs:64,138`、`execution/scripts/Run-PtSupplement.mjs:32`、`execution/src/pt-supplement.mjs:143`）。

## 日内时间线

主运行时间**由私有配置决定**（`execution/scripts/Start-UserScheduler.ps1:537`）。Harvest 的运行时间**由它自身的配置决定**，代码读取其日程和运行结果（`observation/scripts/harvest-observe.py:30,67`）。

同步由报告/观测变化、启用 PT 监控后的 20 分钟刷新或日定时触发；日定时**由私有配置决定**（`observation/scripts/Start-NasShadowScheduler.ps1:87,97`）。每轮还异步派发面板请求 worker，并经 `Invoke-PtEvidenceRepair.ps1` → `reconcile-pt-evidence.mjs` → `repairPtEvidence` 做有界只读复核；新证据触发跳过 fallback 的再次同步，最终刷新每日通知（`observation/scripts/Invoke-PtEvidenceRepair.ps1:10`、`observation/scripts/reconcile-pt-evidence.mjs:8`、`observation/src/pt-evidence-repair.mjs:266`、`observation/scripts/Start-NasShadowScheduler.ps1:168,193,221`）。主运行结束也会排通知，开关和命令**由私有配置决定**，当前代码不保证固定时刻或严格每日一次（`execution/scripts/Run-Checkin.ps1:345`、`execution/scripts/Submit-UnifiedCheckinReport.ps1:371`）；各步骤会交错、重试。

## 谁写、谁读

| 记录（路径相对于对应运行根） | 写入 → 读取 |
| --- | --- |
| 执行根 `logs/<run>/result.json`、`logs/latest.json` | logger 写 → 调度器、legacy-engine/bridge 读；观测根 `outputs/engine-*` 为规范化导入（`execution/src/logger.mjs:22`、`observation/src/legacy-engine.mjs:60,94`）。 |
| 观测根 `outputs/shadow-ledger.jsonl`、`outputs/shadow-beta-snapshot.json` | 主运行导入或 shadow/evidence 重建写 → 面板读（`observation/src/legacy-engine.mjs:117`、`observation/src/pt-evidence-repair.mjs:154`）。 |
| 观测根 `outputs/dashboard-generation.json` 及上一代 | 提交器绑定内嵌快照和账本精确前缀/哈希 → 面板、通知校验读取；当前代无效时尝试上一代（`observation/src/dashboard-generation.mjs:32,53`）。 |
| 观测根 `outputs/pt-fallback-results-<day>.json` | fallback/被动核验写 → shadow-run/bridge 读，不并入常规执行计划（`observation/src/harvest-fallback.mjs:659`、`observation/src/pt-verification.mjs:38`）。 |
| 尝试记录 | fallback 读写观测根 `outputs/harvest-fallback-attempts-<day>.json`；native gate 读写执行根 `data/native-pt-attempts.json`；证据 worker 读写复核状态、追加审计，供预算/防重/复查（`observation/src/harvest-fallback.mjs:295`、`execution/src/native-pt-gate.mjs:175`、`observation/src/pt-evidence-repair.mjs:242,311`）。 |
| 执行根 `data/notification-outbox/` | `Submit-UnifiedCheckinReport.ps1` 写 → `Invoke-CheckinNotificationOutbox.ps1` 读并更新投递状态；调度流程重试投递不授权重签（`execution/scripts/Submit-UnifiedCheckinReport.ps1:413`、`execution/scripts/Invoke-CheckinNotificationOutbox.ps1:138`）。 |

NAS 先同步 `dashboard-runtime.json`，再暂存三件套，按 **ledger → snapshot → generation** 替换并保留 `dashboard-generation.previous.json`；成功后本机同序安装（`observation/scripts/sync-v2-status.ps1:37`、`observation/scripts/Sync-ShadowPublication.ps1:10,20`、`observation/scripts/Sync-NasShadow.ps1:300,322`）。

原始事实取自执行器记录、Harvest 观测、PT 回执及尝试审计，须逐条验业务日、账号和权威证据；今天生成的报告不等于每行今天成功。`effective` 是归并后的生效状态，保留 `observations`/冲突；snapshot、ledger、generation、通知均属派生视图，不抹去未知提交历史（`observation/src/pt-status.mjs:275`、`execution/src/notification-reconciliation.mjs:139`）。

## 面板操作边界

NAS API → `operation-requests.json` 排队 → Windows 同步调度器 → `Invoke-DashboardOperations.ps1` → `process-dashboard-operations.mjs` 经队列 CLI 认领 → `executeDashboardOperation` 复核当日、账号、planHash、有效期、当前目录及锁 → 既有 PT/fallback/常规执行器或绑定登录流程（`observation/src/dashboard-server.mjs:695`、`observation/src/dashboard-operations.mjs:69`、`observation/scripts/Invoke-DashboardOperations.ps1:9`、`observation/scripts/process-dashboard-operations.mjs:23`、`observation/src/dashboard-operations-cli.mjs:7`、`observation/src/dashboard-operation-executor.mjs:18,40,111`）。NAS 不直接提交站点签到，排队成功不是签到回执。
