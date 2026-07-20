# Codex Bookmark Check-in

一个可由 Codex 部署的 Windows + Chrome 每日书签签到模板。它会先询问用户签到书签所在的上级文件夹和目标子文件夹，再在每次运行时重新读取这些目录，自动执行签到、登录恢复、验证码/问答处理、异常重试和结果汇总。项目不预设任何用户的文件夹名称。

公开仓库只保存通用引擎和站点适配器。账号、密码、Cookie、PIN、本机路径、签到结果、截图和通知密钥都只留在本机并被 Git 忽略。

## 推荐使用方式

1. 在 Windows 10/11 上安装 Chrome 和 Codex。
2. 克隆本仓库并用 Codex 打开仓库目录。
3. 对 Codex 说：`按照 AGENTS.md，使用仓库内 deploy-bookmark-checkin 技能为我部署每日书签自动签到。`
4. Codex 会先运行不假设文件夹名称的只读环境预检，并列出候选 Chrome 书签目录。存在环境缺项时，它会解释影响和可选补全方式。
5. 在读取签到目标前，Codex 会优先询问使用哪个 Chrome 配置、哪个上级书签文件夹、哪些目标子文件夹；确认后才验证范围并继续其他问卷。不要在对话或配置文件中提供明文密码、Cookie、Token 或 PIN。
6. Codex 完成可见登录测试、逐站验收、异常恢复测试和隐藏调度安装后，才会宣布部署完成。

也可以先手动运行只读预检：

```powershell
pwsh -NoProfile -File .\scripts\Test-Environment.ps1
```

确认文件夹名称后，可再次验证所选范围：

```powershell
pwsh -NoProfile -File .\scripts\Test-Environment.ps1 `
  -ContainerFolderNames '你的上级文件夹' `
  -TargetFolderNames '目录一','目录二'
```

## 运行模型

- 每次启动动态读取书签，因此后续新增书签会自动进入下一次任务。
- 相同来源和相同逻辑签到入口会去重，仍为每个书签保留结果。
- 内置适配器覆盖 NexusPHP、New API、Linux DO OAuth、图片验证码、站内问答、Cloudflare/Turnstile 和部分公开站点特殊流程。
- 未知站点先走通用入口发现；Codex 只把经过页面成功确认的规则写入本机 `config/config.local.json`。
- 单站重试、异常复查和任务级断点续跑只重新访问未确认目标。
- 默认不配置外部通知。用户可选择安全的命令型通知器，敏感值应从环境变量或凭据管理器读取。

## 目录边界

- `config/site-rules.public.json`：可公开复用的站点规则。
- `config/config.json`：由初始化流程生成的本机配置，不提交。
- `config/config.local.json`：本机新增适配规则，不提交。
- `config/config.local.example.json`：私有站点规则示例。
- `data/`、`logs/`、`tmp/`、`outputs/`：本机状态、日志、截图和结果，不提交。
- `skills/deploy-bookmark-checkin/`：供 Codex 使用的部署技能。

## 开发与检查

```powershell
npm install
npm test
pwsh -NoProfile -File .\scripts\Scan-PublicSafety.ps1
```

不使用 GitHub 时，可在完成本地提交后生成只包含 Git 已跟踪文件的安全分享包：

```powershell
pwsh -NoProfile -File .\scripts\Export-PublicBundle.ps1
```

项目目前面向 Windows 10/11 与桌面版 Chrome。电脑休眠或关机错过计划时间后，用户级调度器会在当天恢复登录后补跑。

自定义通知器应接受参数数组，支持 `{status}`、`{summary}`、`{taskId}`、`{name}` 和 `{source}` 占位符。实现不会使用 `Invoke-Expression`，也不会读取任何 Telegram Bot Token。
