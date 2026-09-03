[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Url,
    [ValidateRange(10, 180)][int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$originUri = [uri]$Origin
$targetUri = [uri]$Url
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)

$allowedEntries = @($config.mainChromeFallbackUrls | ForEach-Object {
    $entry = $_
    $rawUrl = if ($entry -is [string]) { [string]$entry } else { [string]$entry.url }
    if ([string]::IsNullOrWhiteSpace($rawUrl)) { return }
    try {
        $uri = [uri]$rawUrl
        if ($uri.Scheme -eq 'https' -and -not $uri.UserInfo) {
            $sourceOrigin = if ($entry -isnot [string] -and $entry.sourceOrigin) {
                ([uri][string]$entry.sourceOrigin).GetLeftPart([System.UriPartial]::Authority)
            } else {
                $uri.GetLeftPart([System.UriPartial]::Authority)
            }
            $relatedProperty = $config.relatedCandidateUrls.PSObject.Properties[$sourceOrigin]
            $relatedOrigins = @(if ($null -ne $relatedProperty) {
                $relatedProperty.Value | ForEach-Object {
                    ([uri][string]$_).GetLeftPart([System.UriPartial]::Authority)
                }
            })
            if ($uri.GetLeftPart([System.UriPartial]::Authority) -ne $sourceOrigin -and
                $uri.GetLeftPart([System.UriPartial]::Authority) -notin $relatedOrigins) { return }
            [pscustomobject]@{
                url = $uri.AbsoluteUri
                origin = $sourceOrigin
                oauthProvider = if ($entry -isnot [string]) { [string]$entry.oauthProvider } else { '' }
            }
        }
    }
    catch { }
})

if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or
    $targetUri.Scheme -ne 'https' -or $targetUri.UserInfo) {
    throw '主 Chrome 回退地址无效。'
}
$allowedEntry = @($allowedEntries | Where-Object { $_.origin -eq $originValue -and $_.url -eq $targetUri.AbsoluteUri })
if ($allowedEntry.Count -ne 1) {
    throw "主 Chrome 回退地址不在明确白名单中：$($targetUri.AbsoluteUri)"
}
$oauthProvider = [string]$allowedEntry[0].oauthProvider
if ($oauthProvider -and $oauthProvider -ne 'LinuxDO') { throw '主 Chrome 回退 OAuth 提供商不受支持。' }

$sourceRoot = [System.IO.Path]::GetFullPath([string]$config.sourceUserDataDir)
$bookmarksPath = [System.IO.Path]::GetFullPath([string]$config.bookmarksPath)
$profilePath = Split-Path -Parent $bookmarksPath
$profileDirectory = Split-Path -Leaf $profilePath
$sourcePrefix = $sourceRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $profilePath.StartsWith($sourcePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
    $profileDirectory -notmatch '^(Default|Profile [0-9]+)$') {
    throw '无法从已配置书签安全确定主 Chrome profile。'
}
if (-not (Test-Path -LiteralPath ([string]$config.chromeExecutable))) { throw '未找到已配置的 Chrome。' }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CheckinWindowNative {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

function Get-ChromeProcessIds {
    @(
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
            try {
                -not $_.ExecutablePath -or
                    [System.IO.Path]::GetFullPath([string]$_.ExecutablePath) -eq [System.IO.Path]::GetFullPath([string]$config.chromeExecutable)
            }
            catch { $false }
        } | Select-Object -ExpandProperty ProcessId
    )
}

function Get-ChromeWindows {
    $ids = @(Get-ChromeProcessIds)
    if ($ids.Count -eq 0) { return @() }
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    @(
        $desktop.FindAll(
            [System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition
        ) | Where-Object {
            try {
                $_.Current.ProcessId -in $ids -and
                    $_.Current.ClassName -eq 'Chrome_WidgetWin_1' -and
                    $_.Current.NativeWindowHandle -ne 0
            }
            catch { $false }
        }
    )
}

function Get-WindowElements([System.Windows.Automation.AutomationElement]$Window) {
    try {
        @($Window.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        ))
    }
    catch { @() }
}

function Get-CurrentUri([System.Windows.Automation.AutomationElement]$Window) {
    foreach ($element in @(Get-WindowElements $Window)) {
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

function Test-EquivalentOrigin([uri]$ExpectedUri, [uri]$ActualUri) {
    if ($null -eq $ExpectedUri -or $null -eq $ActualUri) { return $false }
    if ($ExpectedUri.Scheme -ne $ActualUri.Scheme -or $ExpectedUri.Port -ne $ActualUri.Port) { return $false }
    $expectedHost = $ExpectedUri.IdnHost.ToLowerInvariant() -replace '^www\.', ''
    $actualHost = $ActualUri.IdnHost.ToLowerInvariant() -replace '^www\.', ''
    return $expectedHost -eq $actualHost
}

function Read-PageSnapshot([System.Windows.Automation.AutomationElement]$Window) {
    $elements = @(Get-WindowElements $Window)
    $names = @()
    $nonAddressEdits = 0
    foreach ($element in $elements) {
        try {
            $name = ([string]$element.Current.Name).Trim()
            $type = [string]$element.Current.ControlType.ProgrammaticName
            if ($type -in @('ControlType.Text', 'ControlType.Hyperlink', 'ControlType.Button', 'ControlType.Document') -and $name) {
                $names += $name
            }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
                $editName = [string]$element.Current.Name
                $editId = [string]$element.Current.AutomationId
                if ($editName -notmatch '^(Address and search bar|地址栏|地址和搜索栏|網址列|網址和搜尋列)$' -and $editId -ne 'view_1022') {
                    $nonAddressEdits++
                }
            }
        }
        catch { }
    }
    $bodyText = (@($names | Select-Object -Unique) -join ' ').Trim()
    $currentUri = Get-CurrentUri $Window
    $sameOrigin = $null -ne $currentUri -and (Test-EquivalentOrigin $targetUri $currentUri)
    $leichiWaf = $bodyText -match '当前环境正在被调试|正在进行安全检测|安全检测能力由\s*雷池|如您是正常访问|客户端异常.*确认.*合法用户'
    $cloudflareWaf = $bodyText -match '请稍候[.…]*\s*[^ ]+\s*正在进行安全验证|本网站使用安全服务防护恶意自动程序|Just a moment|Performing security verification|Verify you are human|Cloudflare.*performance and security'
    $securityVerification = $bodyText -match '异地登录安全验证|異地登錄安全驗證|忘记二级验证|忘記二級驗證|二级验证代码|二級驗證碼|\b2FA\b'
    $success = $bodyText -match '签到成功|今日已签到|今天已签到|已完成今日签到|签到已得\s*\d+|(?:^|\s)已签到(?:\s|$)|Already checked in|Checked in today'
    $loginRoute = $null -ne $currentUri -and $currentUri.AbsolutePath -match '/(?:log[-_]?in|sign[-_]?in|auth)(?:\.(?:php|asp|aspx|html?))?(?:/|$)'
    [pscustomobject]@{
        currentUrl = if ($currentUri) { $currentUri.AbsoluteUri } else { '' }
        bodyText = $bodyText.Substring(0, [Math]::Min(2000, $bodyText.Length))
        sameOrigin = [bool]$sameOrigin
        waf = [bool]($leichiWaf -or $cloudflareWaf)
        leichiWaf = [bool]$leichiWaf
        cloudflareWaf = [bool]$cloudflareWaf
        securityVerification = [bool]$securityVerification
        success = [bool]$success
        loginRoute = [bool]$loginRoute
        nonAddressEdits = $nonAddressEdits
        siteBodyLoaded = [bool]($sameOrigin -and -not ($leichiWaf -or $cloudflareWaf) -and $bodyText.Length -gt 80)
    }
}

function Invoke-UniqueCheckinButton([System.Windows.Automation.AutomationElement]$Window) {
    $matches = @()
    $priorities = @{
        '开始转动' = 105
        '立即签到' = 100
        '签到领取' = 95
        '领取签到奖励' = 95
        '今日签到' = 90
        '每日签到' = 85
        '签到' = 80
        'Check in' = 80
    }
    foreach ($element in @(Get-WindowElements $Window)) {
        try {
            $name = ([string]$element.Current.Name).Trim()
            if ($element.Current.ControlType -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::Hyperlink
            )) { continue }
            if (-not $element.Current.IsEnabled) { continue }
            if (-not $priorities.ContainsKey($name)) { continue }
            $matches += [pscustomobject]@{ element = $element; priority = [int]$priorities[$name] }
        }
        catch { }
    }
    if ($matches.Count -eq 0) { return $false }
    $topPriority = ($matches | Measure-Object -Property priority -Maximum).Maximum
    $topMatches = @($matches | Where-Object { $_.priority -eq $topPriority })
    if ($topMatches.Count -ne 1) { return $false }
    $control = $topMatches[0].element
    try {
        $invoke = $control.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        return $true
    }
    catch { return $false }
}

function Get-UniqueNamedControl(
    [System.Windows.Automation.AutomationElement]$Window,
    [string[]]$Labels
) {
    $found = @()
    foreach ($element in @(Get-WindowElements $Window)) {
        try {
            if (-not $element.Current.IsEnabled -or $element.Current.ControlType -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::Hyperlink
            )) { continue }
            if (([string]$element.Current.Name).Trim() -in $Labels) { $found += $element }
        }
        catch { }
    }
    if ($found.Count -eq 1) { return $found[0] }
    return $null
}

function Invoke-Control([System.Windows.Automation.AutomationElement]$Element) {
    if ($null -eq $Element) { return $false }
    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
        return $true
    }
    catch { return $false }
}

function Close-TaskWindow([System.Windows.Automation.AutomationElement]$Window) {
    $handle = [IntPtr]$Window.Current.NativeWindowHandle
    # Chrome persists the last normal window placement.  Always leave the
    # temporary window with safe on-screen restore bounds before closing it so
    # a later user-created Chrome window can never inherit task-only placement.
    [void][CheckinWindowNative]::SetWindowPos($handle, [IntPtr]::Zero, 80, 80, 1400, 900, 0x0014)
    try {
        $windowPattern = $Window.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
        $windowPattern.Close()
    }
    catch {
        [void][CheckinWindowNative]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    $deadline = (Get-Date).AddSeconds(15)
    while ([CheckinWindowNative]::IsWindow($handle) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if ([CheckinWindowNative]::IsWindow($handle)) { throw '主 Chrome 任务窗口未能正常关闭；未触碰其他窗口。' }
}

$beforeHandles = @{}
$beforeWindowUrls = @{}
foreach ($window in @(Get-ChromeWindows)) {
    $handle = [int]$window.Current.NativeWindowHandle
    $beforeHandles[$handle] = $true
    $beforeUri = Get-CurrentUri $window
    $beforeWindowUrls[$handle] = if ($beforeUri) { $beforeUri.AbsoluteUri } else { '' }
}
$taskWindow = $null
$result = $null
try {
    $arguments = @(
        "`"--user-data-dir=$sourceRoot`"",
        "--profile-directory=$profileDirectory",
        '--new-window',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=OptimizationGuideOnDeviceModel',
        '--force-renderer-accessibility',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        $targetUri.AbsoluteUri
    )
    # Start at Chrome's normal on-screen restore bounds.  After the new task
    # handle is identified it is minimized (not hidden), which keeps the
    # accessibility tree available without changing the user's saved placement.
    Start-Process -FilePath ([string]$config.chromeExecutable) -ArgumentList $arguments | Out-Null
    $windowDeadline = (Get-Date).AddSeconds(25)
    do {
        Start-Sleep -Milliseconds 500
        $newWindows = @(Get-ChromeWindows | Where-Object { -not $beforeHandles.ContainsKey([int]$_.Current.NativeWindowHandle) })
        $targetWindows = @($newWindows | Where-Object {
            $currentUri = Get-CurrentUri $_
            $null -ne $currentUri -and (Test-EquivalentOrigin $targetUri $currentUri)
        })
        if ($targetWindows.Count -eq 1) {
            $taskWindow = $targetWindows[0]
        }
    } while ($null -eq $taskWindow -and (Get-Date) -lt $windowDeadline)
    if ($null -eq $taskWindow) {
        $mergedWindow = @(Get-ChromeWindows | Where-Object {
            $handle = [int]$_.Current.NativeWindowHandle
            if (-not $beforeHandles.ContainsKey($handle)) { return $false }
            $currentUri = Get-CurrentUri $_
            if ($null -eq $currentUri -or -not (Test-EquivalentOrigin $targetUri $currentUri)) { return $false }
            return [string]$beforeWindowUrls[$handle] -ne $currentUri.AbsoluteUri
        }).Count -gt 0
        $result = [pscustomobject]@{
            status = 'unconfirmed'
            failureCode = if ($mergedWindow) { 'window_merged' } else { 'window_not_created' }
            reason = if ($mergedWindow) {
                'Chrome 将任务导航合并到了既有窗口；为避免关闭用户窗口，已停止本次回退'
            } else {
                '没有识别到独立的主 Chrome 任务窗口；未触碰用户既有窗口'
            }
        }
    } else {
        $taskHandle = [IntPtr]$taskWindow.Current.NativeWindowHandle
        [void][CheckinWindowNative]::ShowWindow($taskHandle, 6)

        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $clicked = $false
        $oauthLoginClicked = $false
        $oauthAuthorizeClicked = $false
        $last = $null
        do {
            $last = Read-PageSnapshot $taskWindow
            if ($last.success -and $last.siteBodyLoaded) {
                $result = [pscustomobject]@{
                    status = if ($clicked) { 'signed' } else { 'already_signed' }
                    reason = if ($clicked) { '主 Chrome 页面明确确认签到成功' } else { '主 Chrome 页面明确确认今日已签到' }
                    clicked = $clicked
                    inspection = $last
                }
                break
            }
            $currentUri = $null
            if ($last.currentUrl) {
                try { $currentUri = [uri][string]$last.currentUrl } catch { }
            }
            if ($oauthProvider -eq 'LinuxDO' -and $null -ne $currentUri -and
                $currentUri.Host -eq 'connect.linux.do') {
                if (-not $oauthAuthorizeClicked) {
                    $authorize = Get-UniqueNamedControl $taskWindow @('授权', '允許', '允许', 'Authorize', 'Allow')
                    if ($authorize -and (Invoke-Control $authorize)) {
                        $oauthAuthorizeClicked = $true
                        Start-Sleep -Seconds 2
                        continue
                    }
                }
                Start-Sleep -Milliseconds 750
                continue
            }
            if ($oauthProvider -eq 'LinuxDO' -and $last.siteBodyLoaded -and -not $oauthLoginClicked) {
                $oauthLogin = Get-UniqueNamedControl $taskWindow @('登录', '登入', '使用 LinuxDO 登录', '使用 Linux DO 登录')
                if ($oauthLogin -and (Invoke-Control $oauthLogin)) {
                    $oauthLoginClicked = $true
                    Start-Sleep -Seconds 2
                    continue
                }
            }
            if ($last.securityVerification) {
                $result = [pscustomobject]@{
                    status = 'needs_attention'
                    failureCode = 'two_factor_required'
                    attentionKind = 'trusted_device_initialization'
                    retryableLoginRecovery = $false
                    reason = '主 Chrome 要求完成异地登录 2FA 验证'
                    clicked = $clicked
                    inspection = $last
                }
                break
            }
            if (-not $last.waf -and $last.siteBodyLoaded -and ($last.loginRoute -or $last.nonAddressEdits -ge 2)) {
                $result = [pscustomobject]@{
                    status = 'login_required'
                    reason = '主 Chrome 登录状态不可用'
                    clicked = $clicked
                    inspection = $last
                }
                break
            }
            if (-not $clicked -and -not $last.waf -and $last.siteBodyLoaded -and -not $last.loginRoute) {
                $clicked = Invoke-UniqueCheckinButton $taskWindow
                if ($clicked) { Start-Sleep -Seconds 2; continue }
            }
            Start-Sleep -Milliseconds 750
        } while ((Get-Date) -lt $deadline)

        if ($null -eq $result) {
            $failureCode = if ($last.waf) {
                $null
            } elseif (-not $last.currentUrl) {
                'accessibility_unavailable'
            } elseif (-not $last.sameOrigin) {
                'target_not_loaded'
            } else {
                $null
            }
            $result = [pscustomobject]@{
                status = if ($last.waf) { 'managed_challenge' } else { 'unconfirmed' }
                reason = if ($last.waf) {
                    '主 Chrome 仍停留在安全验证页'
                } elseif ($failureCode -eq 'accessibility_unavailable') {
                    '主 Chrome 任务窗口无法提供可访问页面状态'
                } elseif ($failureCode -eq 'target_not_loaded') {
                    '主 Chrome 任务窗口未加载到配置的目标站点'
                } else {
                    '主 Chrome 未取得明确签到终态'
                }
                failureCode = $failureCode
                clicked = $clicked
                inspection = $last
            }
        }
    }
}
catch {
    if ($null -eq $result) {
        $result = [pscustomobject]@{
            status = 'unconfirmed'
            failureCode = 'accessibility_unavailable'
            reason = '主 Chrome 可访问性检查未能完成'
        }
    }
}
finally {
    if ($null -ne $taskWindow) {
        try { Close-TaskWindow $taskWindow }
        catch {
            $result = [pscustomobject]@{
                status = 'unconfirmed'
                failureCode = 'window_cleanup_failed'
                reason = '主 Chrome 任务窗口未能正常关闭；未触碰其他窗口'
            }
        }
    }
}

$result | ConvertTo-Json -Depth 8
if ($result.status -in @('signed', 'already_signed')) { exit 0 }
exit 2
