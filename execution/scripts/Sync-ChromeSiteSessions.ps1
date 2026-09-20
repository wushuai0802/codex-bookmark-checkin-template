[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateCount(1, 20)]
    [string[]]$TargetUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$sourceRoot = [System.IO.Path]::GetFullPath([string]$config.sourceUserDataDir)
$sourceProfile = Join-Path $sourceRoot ([string]$config.sourceProfileDirectory)
$targetRoot = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
$chromeExecutable = [System.IO.Path]::GetFullPath([string]$config.chromeExecutable)
$helper = Join-Path $PSScriptRoot 'Sync-ChromeSiteSession.mjs'
$tmpRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'tmp')).TrimEnd('\')
$tmpPrefix = "$tmpRoot\"

foreach ($required in @($helper, $chromeExecutable, (Join-Path $sourceRoot 'Local State'), $sourceProfile, (Join-Path $targetRoot 'Local State'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "会话同步所需文件不存在：$required" }
}

$sourceState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $sourceRoot 'Local State') | ConvertFrom-Json
$targetState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $targetRoot 'Local State') | ConvertFrom-Json
if (-not $sourceState.os_crypt.encrypted_key -or $sourceState.os_crypt.encrypted_key -ne $targetState.os_crypt.encrypted_key) {
    throw '源 Chrome 与机器人配置的加密主密钥不一致，拒绝同步会话。'
}

$allChromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'")
$targetChromeProcesses = @($allChromeProcesses | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$targetRoot*" })
if ($targetChromeProcesses.Count -gt 0) {
    throw '机器人 Chrome 配置正在使用中，请等待当前签到或登录恢复结束后再同步。'
}
$sourceChromeProcesses = @($allChromeProcesses | Where-Object {
    -not $_.CommandLine -or $_.CommandLine -notlike "*--user-data-dir=*$targetRoot*"
})
if ($sourceChromeProcesses.Count -gt 0) {
    throw '主 Chrome 仍在运行。请正常关闭 Chrome 后再同步，避免复制不一致的会话数据库。'
}

$results = @()
foreach ($rawTarget in $TargetUrl) {
    $uri = [Uri]$rawTarget
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.UserInfo) {
        throw "目标页面必须是无凭据 HTTPS 地址：$rawTarget"
    }

    $shadowRoot = Join-Path $tmpRoot "chrome-session-shadow-$PID-$([Guid]::NewGuid().ToString('N'))"
    $sessionStoragePath = Join-Path $tmpRoot "chrome-session-storage-$PID-$([Guid]::NewGuid().ToString('N')).json"
    $resolvedShadowRoot = [System.IO.Path]::GetFullPath($shadowRoot)
    $resolvedSessionStoragePath = [System.IO.Path]::GetFullPath($sessionStoragePath)
    if (-not $resolvedShadowRoot.StartsWith($tmpPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $resolvedSessionStoragePath.StartsWith($tmpPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '临时会话路径越界，拒绝继续。'
    }

    try {
        New-Item -ItemType Directory -Path (Join-Path $shadowRoot 'Default\Network') -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourceRoot 'Local State') -Destination (Join-Path $shadowRoot 'Local State') -Force
        foreach ($relative in @('Preferences', 'Secure Preferences', 'Login Data', 'Login Data For Account', 'Web Data', 'Account Web Data', 'Affiliation Database')) {
            $sourceItem = Join-Path $sourceProfile $relative
            if (Test-Path -LiteralPath $sourceItem) {
                Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $shadowRoot "Default\$relative") -Force
            }
        }
        foreach ($relative in @('Local Storage', 'Session Storage', 'Sessions', 'Accounts', 'Sync Data')) {
            $sourceItem = Join-Path $sourceProfile $relative
            if (Test-Path -LiteralPath $sourceItem) {
                Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $shadowRoot "Default\$relative") -Recurse -Force
            }
        }
        $sourceCookies = Join-Path $sourceProfile 'Network\Cookies'
        if (Test-Path -LiteralPath $sourceCookies) {
            Copy-Item -LiteralPath $sourceCookies -Destination (Join-Path $shadowRoot 'Default\Network\Cookies') -Force
        }

        $raw = @(& node $helper $shadowRoot $targetRoot $uri.AbsoluteUri $chromeExecutable $sessionStoragePath)
        if ($LASTEXITCODE -ne 0) { throw "站点会话同步失败，退出码 $LASTEXITCODE：$($uri.Host)" }
        $value = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
        if (-not $value.sourceAuthenticated -or -not $value.targetAuthenticated) {
            throw "站点会话未通过登录验证：$($uri.Host)"
        }
        $results += [pscustomobject]@{
            origin = $uri.GetLeftPart([UriPartial]::Authority)
            copiedCookies = [int]$value.copiedCookies
            copiedLocalStorageEntries = [int]$value.copiedLocalStorageEntries
            copiedSessionStorageEntries = [int]$value.copiedSessionStorageEntries
            sourceAuthenticated = [bool]$value.sourceAuthenticated
            targetAuthenticated = [bool]$value.targetAuthenticated
            apiSelfAuthenticated = [bool]$value.targetApiSelfAuthenticated
        }
    }
    finally {
        foreach ($temporaryPath in @($resolvedShadowRoot, $resolvedSessionStoragePath, "$resolvedSessionStoragePath.bak")) {
            if (-not $temporaryPath.StartsWith($tmpPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw '临时清理目标越界。'
            }
            if (Test-Path -LiteralPath $temporaryPath) {
                $item = Get-Item -LiteralPath $temporaryPath -Force
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "拒绝清理重解析点：$temporaryPath"
                }
                Remove-Item -LiteralPath $temporaryPath -Recurse -Force
            }
        }
    }
}

$results | ConvertTo-Json -Depth 5
