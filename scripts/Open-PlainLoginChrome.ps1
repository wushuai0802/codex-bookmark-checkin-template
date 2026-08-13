[CmdletBinding()]
param(
    [string[]]$Urls = @(),
    [switch]$Offscreen,
    [switch]$Minimized,
    [int]$RemoteDebuggingPort = 0,
    [switch]$DynamicRemoteDebuggingPort,
    [switch]$EnablePasswordManager,
    [switch]$DisableExtensions,
    [string]$UserDataDirOverride
)

$ErrorActionPreference = 'Stop'
if ($Offscreen -and $Minimized) { throw '不能同时指定离屏和最小化窗口。' }
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$closeSignal = Join-Path $root 'tmp\close-manual-session.signal'
$profilePath = if ($UserDataDirOverride) { [System.IO.Path]::GetFullPath($UserDataDirOverride) } else { [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir) }
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedRoot"
}

if (Test-Path -LiteralPath (Join-Path $root 'tmp\manual-session.json')) {
    [System.IO.File]::WriteAllText($closeSignal, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $manual = Get-CimInstance Win32_Process | Where-Object {
            $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$(Join-Path $root 'src\manual-session.mjs')*"
        }
    } while ($manual -and (Get-Date) -lt $deadline)
    if ($manual) { throw '旧的 Playwright 手动会话未能正常退出。' }
}

$existing = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'chrome.exe' -and $_.CommandLine -like "*$profilePath*"
}
if ($existing) { throw '机器人专用 Chrome 配置仍被其他进程占用。' }

$items = if ($Urls.Count -gt 0) {
    @($Urls | ForEach-Object {
        $uri = [uri]$_
        if ($uri.Scheme -notin @('http', 'https') -or -not $uri.Host) { throw "无效网址：$_" }
        [pscustomobject]@{ url = $uri.AbsoluteUri }
    })
}
else {
    @(& $node (Join-Path $root 'src\attention-urls.mjs') | ConvertFrom-Json)
}
$windowPosition = if ($Offscreen) { '-32000,-32000' } elseif ($Minimized) { '0,0' } else { '60,60' }
$arguments = @(
    "--user-data-dir=$profilePath",
    '--profile-directory=Default',
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-features=OptimizationGuideOnDeviceModel',
    '--force-renderer-accessibility',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    "--window-position=$windowPosition",
    '--window-size=1400,900'
)
if ($Minimized) {
    $arguments += '--start-minimized'
}
if (-not $EnablePasswordManager) {
    $arguments += '--disable-sync'
}
if ($DisableExtensions) {
    $arguments += '--disable-extensions'
}
if ($DynamicRemoteDebuggingPort) {
    $arguments += '--remote-debugging-port=0'
    $arguments += '--remote-debugging-address=127.0.0.1'
}
elseif ($RemoteDebuggingPort -gt 0) {
    $arguments += "--remote-debugging-port=$RemoteDebuggingPort"
    $arguments += '--remote-debugging-address=127.0.0.1'
    $arguments += "--remote-allow-origins=http://127.0.0.1:$RemoteDebuggingPort"
}
$arguments += @($items | ForEach-Object { [string]$_.url })

Start-Process -FilePath ([string]$config.chromeExecutable) -ArgumentList $arguments
Write-Output "已使用无自动化标记的原生 Chrome 打开 $(@($items).Count) 个待处理站点。"
