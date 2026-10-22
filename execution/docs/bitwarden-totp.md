# Bitwarden 二级验证辅助

这是原生签到执行层的可选恢复入口，默认关闭。TOTP 提供器只允许以下已审阅的站点和协议；具体消费者仍须核实真实验证需求、当前账号和 Profile。已有当日完成证据不读取密码库，也不再次提交签到。

| 站点来源 | 密码库条目名称 | 固定 adapterId |
| --- | --- | --- |
| `https://piggo.me` | `piggo.me` | `piggo-nexus-stepup-v1` |
| `https://www.hddolby.com` | `www.hddolby.com` | `hddolby-nexus-stepup-v1` |
| `https://hhanclub.net` | `hhanclub.net` | `hhclub-nexus-login-v1` |

只支持每站一个 `site-default` 账号。GitHub 等其他来源未加入允许清单；相似域名、不同子域名和未经审阅的协议也不能取码。HHCLUB 的普通登录还包含用户名、密码和图片验证码，TOTP 辅助不能替代这些步骤或绕过验证。

配置仅放运行副本的私有 config：`bitwardenTotp` 登记 CLI 路径、共享独立客户端和 OS 保护凭据路径、密码库 HTTPS 地址；各站 `routes` 登记明确 opt-in、条目 UUID、条目名称、`accountKey`、Profile 哈希和 `adapterId`。消费者另有各自的恢复 opt-in。凭据目录位于运行副本 `data/bitwarden`，CLI 位于 `tools/bitwarden-cli`；源码 checkout、目录 junction、符号链接和外部路径不能作为密码库运行目录。

猪猪原有 schema 1 凭据及旧调用绑定保持兼容，且只能用于猪猪。其他站点必须使用 DPAPI 保护的 schema 2 payload；其 `authorizations` 数组逐项保存以下完整元组：

```text
origin, accountKey, profileBinding, itemId, itemName, adapterId
```

请求绑定、私有路由和已封存元组必须完全一致。配置中增加一条路由或更换条目 UUID 不能取得新授权；重复来源、额外字段、错误协议、不同账号或 Profile 均在调用 CLI 前拒绝。多站共用同一个 Windows 用户、密码库会话、`sessionFile` 和独立客户端，不复制密码库凭据到 Chrome。新增授权需要单独、明确的本机登记，不能由 `Unlock` 自动扩大。

会话由当前Windows用户DPAPI保护，并绑定Windows SID、密码库账号、服务地址、站点、条目UUID和Profile。没有人为的每日或两小时到期；密码库CLI锁定、注销、授权撤销或账户变化仍须停止。不会保存主密码或导出TOTP种子。独立CLI的锁与手机/浏览器扩展的本地锁相互独立。

遇 2FA 时先检查客户端，按同一密码库账号和共享客户端每天同步一次加密缓存，再核实账号后取指定 UUID 的当前验证码。三个站点不会各自重复同步整库；同步或取码与人工解锁共用 `provider.lock`。验证码仅经内存交给固定同源认证接口，不写入参数、URL、结果、截图或日志。消费者负责协议、账户和证据检查；猪猪认证后关闭 API 上下文，再以原 Profile 只读重开确认挑战解除。签/未签回执必须先通过原生守卫登记和复核，未签才至多续跑一次原成熟签到。认证请求拒绝或未知后，当日不重放；次日正常重新评估。

猪猪保留原有至少 6 秒的取码余量；HDDolby、HHCLUB 为认证前的只读和绑定检查预留至少 12 秒。跨过验证码窗口时最多等待并重读一次，旧码不进入消费者，不进行无限循环。

日常使用既有每日调度，不新增并行签到任务。真实辅助凭据失效会在既有结果/通知中提示解锁，不把通知失败或密码库不可用作为再次提交的理由。

HDDolby 消费者只处理实际 `/take2fa.php` 的同源 POST 表单，保留站点提供的隐藏字段，严格核对返回路径。先用本人账户栏确认今天已签或未签；已签直接结束，结果不明不取码。认证后重新读取本人日状态，确认未签才接着走原签到流程。直接打开没有有效返回路径的验证码表单不触发自动认证。

HHCLUB 消费者仅增强 `/login.php` 到 `/takelogin.php` 的原密码登录。核对私有 opt-in 的本人账号 ID、归一化用户名哈希、原 Profile 和完整表单后，使用原图片验证码识别器在内存完成图片码，再填写 TOTP。图片验证码格式或置信度不达标时不读 TOTP、不提交。

HHCLUB 首页的“签到得憨豆”入口在成功后仍保留，因此只用于确认登录身份，不能生成已签或未签证据。正常每日首次补签复用父任务已有的 attemptId、执行租约、主锁及历史审计，先只读确认是否需要登录；确需恢复时关闭原浏览器，调用一次原登录恢复，再确认本人账号后执行一次原成熟流程，保留其正式回执。当前父任务以外的未决提交、当天已完成或损坏审计都阻止该入口；没有新增第二套签到账本。结果不明的重试仍需要可靠当日日证据，不会把首页未知改为未签。只读核验入口始终不会登录或取码。

这些消费者要求当前观测层租约和执行层主锁、当前准确书签范围、未暂停状态、原账号/Profile及私有配置保持一致。认证审计按站点和 Profile 保存不含验证码的 `pending/accepted/rejected/unknown` 状态。进程中断或未知回执保留当日防重放记录，不能通过删除审计来重新认证。

在运行副本查看全局和各站开关状态：`pwsh -NoProfile -File scripts/Manage-BitwardenTotp.ps1 -Action Status`。这只读取私有配置和凭据文件是否存在，不解密凭据或访问密码库；开关状态不等于站点已签到。

在本机交互恢复授权：`pwsh -NoProfile -File scripts/Manage-BitwardenTotp.ps1 -Action Unlock`。在该终端输入密码库主密码和必要的登录/二次验证；不用复制 session。原始 session 输出由脚本捕获。脚本只刷新会话和创建时间，保留原有授权清单，且仅恢复与封存元组一致的路由；新加入配置但未授权的条目仍关闭。

全局停用辅助：`pwsh -NoProfile -File scripts/Manage-BitwardenTotp.ps1 -Action Disable`。该操作停用所有 Bitwarden 路由与对应辅助 opt-in，并锁定独立 CLI，保留原签到、账户、Profile 和历史回执。解锁、停用和自动取码相互排斥，配置和保护凭据通过同目录临时文件替换。

运营开关同步到运行配置 `config.json` 和私有覆盖 `config.local.json`，包括原生恢复及 `siteTwoFactorRecovery` 的 Bitwarden 项，避免重新初始化时覆盖停用状态或重新指向旧会话。私有覆盖中的面板设置、其他账号配置和非 Bitwarden 恢复项保持原值。

升级或回滚应备份私有配置，并用项目正式发布工具同步源码。回滚辅助入口或私有opt-in即可恢复原流程；不要清除成功记录、浏览器凭据或签到journal来制造新测试。
