# 发布与恢复

根包和两个子包使用统一版本。旧目录和命令名保留兼容，不代表独立版本。发布前检查两个包、Harvest Python、UI 与脱敏扫描。

## Windows 代码

先生成并检查差异清单，再应用：

```powershell
node tools/release.mjs plan --execution-root D:/Checkin/execution --observation-root D:/Checkin/observation --out observation/outputs/release-plan.json
node tools/release.mjs apply --manifest observation/outputs/release-plan.json --backup-root E:/CheckinBackups
node tools/release.mjs audit --manifest observation/outputs/release-plan.json
```

清单覆盖明确的源码、脚本、公开资源和包元数据。私有配置、Profile、账本、原始结果和 node_modules 不覆盖。应用时取得执行租约，计划后发生漂移则拒绝覆盖。不要提交含本机路径的清单。

运行副本中尚未进入源码的有效修复要先审阅并收敛。依赖变化需要在维护窗口完成对应 `npm ci`，工具不自动安装或升级依赖。

应用返回备份目录，回滚前确认没有后续代码改动：

```powershell
node tools/release.mjs rollback --backup E:/CheckinBackups/<本次备份目录>
```

只恢复代码和版本标记。新增文件移入 retired，保留恢复能力；实际签到记录不回滚。恢复后运行健康检查并只读核对面板。

## NAS 代码与数据

导出包包含 release.json，面板显示版本和提交。升级默认保留现有 compose；确需替换才使用 `-ReplaceCompose`。使用高级传输 overlay 的安装显式传入 `-UseWorkerTransport:$true`。

先发布 ledger，再发布 snapshot，最后提交 dashboard-generation.json；保留 dashboard-generation.previous.json。Manifest 引用精确账本前缀，不能单独截断 ledger。Windows 发布端与 NAS 读取端一起核验兼容性。

## 历史归档

先预览早于指定月份的已结束日报：

```powershell
node observation/scripts/archive-history.mjs --data-dir D:/Checkin/observation/outputs --before 2026-09
node observation/scripts/archive-history.mjs --data-dir D:/Checkin/observation/outputs --before 2026-09 --archive-root E:/CheckinBackups/history --apply
node observation/scripts/archive-history.mjs --verify E:/CheckinBackups/history/<归档目录>
node observation/scripts/archive-history.mjs --restore E:/CheckinBackups/history/<归档目录> --data-dir D:/Checkin/observation/outputs
```

保留未结案和结果不明的尝试；移动已结束旧日报，生成不可变的月度账本副本及 SHA-256 清单。恢复不覆盖已有不同记录。活跃账本、当前和上一代 manifest 保持不变。归档也按私有数据保护。

先在隔离目录演练。工具已有漂移拒绝、代码回滚、历史恢复及不明记录保留测试；不要通过清空状态或重复签到演练恢复。
