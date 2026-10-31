# 发布与恢复

根包和两个子包使用统一版本。旧目录和命令名保留兼容，不代表独立版本。发布前检查两个包、Harvest Python、UI 与脱敏扫描。

正式 Git 源码须为已提交状态。发布清单记录 Git tree 和实际受管产物哈希，运行标记另记录各包的 package/lock 哈希；审计出现文件或已安装直接依赖的版本漂移时返回非零退出码。健康检查读取这些元数据，受控发布期间明确标为更新中，不把中途的文件替换当成站点失败。

PT 子任务的生命周期记录位于观测运行副本 data/pt-worker-lifecycle.json。正常返回须等待进程及输出流关闭；超时或异常退出先清理可核实归属的项目辅助进程和专用浏览器。用户主 Chrome 和无关应用保留。不能确认清理完成时记录持续阻断，新执行、登录窗口及发布须先复核该记录；不能删除它来强制重试。

## Windows 代码

三个独立运行根目录分别是：`<execution-root>`（执行器、私有配置与 Profile）、`<observation-root>`（观测控制、账本与面板运行副本）、`<operations-root>`（Windows 同步调度、运维配置与暂存）。发布工具将受管 `execution/*`、`observation/*` 分别映射到前两个根，并把兼容运维入口和观测层受管代码副本映射到 ops 根；私有配置与数据仍保留。

先生成并检查差异清单，再应用：

```powershell
node tools/release.mjs plan --execution-root "<execution-root>" --observation-root "<observation-root>" --ops-root "<operations-root>" --out "<observation-root>/outputs/release-plan.json"
node tools/release.mjs apply --manifest "<observation-root>/outputs/release-plan.json" --backup-root "<backup-root>"
node tools/release.mjs audit --manifest "<observation-root>/outputs/release-plan.json"
```

占位符须替换为实际路径；`<backup-root>` 是运行根目录之外的备份位置。当前 `plan` 漏传 `--ops-root` 不会报错，会生成只覆盖执行根和观测根的清单；有独立运维根的安装应显式传入，后续 apply/audit 从清单读取这三个根。

清单覆盖明确的源码、脚本、公开资源和包元数据，也包括执行层的 `config/defaults.json`、`config/qa-rules.json`、`config/site-rules.public.json`、`requirements-ocr.txt`，以及观测层的 `Dockerfile`、`compose.nas.yaml`、`compose.worker.yaml`、`.dockerignore`。这些是公开运行输入，不会把整个 `config` 目录加入发布范围。

私有配置、账号绑定、Profile、账本、原始结果和 node_modules 不覆盖。应用时取得执行租约，计划后源码或运行副本发生漂移则拒绝覆盖；回滚也先检查运行副本和备份哈希。不要提交含本机路径的清单。统一项目只使用根发布工具更新运行副本；`execution/scripts/Sync-PrivateRuntime.ps1` 保留旧安装兼容和只读诊断，不作为统一发布入口。

运行副本中尚未进入源码的有效修复要先审阅并收敛。依赖变化需要在维护窗口完成对应 `npm ci`，工具不自动安装或升级依赖。

发布前的空闲窗口检查（包含当日主运行、Harvest 及后续证据复核、通知和待执行步骤是否结束）与发布后的自然运行核验，目前还不在工具内，将由后续工作收进来；现有租约、生命周期和漂移检查不等于这两项核验已完成。

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
