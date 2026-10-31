# 现行术语表

以下按统一 `executionEngine: v1` 模式解释；“现行使用”指仓库明确的主链或兼容用途，未检查现场任务和私有配置的可选组件标为“待核实”。旧名称不代表另有一套生产签到系统。

| 术语 | 现在的含义与使用状态 |
| --- | --- |
| v1 | 现行执行层及成熟浏览器执行器，统一模式仍使用；`executionEngine: v1` 表示选择它。配置、Profile、站点实现和原始回执仍归执行层。 |
| v2 | 现行观测/控制层的历史名称，租约、网关、归并和面板仍在主链使用。它曾有独立执行实验，统一模式不再运行那套 Canary 执行器。 |
| legacy | 相对观测层而言的既有执行器，`legacyRoot` 当前就是 `<execution-root>`，并非废弃目录。`legacy-engine.mjs` 是仍使用的执行层派发/结果导入模块。 |
| shadow | 脱敏观测和对照投影，`shadow-run`、snapshot、ledger 及 NAS 同步仍使用。`shadow_read_only` 描述投影视图，不能据此认为整个同步调度器不会派发受控执行。 |
| canary | 曾指小范围的独立观测层试执行；统一模式明确拒绝该执行入口，历史结果读取和回滚测试仍保留。`canary-*` 名称不能单独证明存在第二个生产执行器。 |
| fabric | 整个统一签到系统的项目名，涵盖执行、观测、同步和面板，当前仍使用。它不是额外的执行进程。 |
| adapter | 按统一接口封装站点能力或协议的适配器，是否在用须看调用方。现行 PT 包装仍交回执行层，历史独立执行 adapter 在统一模式被隔离，不能一概判为废弃或生产使用。 |
| transport | 有两种含义：当前同步使用的 SSH/有界进程传输，以及可选的 NAS dry-run worker 协议与 overlay。后者的 Compose overlay 仍随仓库提供，是否启用取决于各安装的 NAS 配置。 |
| dry worker | 只认领 `dry_run` 任务、记录意图并回传演练回执的 worker，代码要求 `browserActions: 0`。当前同步调度器仍保留私有分发脚本钩子，现场调用和面板依赖待核实，不能直接认定无用。 |
| Harvest | 外部 PT 管理/签到系统，现行观测链只读采集其日程、任务和站点结果，执行前另按策略刷新核对。其数据库用户 ID 不能当作站点账号绑定。 |
| PT | 现行精确书签目录中的私有 Tracker 站点集合，包含常规执行目标和纯监控目标。属于 PT 不自动授权补签，仍受账号、Profile、范围及私有开关约束。 |
| PT supplement | 对常规计划以外、获私有授权的 PT 目标使用的受控执行层补充入口，当前保留使用；独立结果也承载被动核验回执。它不加入常规执行计划，但可在授权工作量视图中去重计数。 |
| fallback | Harvest/PT 协调后的有界补救路径，当前按所有权、当日证据、预算和锁决定是否交回执行层。它不等于失败后重签，未知提交须先满足既有只读复核及防重条件。 |
| effective | 当前生效的归并状态，由新鲜度、权威证据和来源规则选择，并保留来源观测和冲突。面板与通知仍使用它；它不是新的原始站点回执。 |
| generation | 当前仍使用的一致发布单元：manifest 内嵌 snapshot，并绑定 ledger 的精确字节前缀及哈希。读端校验当前代，必要时尝试上一代，避免混读半次发布。 |
| ledger | 当前仍追加写入的脱敏快照状态账本，供历史、漂移和恢复事件读取。它是派生状态历史，与 fallback 尝试记录、原始提交意图不是同一种记录。 |
| lease | 当前仍使用的有主执行权凭证；观测执行锁以 PID、起始时间和随机 nonce 标识持有者，子进程校验后继续既有执行器。它不替代执行层 mutex/`tmp/run.lock`，也不同于可选 transport 协议内的任务 lease。 |

代码依据：`observation/src/legacy-engine.mjs:16`、`observation/src/legacy-engine.mjs:126`、`observation/src/canary-runner.mjs:46`、`observation/src/pt-site-execution.mjs:126`、`observation/src/pt-status.mjs:275`、`observation/src/dashboard-generation.mjs:32`、`observation/src/execution-lock.mjs:16`。transport/dry worker 另见 `observation/compose.worker.yaml:1`、`observation/src/dry-transport-worker.mjs:43`、`observation/scripts/Start-NasShadowScheduler.ps1:173`；完整调用关系见 [架构速查](architecture.md)。
