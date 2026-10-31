# 发布与恢复

根包和两个子包使用统一版本。只在实际发布运行代码时递增版本号，发布完成后打 `v<版本>` tag。只改 `tools/` 不需要发布，也不因此升版本；工具本身不在受管发布集合内。旧目录和命令名保留兼容，不代表独立版本。发布前检查两个包、Harvest Python、UI 与脱敏扫描。

正式 Git 源码须为已提交状态。发布清单记录 Git tree 和实际受管产物哈希，运行标记另记录各包的 package/lock 哈希；审计出现文件或已安装直接依赖的版本漂移时返回非零退出码。健康检查读取这些元数据，受控发布期间明确标为更新中，不把中途的文件替换当成站点失败。

PT 子任务的生命周期记录位于观测运行副本 data/pt-worker-lifecycle.json。正常返回须等待进程及输出流关闭；超时或异常退出先清理可核实归属的项目辅助进程和专用浏览器。用户主 Chrome 和无关应用保留。不能确认清理完成时记录持续阻断，新执行、登录窗口及发布须先复核该记录；不能删除它来强制重试。

## Windows 代码

三个独立运行根目录分别是：`<execution-root>`（执行器、私有配置与 Profile）、`<observation-root>`（观测控制、账本与面板运行副本）、`<operations-root>`（Windows 同步调度、运维配置与暂存）。发布工具将受管 `execution/*`、`observation/*` 分别映射到前两个根，并把兼容运维入口和观测层受管代码副本映射到 ops 根；私有配置与数据仍保留。

复制 `tools/release.config.example.json` 为被 Git 忽略的 `*.local.json`，替换根目录和任务名占位值。配置可含 `executionRoot`、`observationRoot`、`opsRoot`、`backupRoot`、`taskNames`；`taskNames` 是包含 `main`、`sync` 的对象，可加入其他需保持空闲的任务角色。配置中的相对根路径相对于配置文件所在目录解析，命令行路径相对于当前目录解析，命令行字段优先。`--task-names` 接受同结构的 JSON 对象。

先生成并检查差异清单，再应用；以下命令用于获得发布授权后的维护窗口：

```powershell
node tools/release.mjs plan --execution-root "<execution-root>" --observation-root "<observation-root>" --ops-root "<operations-root>" --out "<observation-root>/outputs/release-plan.json"
node tools/release.mjs apply --manifest "<observation-root>/outputs/release-plan.json" --config tools/release.local.json
node tools/release.mjs audit --manifest "<observation-root>/outputs/release-plan.json"
node tools/release.mjs verify --manifest "<observation-root>/outputs/release-plan.json" --config tools/release.local.json
```

占位符须替换为实际路径；`<backup-root>` 是运行根目录之外的备份位置。也可用 `plan --config tools/release.local.json --out <清单>`。CLI 的 `plan` 必须提供 `--ops-root` / 配置 `opsRoot`，或显式 `--no-ops`，否则拒绝，避免漏发运维副本。`--no-ops` 覆盖配置里的 ops 根，与命令行 `--ops-root` 互斥。库接口 `planRelease()` 仍允许省略 ops 根。后续命令从清单确定根目录，额外提供的配置根必须与清单一致。

发布前可用 `node tools/release.mjs gate --manifest "<清单>" --config tools/release.local.json` 只读查看当前是否允许发布，不取锁、不写文件；通过返回 0，门槛不通过返回 3，缺少清单等命令错误返回 1。

清单覆盖明确的源码、脚本、公开资源和包元数据，也包括执行层的 `config/defaults.json`、`config/qa-rules.json`、`config/site-rules.public.json`、`requirements-ocr.txt`，以及观测层的 `Dockerfile`、`compose.nas.yaml`、`compose.worker.yaml`、`.dockerignore`。这些是公开运行输入，不会把整个 `config` 目录加入发布范围。

私有配置、账号绑定、Profile、账本、原始结果和 node_modules 不覆盖。应用时取得执行租约，计划后源码或运行副本发生漂移则拒绝覆盖；回滚也先检查运行副本和备份哈希。不要提交含本机路径的清单。统一项目只使用根发布工具更新运行副本；`execution/scripts/Sync-PrivateRuntime.ps1` 保留旧安装兼容和只读诊断，不作为统一发布入口。

运行副本中尚未进入源码的有效修复要先审阅并收敛。依赖变化需要在维护窗口完成对应 `npm ci`，工具不自动安装或升级依赖。

`apply` 在持锁前、持锁后各执行一次发布门槛。不通过就拒绝，且不创建备份。只读 PowerShell 探针通过参数读取根目录和任务名，不启动项目脚本；调用超时为 15 秒，只返回任务定义哈希、任务时间/状态、进程数量/角色和脱敏文件摘要。

| 检查 | 通过条件 |
| --- | --- |
| 运行安全（始终要求） | 所有配置任务为 `Ready`，距下次触发超过 75 秒；没有项目进程；没有 PT 生命周期标记；没有待人工接管或仍活跃的人工会话。 |
| `final_report_today` | 执行根 `logs/latest.json` 的 `runId` 业务日是上海今天，且为 `final`、`executionComplete=true`、`isComplete=true`。没有今天的最终报告为 `before_run`。 |
| `no_retry_pending` | 执行根 `data/scheduler-state.json` 已与该报告同步；`nextEligibleAt`、报告 `nextRetryAt` / 结果 `nextEligibleAt` 没有今日待执行步骤；观测根当日 fallback 审计没有未结束步骤。次日步骤不阻断今天的发布。 |
| `harvest_settled` | 运维根 `tmp/nas-sync/harvest-pt-status.json` 有当日结束记录、活动数为零，观测快照没有 `harvestWindow`；或确认运维根未安装 `config/pt-monitor.local.json`。缓存中的超时窗口不等于任务结束。 |
| `evidence_settled` | 根据当前快照、运维目录的 PT catalog 和观测根 `data/pt-evidence-repair.json` 判定，没有仍有预算的当日复核，也没有当日 dirty 发布标记。普通复核预算 2 次、busy 唤醒 24 次，PT-only 总读取预算 6 次；新证据可重开局部预算。 |
| `notifications_flushed` | 执行根 `data/notification-outbox/*.json` 全部 `delivered=true`，包括已确认重复和被更新条目取代的历史条目；未来才投递的条目也算待办。 |

`submission_outcome_unknown`、`verification_pending`、`external_blocked` 等长期状态本身不阻断发布，只看今日自动步骤是否结束。有预算的到期复核和已排定的当日稍后复核均阻断。必需文件缺失、JSON 损坏、字段缺失或无法确认启用状态时保守拒绝；不能删标记来通过检查。未提供 ops 根时，探针无法从现有源码路径证明 Harvest/复核禁用，相关门槛仍拒绝，`--no-ops` 不会豁免它们。fallback 审计存在剩余复核预算但无法证明当前候选已关闭时也保守拒绝。

紧急修复可使用 `apply ... --override-day-gate "<原因>"`，只跳过五项当日结束检查，仍要求全部运行安全检查、漂移/配置保护和锁。非空原因与两次门槛结果写入本次备份下的 `release-record.json`。

应用前记录健康失败项集合及任务定义哈希、`lastRun`。应用后依次要求：代码/依赖审计无漂移；任务定义哈希不变；`lastRun` 不变（没有跨越调度边界）；健康检查没有新增失败项。健康检查原有失败不要求清零，读取失败不能当作空集合。任何校验失败都会在原锁内尝试自动回滚并返回非零退出码，校验和回滚结果保存在发布记录；若检测到独立运行漂移或备份损坏，原有回滚保护仍会拒绝覆盖。

`verify` 只读，不等待、不触发任务、不自动回滚。它检查清单所列各根（通常三个）的 `release.json` revision 和部署时间一致、部署后同步和主任务的自然运行、新最终报告、全部 `data/gateway-events.jsonl*` 中部署后无新错误，以及无残留生命周期标记。同步任务结果须为 0；主任务 267009 表示仍在运行，结果 2 仅在已有部署后完整最终报告时通过，其他异常结果码仍为失败。主任务空跑且报告仍早于部署时继续 `pending`；报告晚于部署、完整且不在未来即可，不要求晚于后续空跑。任务运行证据来自计划任务记录，工具不生成运行来补足证据。

| `verify` 状态 | 退出码 | 含义 |
| --- | --- | --- |
| `pass` | 0 | 全部证据通过。 |
| `pending` | 3 | 尚未等到部署后的自然运行结束或新报告。 |
| `fail` | 1 | 发现失败证据，或必需信息无法读取/解析。 |

其余命令成功返回 0，拒绝返回 1；`audit` 有漂移时返回 2。`applyRelease()` 的 `beforeLock`、`beforeApply`、`afterApply` 是可选注入回调，库调用方不传时保留原有行为；正式 CLI 始终安装上述门槛与应用后校验。

应用返回备份目录，回滚前确认没有后续代码改动：

```powershell
node tools/release.mjs rollback --backup "<backup-root>/<本次备份目录>"
```

只恢复代码和版本标记。新增文件移入 retired，保留恢复能力；实际签到记录不回滚。恢复后运行健康检查并只读核对面板。

## NAS 代码与数据

导出包包含 release.json，面板显示版本和提交。升级默认保留现有 compose；确需替换才使用 `-ReplaceCompose`。使用高级传输 overlay 的安装显式传入 `-UseWorkerTransport:$true`。

全量发布先在 NAS 项目自己的 `backups/code-<唯一编号>.tree` 中保存公开代码的前后快照，随后校验当前代码与备份一致，再替换完整的 `src`、`public` 和明确列出的包、镜像构建文件。已从源码移除的文件不留在活动代码中，原目录保留在事务的 `retired` 中。代码事务不枚举或替换 `nas-data`、secrets、Profile、transport 配置和历史签到记录。现有 Compose 默认不进入替换集合；公开 Compose 模板更新到 Windows 运行副本不等于覆盖 NAS 用户配置。

构建、健康检查或目录切换失败时，同一事务恢复精确的旧代码集合。本次新增代码移出活动目录并留在 `failed` 中，不直接删除；备份内容和文件集合先经 SHA-256 校验。如果检测到备份损坏或发布后的独立修改，则拒绝自动覆盖，保留事务和原 tar 备份供审阅。备份和 staging 排除在 Docker 构建上下文之外。脚本最终输出 tar 备份及代码事务路径；重试恢复使用事务内自带的恢复脚本，而不是仅用 tar 覆盖旧目录：

```sh
sudo sh /volume3/docker/checkin-fabric-v2/backups/code-<唯一编号>.tree/recover.sh rollback /volume3/docker/checkin-fabric-v2 /volume3/docker/checkin-fabric-v2/backups/code-<唯一编号>.tree
```

恢复完成后，沿用本机原有的 Compose 文件和 overlay 重建 `checkin-fabric-dashboard`，再检查健康与版本。部分文件发布仍限 `-IncludePaths` 明确指定的代码文件；全量回滚演练覆盖新增文件、半途目录切换失败、运行漂移拒绝和 Compose 保留，不访问真实站点。

先发布 ledger，再发布 snapshot，最后提交 dashboard-generation.json；保留 dashboard-generation.previous.json。Manifest 引用精确账本前缀，不能单独截断 ledger。Windows 发布端与 NAS 读取端一起核验兼容性。

## 历史归档

先预览早于指定月份的已结束日报：

```powershell
node observation/scripts/archive-history.mjs --data-dir "<observation-root>/outputs" --before 2026-09
node observation/scripts/archive-history.mjs --data-dir "<observation-root>/outputs" --before 2026-09 --archive-root "<backup-root>/history" --apply
node observation/scripts/archive-history.mjs --verify "<backup-root>/history/<归档目录>"
node observation/scripts/archive-history.mjs --restore "<backup-root>/history/<归档目录>" --data-dir "<observation-root>/outputs"
```

保留未结案和结果不明的尝试；移动已结束旧日报，生成不可变的月度账本副本及 SHA-256 清单。恢复不覆盖已有不同记录。活跃账本、当前和上一代 manifest 保持不变。归档也按私有数据保护。

先在隔离目录演练。工具已有漂移拒绝、代码回滚、历史恢复及不明记录保留测试；不要通过清空状态或重复签到演练恢复。
