# Codex Bookmark Check-in

一个可由 Codex 部署的 Windows 每日书签签到模板。后台自动化使用独立 Chrome 配置，签到目标可以同时来自 Chrome 和 Edge。它会先询问用户签到书签所在的浏览器配置、上级文件夹和目标子文件夹，再在每次运行时重新读取这些目录，自动执行签到、登录恢复、验证码/问答处理、异常重试和结果汇总。项目不预设任何用户的文件夹名称。

公开仓库只保存通用引擎和站点适配器。账号、密码、Cookie、PIN、本机路径、签到结果、截图和通知密钥都只留在本机并被 Git 忽略。

## 推荐使用方式

1. 在 Windows 10/11 上安装 Chrome 和 Codex；如需读取 Edge 书签，保留桌面版 Edge 的本机配置。
2. 克隆本仓库并用 Codex 打开仓库目录。
3. 对 Codex 说：`按照 AGENTS.md，使用仓库内 deploy-bookmark-checkin 技能为我部署每日书签自动签到。`
4. Codex 会先运行不假设文件夹名称的只读环境预检，并分别列出候选 Chrome、Edge 书签目录。存在环境缺项时，它会解释影响和可选补全方式。
5. 在读取签到目标前，Codex 会优先询问使用哪个 Chrome 配置、是否附加 Edge 配置、哪个上级书签文件夹、哪些目标子文件夹；确认后才验证范围并继续其他问卷。不要在对话或配置文件中提供明文密码、Cookie、Token 或 PIN。
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

若 Edge 使用不同的目录名称，可同时验证独立范围：

```powershell
pwsh -NoProfile -File .\scripts\Test-Environment.ps1 `
  -ContainerFolderNames 'Chrome上级文件夹' `
  -TargetFolderNames 'Chrome目标目录' `
  -EdgeContainerFolderNames 'Edge上级文件夹' `
  -EdgeTargetFolderNames 'Edge目标目录'
```

## 运行模型

- 每次启动动态读取已选择的 Chrome 与 Edge 书签，因此后续新增书签会自动进入下一次任务；不同浏览器里的相同 URL 和相同站点会合并去重。
- 相同来源和相同逻辑签到入口会去重，仍为每个书签保留结果。
- 内置适配器覆盖 NexusPHP、New API、Linux DO OAuth、图片验证码、站内问答、Cloudflare/Turnstile，以及将“申请额度”作为每日签到动作的公益站流程。
- 未知站点先走通用入口发现；Codex 只把经过页面成功确认的规则写入本机 `config/config.local.json`。
- 书签暂未同步时可用本机 `configuredTargets` 临时补入 HTTPS 目标；复杂验证站可用 `disabledCheckinOrigins` 明确取消，登录成功即算完成的站点可用 `loginAsCheckinOrigins` 配置。需要每日退出并重新 OAuth 才发放奖励的站点使用 `oauthReloginCheckinRules`；规则可选择原生 Chrome 完成受浏览器验证保护的 OAuth，并且只在同源使用日志出现当天的预期奖励记录后确认成功。这些配置默认均为空。
- 同一个 OAuth 站点需要签到多个账号时，主书签账号使用 `oauthAccountIdentities` 标注身份，其他账号放入 `supplementalOAuthAccounts`。主身份可用 `automationUserDataDir` 显式绑定专属配置；所有专属账号都必须使用 `data/` 下互不重复的 Chrome 配置目录。运行器会逐个执行、核对账号 ID，并在统一回执中分别显示。完整匿名结构见 `config/config.local.example.json`。
- 多个站点如果使用同一个 L 站身份，可在本机 `config/config.local.json` 中用 `oauthSessionProfiles` 定义一个位于 `data/` 下的共享 Profile，再用 `oauthSiteSessionBindings` 将站点绑定到该会话名称。绑定到同一会话的站点会串行复用同一次 L 站登录；不同身份仍必须使用不同 Profile。共享会话不能与全局、补充账号或隔离站点 Profile 重复，避免账号串线。
- 原生 WAF/验证预热只处理已校验书签计划中的站点；空范围会拒绝运行，只有人工显式使用 `-AllConfigured` 才允许全量预热。若验证 Cookie 需要等待扩展下载，可在单个 `nativeChallengePreflight` 条目中设置 `reloadOnChallengeAfterSeconds`；脚本到时最多重载一次，且该值必须小于总等待时间。
- 单站重试、异常复查和任务级断点续跑只重新访问未确认目标。
- 用户明确完成当次人工验证后，可通过 `Run-Checkin.ps1 -ManualConfirmedOrigins 'https://example.com'` 将结果以“用户已确认手动完成”写回当天续跑报告；该状态保留审计字段，不冒充自动签到。同一来源存在多个账号时会拒绝来源级人工确认，避免把其他账号误报为完成。
- 限频站点会记录 `nextEligibleAt` 并按时间定向补跑；超时续跑只接受当天的新检查点，避免复用旧日报或重复整批执行。
- Windows 计划任务从签到时间起按小时做无副作用探测，用户级调度器按分钟探测；用户级模式由注册表与用户“启动”文件夹双入口、独立守护、PowerShell 看门狗和调度器恢复，两种模式都受每日次数上限和运行锁保护。
- 主 Chrome 和可选 Edge 书签文件只作为只读来源；后台运行始终使用独立 Chrome 配置。普通原生窗口禁用同步，只有已授权的保存密码恢复窗口会临时启用 Chrome 账户密码库。
- 默认不配置外部通知。用户可选择安全的命令型通知器，敏感值应从环境变量或凭据管理器读取。
- 主 Chrome 保存密码同步和外部问答搜索默认关闭；初始化问卷获得明确授权后才启用，未授权时不会读取密码库或访问搜索引擎。启用密码同步后，账户密码库中仍保持加密的匹配记录会桥接到独立配置的本地密码库，脚本不解密、输出或提交密码。
- 机器人 Chrome 默认关闭 Chromium 的本地大模型下载；限频重试采用有界指数退避，达到当日上限后转到次日计划时间，避免空转。

Chrome 保存密码和 OAuth 都无法恢复的站点，可选择使用 Windows DPAPI 凭据。运行 `scripts\Set-ProtectedSiteCredential.ps1 -Origin https://example.com` 交互录入，用户名和密码不会显示；密文只写入被 Git 忽略的 `data\credentials\`，且仅能由当前 Windows 用户解密。随后在本机 `config/config.json` 的 `protectedCredentialOrigins` 中加入站点，并按需配置 `protectedLoginVerificationPaths`。登录器只通过子进程标准输入接收临时明文，不写命令行、日志或额外的浏览器存储快照。

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

## 健康检查与外部调用

部署完成后，用户、Codex 或其他本机监控程序可以运行同一个只读健康检查：

```powershell
npm run --silent health
```

该命令只读取本机配置、书签文件是否可访问、主账号及补充账号的独立 Chrome 配置、调度入口与进程、调度心跳、当前已验证签到计划与当天最终结果是否一致、站点状态和通知隔离队列；它不会启动签到、修改配置或发送通知。标准输出始终是一个 JSON 对象，`schemaVersion` 当前为 `1`。`reportStatus` 会明确区分 `complete`、`complete_with_attention` 和 `incomplete`：完整报告中存在待重试或需关注站点时仍属于完整报告，调用方应读取 `reportStatus` 处理注意项，而不是把它误判为任务未完成。`healthy=true` 时退出码为 `0`；未初始化或任一基础设施健康检查失败时，`healthy=false`、`failedChecks` 列出失败项，退出码为 `2`；健康检查自身无法执行时退出码为 `3`。

外部调用方应在每日计划时间和预计任务时长之后执行，并同时判断退出码、`healthy` 和 `latestRunId`，不要仅凭进程存在判定签到成功。首次完整签到和调度安装尚未完成前，健康检查返回异常属于预期行为。检查结果可能包含本机路径和站点数量，适合留在本机监控系统，不应原样提交到公开 Issue 或仓库。

机器人 Chrome 未运行时，可先只读查看可清理缓存；确认后再显式应用。脚本只允许操作项目 `data` 下的独立资料目录，不删除 Cookie、保存密码、站点存储、IndexedDB 或 Service Worker：

```powershell
pwsh -NoProfile -File .\scripts\Clear-AutomationChromeCache.ps1
pwsh -NoProfile -File .\scripts\Clear-AutomationChromeCache.ps1 -Apply
```

不使用 GitHub 时，可在完成本地提交后生成只包含 Git 已跟踪文件的安全分享包：

```powershell
pwsh -NoProfile -File .\scripts\Export-PublicBundle.ps1
```

项目目前面向 Windows 10/11，使用桌面版 Chrome 执行自动化，并可附加读取桌面版 Edge 书签。电脑休眠或关机错过计划时间后，用户级调度器会在当天恢复登录后补跑。

自定义通知器应接受参数数组，支持 `{status}`、`{summary}`、`{taskId}`、`{name}`、`{source}` 和 `{eventKey}` 占位符。`{eventKey}` 按“日期 + 站点状态指纹”生成：相同结果重复执行会去重，异常解决后的新结果仍可发送。`executable` 只直接接受原生 `.exe/.com`；脚本通知应使用 `pwsh.exe -File script.ps1` 或 `node.exe script.mjs` 的参数形式，避免站点文本经过命令解释器。通知先原子写入本地 `data/notification-outbox`，再由独立投递器用逐参数 API 执行命令；同一任务同一天只投递最新回执，旧状态会标记为 `superseded`。命令需返回包含 `accepted=true` 或 `duplicate=true` 的 JSON 才算送达。缺失或不匹配 `payloadHash` 的条目会进入 `quarantine`，失败只按退避时间重发通知，不会重新运行浏览器签到。已送达回执默认保留 30 天，可通过 `notification.outboxRetentionDays` 调整；未送达和隔离条目不会被自动清理。`mode=none` 和预览模式不会发送、也不会创建 outbox 条目。实现不会使用 `Invoke-Expression`，也不会读取任何 Telegram Bot Token。

签到进程锁同时校验 PID、进程启动时间和随机 nonce。进程崩溃、PID 被系统复用或外层超时强杀后，旧锁会安全回收；仍在运行的签到进程会继续阻止并发访问同一个自动化 Chrome 配置。
