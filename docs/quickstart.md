# 快速开始

这是一个项目：execution 执行签到，observation 提供调度入口、对账和面板。Harvest 是可选集成；独立运行执行层不依赖 Harvest。

## 环境和书签

准备 Node.js 24、Chrome、PowerShell。在仓库根目录执行：

```powershell
npm ci --prefix execution
npm ci --prefix observation
pwsh -NoProfile -File execution/scripts/Test-Environment.ps1
```

先确定 Chrome Profile、书签父目录完整路径及签到子目录。父目录重名时使用路径、ID 或 GUID 精确限定。预检不会替你安装软件或修改 Chrome。

复制 `execution/setup/answers.example.json` 为被 Git 忽略的 `answers.json`，填写预检确认的非敏感选项，不填写密码或 Cookie。

```powershell
pwsh -NoProfile -File execution/scripts/Initialize-Checkin.ps1
```

初始化生成私有配置并执行书签 dry-run。检查目标列表后准备专用会话：

```powershell
pwsh -NoProfile -File execution/scripts/Initialize-BrowserProfile.ps1
pwsh -NoProfile -File execution/scripts/Open-ManualLogin.ps1
```

完成登录并关闭专用窗口后再正式验收。已有安装复用现有配置与 Profile，不重新初始化或复制其他浏览器的 Cookie。

## 连接观测层

从源码运行时可直接绑定两个包目录：

```powershell
node tools/configure-runtime.mjs --execution-root ./execution --observation-root ./observation
node observation/scripts/run-v1-engine.mjs --dry-run
node observation/scripts/run-v1-engine.mjs --execute
```

命令中的 v1 保留旧安装兼容，只有一个执行所有者。绑定工具保留账号配置，拒绝静默更换已登记目录，并保存绑定前备份。独立运行副本改用实际路径。

先通过正式执行验收，再安装原有计划任务：

```powershell
pwsh -NoProfile -File execution/scripts/Install-ScheduledTask.ps1
npm --prefix execution run --silent health
```

`healthy=true` 说明执行设施正常，不等于所有外部站点当天都成功。

## 可选面板、Harvest 与手动操作

本机面板使用 `npm --prefix observation run dashboard`。NAS 安装见 [部署文档](../observation/docs/nas-deployment.md)，面板不保存浏览器凭据。

Harvest 对账单独配置已确认的 PT 书签目录与数据库只读查询。保留全部 PT 签到能力，不使用 Harvest 用户 ID 绑定本站账号。`ptFallbackOnlyEnabled` 默认关闭，确认会话和范围后再启用。

面板请求需要 Windows 轮询。现有同步任务每次触发时可调用：

```powershell
pwsh -NoProfile -File observation/scripts/Invoke-DashboardOperations.ps1 -SshTarget nas-checkin
```

`nas-checkin` 是自己的 SSH 别名。命令复用 SSH 调用 NAS 容器内队列工具，默认容器名 `checkin-fabric-dashboard`，不另建浏览器凭据服务。调试可直接运行 `process-dashboard-operations.mjs --ssh-target nas-checkin`。

支持的站点在 PT 行或任务详情显示操作按钮。已完成任务只读复核；不明提交不能直接重试。登录窗口出现在执行电脑，完成登录并关闭窗口后选择“登录后继续”。离线请求显示等待，过期后不会跨业务日执行。

## 检查与更新

```powershell
npm test
npm run lint
python -m unittest discover -s observation/tests -p '*_test.py'
pwsh -NoProfile -File execution/scripts/Scan-PublicSafety.ps1 -Root .
```

配置、Profile、原始记录、日志、备份均不提交 Git。更新独立运行副本使用发布清单，见 [发布与恢复](release-and-recovery.md)。
