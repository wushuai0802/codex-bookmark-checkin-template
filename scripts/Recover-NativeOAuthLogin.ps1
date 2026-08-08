[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Provider,
    [string]$LoginUrl,
    [string]$AutomationUserDataDir,
    [string]$ExpectedAccountId,
    [string]$AccountKey,
    [string]$AccountLabel,
    [string]$UpstreamProvider
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'OAuth-AccountConfig.ps1')
. (Join-Path $PSScriptRoot 'Native-ChromeDebug.ps1')
$node = Resolve-CheckinNode $config
$binding = Resolve-OAuthAccountConfiguration $config $root $AccountKey
$providedProfilePath = if ($AutomationUserDataDir) { [System.IO.Path]::GetFullPath($AutomationUserDataDir) } else { $binding.AutomationUserDataDir }
$providedLoginUrl = if ($LoginUrl) { ([uri]$LoginUrl).AbsoluteUri } else { ([uri]$binding.LoginUrl).AbsoluteUri }
$tupleChecks = [ordered]@{
    Origin = @(([uri]$Origin).GetLeftPart([System.UriPartial]::Authority), $binding.Origin)
    Provider = @($Provider, $binding.Provider)
    LoginUrl = @($providedLoginUrl, ([uri]$binding.LoginUrl).AbsoluteUri)
    AutomationUserDataDir = @($providedProfilePath, $binding.AutomationUserDataDir)
    ExpectedAccountId = @($ExpectedAccountId, $binding.AccountId)
    AccountLabel = @($AccountLabel, $binding.AccountLabel)
    UpstreamProvider = @($UpstreamProvider, $binding.UpstreamProvider)
}
foreach ($entry in $tupleChecks.GetEnumerator()) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Value[0])) { continue }
    $comparison = if ($entry.Key -in @('Origin', 'LoginUrl', 'AutomationUserDataDir')) { [System.StringComparison]::OrdinalIgnoreCase } else { [System.StringComparison]::Ordinal }
    if (-not [string]::Equals([string]$entry.Value[0], [string]$entry.Value[1], $comparison)) {
        throw "OAuth 账号绑定不匹配：$($entry.Key) 与 accountKey=$AccountKey 的配置不一致。"
    }
}
$Origin = $binding.Origin
$Provider = $binding.Provider
$LoginUrl = $binding.LoginUrl
$AutomationUserDataDir = $binding.AutomationUserDataDir
$ExpectedAccountId = $binding.AccountId
$AccountLabel = $binding.AccountLabel
$UpstreamProvider = $binding.UpstreamProvider
$originUri = [uri]$Origin
if ($originUri.Scheme -ne 'https' -or -not $originUri.Host -or $originUri.UserInfo) {
    throw '原生 OAuth 恢复来源无效。'
}
if ([string]::IsNullOrWhiteSpace($Provider) -or $Provider.Length -gt 40 -or $Provider -match '[\r\n]') {
    throw '原生 OAuth 提供商无效。'
}
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$rule = $config.oauthReloginCheckinRules.PSObject.Properties[$originValue].Value
if ($null -eq $rule -or $rule.nativeBrowser -ne $true) {
    throw '目标站点没有启用原生浏览器 OAuth 恢复。'
}
$targetUrl = if ($LoginUrl) { [uri]$LoginUrl } else { [uri]::new($originUri, '/login') }
if ($targetUrl.Scheme -ne 'https' -or $targetUrl.UserInfo -or
    $targetUrl.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '原生 OAuth 登录地址不属于目标站点。'
}

$profilePath = [System.IO.Path]::GetFullPath($AutomationUserDataDir)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedRoot"
}
function Get-AutomationChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}
if ((Get-AutomationChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 正被占用，无法执行原生 OAuth 恢复。'
}

function Close-AutomationChrome {
    $targets = @(Get-AutomationChromeProcesses)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AutomationChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) {
        $remainingIds = @($remaining.ProcessId)
        $remainingRoots = @($remaining | Where-Object { $remainingIds -notcontains $_.ParentProcessId })
        foreach ($processInfo in $remainingRoots) {
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

$nodeExitCode = 1
try {
    [void](Reset-NativeChromeDebugPort $profilePath)
    $openParameters = @{
        Offscreen = $true
        DynamicRemoteDebuggingPort = $true
        Urls = @($targetUrl.AbsoluteUri)
        UserDataDirOverride = $profilePath
    }
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openParameters | Out-Null
    $debugPort = Wait-NativeChromeDebugPort $profilePath 25
    $output = & $node (Join-Path $root 'src\native-oauth-login.mjs') $debugPort $originValue $Provider $ExpectedAccountId $AccountKey $AccountLabel $UpstreamProvider $targetUrl.AbsoluteUri
    $nodeExitCode = $LASTEXITCODE
    if ($output) { Write-Output $output }
}
finally {
    Close-AutomationChrome
}

exit $nodeExitCode
