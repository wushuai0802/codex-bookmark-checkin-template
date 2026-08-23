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

function Invoke-NativeOAuthRound {
    $roundExitCode = 1
    $roundOutput = @()
    try {
        [void](Reset-NativeChromeDebugPort $profilePath)
        $debugPort = Get-NativeChromeDebugPort
        $openParameters = @{
            Offscreen = $true
            EnablePasswordManager = $true
            RemoteDebuggingPort = $debugPort
            Urls = @($targetUrl.AbsoluteUri)
            UserDataDirOverride = $profilePath
        }
        & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openParameters | Out-Null
        $debugPort = Wait-NativeChromeDebugPort $profilePath $debugPort 25
        $roundOutput = @(& $node (Join-Path $root 'src\native-oauth-login.mjs') $debugPort $originValue $Provider $ExpectedAccountId $AccountKey $AccountLabel $UpstreamProvider $targetUrl.AbsoluteUri)
        $roundExitCode = $LASTEXITCODE
    }
    finally {
        Close-AutomationChrome
    }
    [pscustomobject]@{ ExitCode = $roundExitCode; Output = @($roundOutput) }
}

function Get-LastOAuthJsonResult([object[]]$Lines) {
    $items = @($Lines)
    for ($index = $items.Count - 1; $index -ge 0; $index--) {
        try {
            $value = ([string]$items[$index] | ConvertFrom-Json -ErrorAction Stop)
            if ($null -ne $value) { return $value }
        }
        catch { }
    }
    return $null
}

function Test-GenericOAuthFailureReason([string]$Reason) {
    return [string]::IsNullOrWhiteSpace($Reason) -or $Reason -in @(
        '原生 Chrome 后台 OAuth 恢复未完成',
        '后台 OAuth 未在限定时间内完成'
    )
}

function Get-OAuthFailureCode([object]$PlainResult, [object]$NativeResult, [string]$Reason) {
    if ($PlainResult -and $PlainResult.upstreamLoginRequired -eq $true) { return 'upstream_login_required' }
    if ($PlainResult -and $PlainResult.authorizationRequired -eq $true) { return 'upstream_authorization_required' }
    foreach ($result in @($PlainResult, $NativeResult)) {
        if ($result -and [string]$result.failureCode -match '^(account_mismatch|configuration_mismatch|upstream_login_required|upstream_authorization_required|managed_challenge|oauth_timeout|profile_busy|browser_startup|site_flow_changed|oauth_recovery_failed)$') {
            return [string]$result.failureCode
        }
    }
    if ($Reason -match '账号.*(?:不匹配|不符)|配置.*不一致|绑定不匹配') { return 'account_mismatch' }
    if ($Reason -match '上游登录.*失效|需要人工确认一次 .* 登录') { return 'upstream_login_required' }
    if ($Reason -match '授权') { return 'upstream_authorization_required' }
    if ($Reason -match '验证|Turnstile|Challenge') { return 'managed_challenge' }
    if ($Reason -match 'Chrome.*占用') { return 'profile_busy' }
    if ($Reason -match '限定时间|超时|未完成') { return 'oauth_timeout' }
    if ($Reason -match '没有可用.*浏览器|没有找到目标登录页') { return 'browser_startup' }
    if ($Reason -match '没有找到唯一|无法唯一识别|退出动作|退出接口') { return 'site_flow_changed' }
    return 'oauth_recovery_failed'
}

function Convert-PlainOAuthFailure([object]$PlainResult, [object]$NativeResult) {
    $reasons = @(
        if ($PlainResult -and $PlainResult.reason) { [string]$PlainResult.reason }
        if ($NativeResult -and $NativeResult.reason) { [string]$NativeResult.reason }
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $reason = @($reasons | Where-Object { -not (Test-GenericOAuthFailureReason $_) } | Select-Object -First 1)[0]
    if ([string]::IsNullOrWhiteSpace($reason)) { $reason = @($reasons | Select-Object -First 1)[0] }
    if ([string]::IsNullOrWhiteSpace($reason)) { $reason = '原生 Chrome 后台 OAuth 恢复未完成' }
    $failureCode = Get-OAuthFailureCode $PlainResult $NativeResult $reason
    [pscustomobject]@{
        origin = $originValue
        provider = $Provider
        status = 'needs_attention'
        finalUrl = $originValue
        accountKey = $AccountKey
        accountId = $ExpectedAccountId
        accountLabel = $AccountLabel
        upstreamProvider = $UpstreamProvider
        reason = $reason.Substring(0, [Math]::Min(240, $reason.Length))
        failureCode = $failureCode
    } | ConvertTo-Json -Compress
}

$firstRound = Invoke-NativeOAuthRound
if ($firstRound.ExitCode -eq 0) {
    if ($firstRound.Output) { Write-Output $firstRound.Output }
    exit 0
}

# Remote debugging can itself cause a managed challenge even when
# navigator.webdriver is false.  Retry Linux DO once in an ordinary off-screen
# Chrome window and interact only with exact accessibility controls.  No OAuth
# URL, callback code, cookie, token, or page body leaves that process.
if ($Provider -eq 'LinuxDO') {
    $plainResult = $null
    $nativeResult = Get-LastOAuthJsonResult $firstRound.Output
    $plainExitCode = 1
    try {
        $plainOutput = @(& (Join-Path $PSScriptRoot 'Invoke-PlainOAuthAccessibility.ps1') `
            -Origin $originValue -Provider $Provider -UpstreamProvider $UpstreamProvider `
            -LoginUrl $targetUrl.AbsoluteUri -AutomationUserDataDir $profilePath)
        $plainExitCode = $LASTEXITCODE
        if ($plainOutput.Count -gt 0) {
            $plainResult = $plainOutput[-1] | ConvertFrom-Json
        }
    }
    catch {
        $plainResult = [pscustomobject]@{ reason = '原生 Chrome 后台 OAuth 恢复未完成' }
    }
    if ($plainExitCode -eq 0 -and $plainResult.status -eq 'callback_reached') {
        $verificationRound = Invoke-NativeOAuthRound
        if ($verificationRound.Output) { Write-Output $verificationRound.Output }
        exit $verificationRound.ExitCode
    }
    Write-Output (Convert-PlainOAuthFailure $plainResult $nativeResult)
    exit 2
}

if ($firstRound.Output) { Write-Output $firstRound.Output }
exit $firstRound.ExitCode
