[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Provider,
    [Parameter(Mandatory = $true)][string]$UpstreamProvider,
    [Parameter(Mandatory = $true)][string]$LoginUrl,
    [Parameter(Mandatory = $true)][string]$AutomationUserDataDir,
    [ValidateRange(30, 180)][int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$originUri = [uri]$Origin
$loginUri = [uri]$LoginUrl
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$profilePath = [System.IO.Path]::GetFullPath($AutomationUserDataDir)
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or
    $loginUri.Scheme -ne 'https' -or $loginUri.UserInfo -or
    $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '后台 OAuth 登录地址无效。'
}
if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedRoot"
}
if ([string]::IsNullOrWhiteSpace($Provider) -or $Provider.Length -gt 40 -or $Provider -match '[\r\n]' -or
    [string]::IsNullOrWhiteSpace($UpstreamProvider) -or $UpstreamProvider.Length -gt 40 -or $UpstreamProvider -match '[\r\n]') {
    throw '后台 OAuth 提供商无效。'
}

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-ProfileChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}

function Get-ChromeAutomationRoots {
    $profileProcessIds = @(Get-ProfileChromeProcesses | Select-Object -ExpandProperty ProcessId)
    if ($profileProcessIds.Count -eq 0) { return @() }
    @(
        Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -in $profileProcessIds -and $_.MainWindowHandle -ne 0
        } | ForEach-Object {
            try { [System.Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) }
            catch { $null }
        } | Where-Object { $null -ne $_ }
    )
}

function Get-AllAutomationElements {
    $elements = @()
    foreach ($automationRoot in @(Get-ChromeAutomationRoots)) {
        try {
            $elements += @($automationRoot.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            ))
        }
        catch { }
    }
    return @($elements)
}

function Get-UniqueNamedControl([string[]]$Names) {
    $allowed = @{}
    foreach ($name in $Names) { $allowed[$name] = $true }
    $found = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            $name = [string]$element.Current.Name
            if (-not $allowed.ContainsKey($name) -or -not $element.Current.IsEnabled) { continue }
            $type = $element.Current.ControlType
            if ($type -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::Hyperlink,
                [System.Windows.Automation.ControlType]::CheckBox
            )) { continue }
            $found += $element
        }
        catch { }
    }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Get-UniqueProviderControl([string[]]$Names) {
    $found = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            $name = [string]$element.Current.Name
            $nameMatches = @($Names | Where-Object { $name -eq $_ -or $name.EndsWith(" $_", [System.StringComparison]::Ordinal) }).Count -gt 0
            if (-not $nameMatches -or -not $element.Current.IsEnabled) { continue }
            if ($element.Current.ControlType -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::Hyperlink
            )) { continue }
            $found += $element
        }
        catch { }
    }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Invoke-AccessibilityControl([System.Windows.Automation.AutomationElement]$Element) {
    if ($null -eq $Element) { return $false }
    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return $true
    }
    catch { }
    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($pattern.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $pattern.Toggle() }
        return $true
    }
    catch { }
    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $pattern.DoDefaultAction()
        return $true
    }
    catch { return $false }
}

function Get-PrivateCurrentUri {
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit) { continue }
            $name = [string]$element.Current.Name
            $automationId = [string]$element.Current.AutomationId
            if ($name -notmatch '^(Address and search bar|地址栏|地址和搜索栏|網址列|網址和搜尋列)$' -and $automationId -ne 'view_1022') { continue }
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $raw = [string]$pattern.Current.Value
            if ($raw -notmatch '^[a-z][a-z0-9+.-]*://' -and $raw -match '^[A-Za-z0-9.-]+(?:/|$)') { $raw = "https://$raw" }
            $uri = $null
            if ([uri]::TryCreate($raw, [System.UriKind]::Absolute, [ref]$uri)) { return $uri }
        }
        catch { }
    }
    return $null
}

function Close-ProfileChrome {
    $targets = @(Get-ProfileChromeProcesses)
    $targetIds = @($targets.ProcessId)
    $processRoots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $processRoots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-ProfileChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) {
        $remainingIds = @($remaining.ProcessId)
        $remainingRoots = @($remaining | Where-Object { $remainingIds -notcontains $_.ParentProcessId })
        foreach ($processInfo in $remainingRoots) {
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

if ((Get-ProfileChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 正被占用，无法执行后台 OAuth 恢复。'
}

$providerLabels = @(
    "使用 $Provider 继续", "使用 $Provider 登录", "使用 $Provider 登入",
    "Continue with $Provider", "Sign in with $Provider", "Log in with $Provider"
)
if ($Provider -match '^LinuxDO$') {
    $providerLabels += @('使用 Linux DO 继续', '使用 Linux DO 登录', '使用 Linux DO 登入', 'Continue with Linux DO')
}
$upstreamLabels = @(
    "使用 $UpstreamProvider 继续", "使用 $UpstreamProvider 登录", "使用 $UpstreamProvider 登入",
    "Continue with $UpstreamProvider", "Sign in with $UpstreamProvider", "Log in with $UpstreamProvider"
)
$authorizationLabels = @('同意', '确认授权', '同意并继续', '继续', 'Approve', 'Continue', '允许', '授权', 'Allow', 'Authorize')
$challengeLabels = @('Verify you are human', '验证您是真人', '確認您是真人', '验证你是真人', '確認你是真人')
$providerInvoked = $false
$providerInvokeCount = 0
$upstreamLoginAttempted = $false
$upstreamSavedLoginSubmitAttempted = $false
$resumeTargetAfterUpstream = $false
$authorizationClicks = 0
$challengeInteractions = 0
$callbackReached = $false
$upstreamLoginRequired = $false
$authorizationRequired = $false
$lastAuthorizationAt = [datetime]::MinValue

try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
        -Offscreen -EnablePasswordManager -Urls @($loginUri.AbsoluteUri) -UserDataDirOverride $profilePath | Out-Null
    $windowDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) {
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-ChromeAutomationRoots).Count -eq 0) { throw '原生 Chrome 没有可用的无障碍窗口。' }

    $providerDeadline = (Get-Date).AddSeconds(20)
    do {
        $providerControl = Get-UniqueProviderControl $providerLabels
        if ($providerControl -and (Invoke-AccessibilityControl $providerControl)) {
            $providerInvoked = $true
            $providerInvokeCount += 1
            break
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $providerDeadline)
    if (-not $providerInvoked) { throw "没有找到唯一的 $Provider 登录控件。" }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Start-Sleep -Seconds 2
    while ((Get-Date) -lt $deadline) {
        $location = Get-PrivateCurrentUri
        if ($location) {
            $locationOrigin = $location.GetLeftPart([System.UriPartial]::Authority)
            if ($locationOrigin -eq $originValue -and $location.AbsolutePath -notmatch '^/(?:log[-_]?in|sign[-_]?in)(?:\.(?:php|asp|aspx|html?))?(?:/|$)') {
                $callbackReached = $true
                break
            }
            if ($location.Host -eq 'linux.do' -and $location.AbsolutePath -match '^/login(?:/|$)') {
                if (-not $upstreamLoginAttempted) {
                    $upstreamControl = Get-UniqueProviderControl $upstreamLabels
                    if ($upstreamControl -and (Invoke-AccessibilityControl $upstreamControl)) {
                        $upstreamLoginAttempted = $true
                        $resumeTargetAfterUpstream = $true
                        Start-Sleep -Seconds 2
                        continue
                    }
                }
                $upstreamLoginRequired = $true
                break
            }
            if ($location.Host -eq 'github.com') {
                if ($location.AbsolutePath -match '^/login(?:/|$)') {
                    if (-not $upstreamSavedLoginSubmitAttempted) {
                        $signInControl = Get-UniqueNamedControl @('Sign in', '登录', '登入')
                        if ($signInControl -and (Invoke-AccessibilityControl $signInControl)) {
                            $upstreamSavedLoginSubmitAttempted = $true
                            Start-Sleep -Seconds 3
                            continue
                        }
                    }
                    $upstreamLoginRequired = $true
                    break
                }
                if ($location.AbsolutePath -match '/login/oauth/authorize') { $authorizationRequired = $true; break }
            }
            if ($resumeTargetAfterUpstream -and $location.Host -eq 'linux.do') {
                $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
                Start-Process -FilePath ([string]$config.chromeExecutable) -ArgumentList @(
                    "--user-data-dir=$profilePath", '--profile-directory=Default',
                    '--no-first-run', '--no-default-browser-check',
                    '--disable-features=OptimizationGuideOnDeviceModel',
                    '--disable-component-update',
                    '--force-renderer-accessibility', '--window-position=-32000,-32000',
                    '--window-size=1400,900', $loginUri.AbsoluteUri
                ) -WindowStyle Hidden | Out-Null
                $resumeDeadline = (Get-Date).AddSeconds(20)
                $providerControl = $null
                do {
                    Start-Sleep -Milliseconds 500
                    $providerControl = Get-UniqueProviderControl $providerLabels
                } while (-not $providerControl -and (Get-Date) -lt $resumeDeadline)
                if (-not $providerControl -or -not (Invoke-AccessibilityControl $providerControl)) {
                    $upstreamLoginRequired = $true
                    break
                }
                $providerInvokeCount += 1
                $resumeTargetAfterUpstream = $false
                Start-Sleep -Seconds 2
                continue
            }
        }

        $authorizationControl = Get-UniqueNamedControl $authorizationLabels
        if ($authorizationControl -and $authorizationClicks -lt 3 -and
            ((Get-Date) - $lastAuthorizationAt).TotalSeconds -ge 5) {
            if (Invoke-AccessibilityControl $authorizationControl) {
                $authorizationClicks += 1
                $lastAuthorizationAt = Get-Date
                Start-Sleep -Seconds 2
                continue
            }
        }
        if ($challengeInteractions -eq 0) {
            $challengeControl = Get-UniqueNamedControl $challengeLabels
            if ($challengeControl -and (Invoke-AccessibilityControl $challengeControl)) {
                $challengeInteractions = 1
                Start-Sleep -Seconds 3
                continue
            }
        }
        Start-Sleep -Seconds 1
    }

    $status = if ($callbackReached) { 'callback_reached' } else { 'needs_attention' }
    $reason = if ($callbackReached) {
        '原生 Chrome 已在后台完成 OAuth 回调，等待权威签到日志复核'
    }
    elseif ($upstreamLoginRequired) {
        '隔离 Chrome 的上游登录已失效'
    }
    elseif ($authorizationRequired) {
        '上游 OAuth 要求额外授权确认'
    }
    else {
        '后台 OAuth 未在限定时间内完成'
    }
    [pscustomobject]@{
        status = $status
        reason = $reason
        providerInvoked = $providerInvoked
        providerInvokeCount = $providerInvokeCount
        upstreamLoginAttempted = $upstreamLoginAttempted
        upstreamSavedLoginSubmitAttempted = $upstreamSavedLoginSubmitAttempted
        authorizationClicks = $authorizationClicks
        challengeInteractions = $challengeInteractions
        upstreamLoginRequired = $upstreamLoginRequired
        authorizationRequired = $authorizationRequired
    } | ConvertTo-Json -Compress
    if (-not $callbackReached) { exit 2 }
}
finally {
    Close-ProfileChrome
}
