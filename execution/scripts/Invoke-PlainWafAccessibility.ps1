[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Url,
    [ValidateRange(5, 120)][int]$TimeoutSeconds = 60,
    [string]$UserDataDirOverride,
    [ValidateSet('offscreen', 'minimized', 'visible')][string]$WindowMode = 'offscreen',
    [switch]$AllowPreparedSiteBody,
    [switch]$AllowCloudflareChallengeClick,
    [switch]$PerformCheckin,
    [switch]$ReadOnly,
    [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = if ($RuntimeRoot) { [IO.Path]::GetFullPath($RuntimeRoot) } else { Split-Path -Parent $PSScriptRoot }
. (Join-Path $PSScriptRoot 'ResultContract.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$originUri = [uri]$Origin
$targetUri = [uri]$Url
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$profilePath = if ($UserDataDirOverride) {
    [System.IO.Path]::GetFullPath($UserDataDirOverride)
} else {
    [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
}
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or
    $targetUri.Scheme -ne 'https' -or $targetUri.UserInfo -or
    $targetUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '无调试 WAF 预热地址无效。'
}
if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedRoot"
}
if ($ReadOnly) {
    $reviewedOrigin = @($CheckinNativePtHeaderOrigins | Where-Object { ($_ -replace '^https://www\.', 'https://') -eq ($originValue -replace '^https://www\.', 'https://') }).Count -gt 0
    if (-not $reviewedOrigin -or $targetUri.AbsolutePath -ne '/index.php' -or $targetUri.Query -or $targetUri.Fragment) {
        throw '只读核验仅允许已复核站点的首页。'
    }
}

. (Join-Path $PSScriptRoot 'Native-PtGuard.ps1')
. (Join-Path $PSScriptRoot 'Native-PtChromeProxy.ps1')
$script:nativeLocalSubmissionAttempted = $false
$script:checkinClickAttempted = $false
try {
    $nativePtProxyServer = Resolve-NativePtChromeProxy $config $originValue
    $nativeDecision = Initialize-NativePtGuard -Root $root -Origin $originValue -Url $Url -ProfilePath $profilePath -ReadOnly:$ReadOnly
} catch {
    $nativeDecision = Get-NativePtChromeProxyFailure $_
    if ($null -eq $nativeDecision) { $nativeDecision = Get-NativePtFailure -ErrorRecord $_ }
}
if ($null -ne $nativeDecision) {
    $nativeDecision | Complete-NativePtResult | ConvertTo-Json -Depth 8
    if ($nativeDecision.status -in @('signed', 'already_signed')) { exit 0 }
    exit 2
}

. (Join-Path $PSScriptRoot 'Safe-UIAutomation.ps1')

Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CheckinProfileWindows {
    private delegate bool EnumProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr param);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr window, int command);
    public static IntPtr[] Find(int[] processIds) {
        var ids = new HashSet<int>(processIds);
        var result = new List<IntPtr>();
        EnumWindows((window, param) => {
            uint id; GetWindowThreadProcessId(window, out id);
            if (!ids.Contains((int)id)) return true;
            var name = new StringBuilder(128); GetClassName(window, name, name.Capacity);
            if (name.ToString() == "Chrome_WidgetWin_1") result.Add(window);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
    public static bool RenderOffscreen(IntPtr window) {
        if (!SetWindowPos(window, IntPtr.Zero, -32000, -32000, 1400, 900, 0x0014)) return false;
        ShowWindow(window, 4); // SW_SHOWNOACTIVATE: render without taking focus.
        return SetWindowPos(window, IntPtr.Zero, -32000, -32000, 1400, 900, 0x0014);
    }
}
'@
$preparedHandles = @{}

function Get-ProfileChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profilePath*" })
}

function Get-ChromeAutomationRoots {
    $ids = @(Get-ProfileChromeProcesses | Select-Object -ExpandProperty ProcessId)
    if ($ids.Count -eq 0) { return @() }
    @(
        [CheckinProfileWindows]::Find([int[]]$ids) | ForEach-Object {
            try {
                $handle = [IntPtr]$_
                if ($WindowMode -ne 'visible' -and -not $preparedHandles.ContainsKey($handle)) {
                    # Only IDs matched to this isolated data profile reach here.
                    # Hidden/minimized Chrome may expose no document until rendered.
                    if (-not [CheckinProfileWindows]::RenderOffscreen($handle)) { return }
                    $preparedHandles[$handle] = $true
                }
                [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            } catch { $null }
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

function Get-CurrentUri {
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

function Test-EquivalentWafOrigin([uri]$ExpectedUri, [uri]$ActualUri) {
    if ($null -eq $ExpectedUri -or $null -eq $ActualUri) { return $false }
    if ($ExpectedUri.Scheme -ne $ActualUri.Scheme -or $ExpectedUri.Port -ne $ActualUri.Port) { return $false }
    $expectedHost = $ExpectedUri.IdnHost.ToLowerInvariant() -replace '^www\.', ''
    $actualHost = $ActualUri.IdnHost.ToLowerInvariant() -replace '^www\.', ''
    return $expectedHost -eq $actualHost
}

function Read-PageSnapshot {
    $allElements = @(Get-AllAutomationElements)
    $elements = @()
    foreach ($document in @($allElements | Where-Object { [string]$_.Current.ControlType.ProgrammaticName -eq 'ControlType.Document' })) {
        try { $elements += @($document.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) } catch { }
    }
    $pageContentAvailable = $elements.Count -gt 1
    if (-not $pageContentAvailable) { $elements = @() }
    $names = @()
    $controlNames = @()
    $linkNames = @()
    $documents = @()
    $nonAddressEdits = 0
    $otpInputPresent = $false; $passwordInputPresent = $false; $scopedOtpInputPresent = $false
    foreach ($element in $elements) {
        try {
            $name = ([string]$element.Current.Name).Trim()
            $type = [string]$element.Current.ControlType.ProgrammaticName
            $reviewedPt = $originValue -in $CheckinNativePtHeaderOrigins
            if (($type -in @('ControlType.Text', 'ControlType.Hyperlink', 'ControlType.Button', 'ControlType.Document') -or
                ($reviewedPt -and $type -in @('ControlType.DataItem', 'ControlType.Custom', 'ControlType.ListItem'))) -and $name) {
                $names += $name
            }
            if ($type -in @('ControlType.Hyperlink', 'ControlType.Button') -and $name) { $controlNames += $name }
            if ($type -eq 'ControlType.Hyperlink' -and $name) { $linkNames += $name }
            if ($type -eq 'ControlType.Document' -and $name -and $name -notmatch '^Chrome(?:\s|$)') {
                $documents += $name
            }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {
                $editName = [string]$element.Current.Name
                $editId = [string]$element.Current.AutomationId
                if ($editName -notmatch '^(Address and search bar|地址栏|地址和搜索栏|網址列|網址和搜尋列)$' -and $editId -ne 'view_1022') {
                    $nonAddressEdits++
                    if (Test-NativeOtpInputLabel $editName $editId) { $otpInputPresent = $true }
                    elseif (Test-NativeScopedOtpInput $element) { $otpInputPresent = $true; $scopedOtpInputPresent = $true }
                    if ($element.Current.IsPassword) { $passwordInputPresent = $true }
                }
            }
        }
        catch { }
    }
    $bodyText = (@($names | Select-Object -Unique) -join ' ').Trim()
    $browserFailureCode = Get-NativeBrowserFailure $bodyText
    $currentUri = Get-CurrentUri
    $leichiWaf = $bodyText -match '当前环境正在被调试|正在进行安全检测|安全检测能力由\s*雷池|如您是正常访问|客户端异常.*确认.*合法用户'
    $cloudflareWaf = $bodyText -match '请稍候[.…]*\s*[^ ]+\s*正在进行安全验证|本网站使用安全服务防护恶意自动程序|Just a moment|Performing security verification|Verify you are human|Cloudflare.*performance and security'
    $waf = $leichiWaf -or $cloudflareWaf
    $success = $bodyText -match '签到成功|今日已签到|今天已签到|今天已经签到过|已经签到|已签到'
    $security = Get-NativeSecurityState $bodyText $currentUri $otpInputPresent $passwordInputPresent $nonAddressEdits $scopedOtpInputPresent
    $securityVerification = $security.securityVerification
    $loginRoute = $null -ne $currentUri -and $currentUri.AbsolutePath -match '/(?:log[-_]?in|sign[-_]?in|auth)(?:\.(?:php|asp|aspx|html?))?(?:/|$)'
    # Some NexusPHP sites canonicalize between www and the bare host after the
    # WAF challenge. Treat only that narrow host alias as equivalent; scheme,
    # port, and the remaining hostname must still match.
    $sameOrigin = $null -ne $currentUri -and (Test-EquivalentWafOrigin $originUri $currentUri)
    $attendanceEndpoint = $null -ne $currentUri -and $currentUri.AbsolutePath -match '/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:/|$)'
    $signedControls = @($controlNames | ForEach-Object { ($_ -replace '^[\[【]|[\]】]$', '').Trim() } | Where-Object { Test-NativeDailyControl $originValue $_ })
    $unsignedControls = @($linkNames | ForEach-Object { ($_ -replace '^[\[【]|[\]】]$', '').Trim() } | Where-Object { Test-NativeUnsignedControl $originValue $_ })
    $normalizedControls = @($controlNames | ForEach-Object { ($_ -replace '^[\[【]|[\]】]$', '').Trim() })
    $authenticated = @($normalizedControls | Where-Object { $_ -match '^(?:退出|退出登录|登出|注销|登出账号|登出帳號|Logout|Log out)$' }).Count -gt 0 -and
        @($normalizedControls | Where-Object { $_ -match '^(?:控制面板|用户中心|用戶中心|个人资料|個人資料|设置|設定|Control Panel|User CP)$' }).Count -gt 0
    $snapshot = [pscustomobject]@{
        currentUrl = if ($currentUri) { $currentUri.AbsoluteUri } else { '' }
        pageContentAvailable = [bool]$pageContentAvailable
        browserFailureCode = $browserFailureCode
        bodyText = $bodyText.Substring(0, [Math]::Min(2000, $bodyText.Length))
        successText = Get-NativeSuccessText $bodyText
        successControl = if ($signedControls.Count -eq 1) { $signedControls[0] } else { '' }
        signedControlCount = $signedControls.Count
        unsignedControl = if ($unsignedControls.Count -eq 1) { $unsignedControls[0] } else { '' }
        unsignedControlCount = $unsignedControls.Count
        authenticated = [bool]$authenticated
        document = (@($documents | Select-Object -Unique) -join ' ').Substring(0, [Math]::Min(500, (@($documents | Select-Object -Unique) -join ' ').Length))
        waf = [bool]$waf
        leichiWaf = [bool]$leichiWaf
        cloudflareWaf = [bool]$cloudflareWaf
        success = [bool]$success
        securityVerification = [bool]$securityVerification
        nativeSecurityDiagnostic = $security.nativeSecurityDiagnostic
        loginRoute = [bool]$loginRoute
        sameOrigin = [bool]$sameOrigin
        attendanceEndpoint = [bool]$attendanceEndpoint
        siteBodyLoaded = (-not $browserFailureCode -and -not $waf -and $sameOrigin -and $bodyText.Length -gt 80)
        nonAddressEdits = $nonAddressEdits
    }
    $snapshot.nativeSecurityDiagnostic | Add-Member -NotePropertyName sameOrigin -NotePropertyValue ([bool]$sameOrigin)
    $snapshot.nativeSecurityDiagnostic | Add-Member -NotePropertyName pageContentAvailable -NotePropertyValue ([bool]$pageContentAvailable)
    $snapshot.nativeSecurityDiagnostic | Add-Member -NotePropertyName waf -NotePropertyValue ([bool]$waf)
    $snapshot | Add-Member -NotePropertyName audiencesDailyHeaderVerified -NotePropertyValue (Test-NativeAudiencesDailyHeader $snapshot $originValue)
    return $snapshot
}

function Close-ProfileChrome {
    $targets = @(Get-ProfileChromeProcesses)
    $ids = @($targets.ProcessId)
    foreach ($info in @($targets | Where-Object { $ids -notcontains $_.ParentProcessId })) {
        $process = Get-Process -Id $info.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-ProfileChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) { $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
}

function Invoke-LeichiConfirmationClick {
    $automationRoots = @(Get-ChromeAutomationRoots)
    foreach ($automationRoot in $automationRoots) {
        try {
            $buttons = @($automationRoot.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )) | Where-Object {
                try {
                    $controlType = $_.Current.ControlType
                    $name = ([string]$_.Current.Name).Trim()
                    $automationId = [string]$_.Current.AutomationId
                    $controlType -eq [System.Windows.Automation.ControlType]::Button -and (
                        $automationId -eq 'sl-check' -or
                        $name -match '^(确认|Confirm)$'
                    )
                }
                catch { $false }
            }
            foreach ($button in $buttons) {
                try { if (-not $button.Current.IsEnabled) { continue } } catch { continue }
                if (Invoke-SafeAutomationControl -Element $button -AllowedPatterns @('Invoke')) { return $true }
            }
        }
        catch { }
    }
    return $false
}

function Invoke-CloudflareChallengeClick {
    $allowedNames = @{
        'Verify you are human' = $true
        '请验证您是真人' = $true
        '請驗證您是真人' = $true
        '验证您是真人' = $true
        '驗證您是真人' = $true
        '验证你是真人' = $true
        '驗證你是真人' = $true
    }
    $matches = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            $name = ([string]$element.Current.Name).Trim()
            if (-not $allowedNames.ContainsKey($name) -or -not $element.Current.IsEnabled) { continue }
            if ($element.Current.ControlType -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::CheckBox
            )) { continue }
            $matches += $element
        }
        catch { }
    }
    if ($matches.Count -ne 1) { return $false }
    return Invoke-SafeAutomationControl -Element $matches[0] -AllowedPatterns @('Invoke', 'Toggle')
}

function Invoke-NativeCheckinAction {
    if ($ReadOnly -or $script:checkinClickAttempted) { return $false }
    # Only invoke an unambiguous, same-page attendance control.  We never use
    # coordinates or broad text matching here: a missing or ambiguous control
    # is safer to report than to click the wrong action.
    $labels = @('签到', '簽到', '立即签到', '立即簽到', '今日签到', '今日簽到', '打卡', '立即打卡', 'Check in', 'Check-in', 'Attendance')
    $matches = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            if (-not $element.Current.IsEnabled -or $element.Current.ControlType -notin @(
                [System.Windows.Automation.ControlType]::Button,
                [System.Windows.Automation.ControlType]::Hyperlink,
                [System.Windows.Automation.ControlType]::CheckBox
            )) { continue }
            # The Audiences header link opens the form; only the form button
            # submits attendance. Do not consume the single write click early.
            if ($originValue -ceq 'https://audiences.me' -and
                $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
            $name = ([string]$element.Current.Name).Trim()
            if ($labels -contains $name) { $matches += $element }
        }
        catch { }
    }
    if ($matches.Count -ne 1) { return $false }
    # Select a supported pattern before recording the write. Once an actual
    # invocation starts, an exception must never fall through to another one.
    $pattern = $null
    $patternName = ''
    foreach ($candidate in @('Invoke', 'Toggle')) {
        try {
            $patternId = if ($candidate -eq 'Invoke') { [System.Windows.Automation.InvokePattern]::Pattern } else { [System.Windows.Automation.TogglePattern]::Pattern }
            $pattern = $matches[0].GetCurrentPattern($patternId)
            $patternName = $candidate
            break
        } catch { }
    }
    if ($null -eq $pattern) { return $false }
    if ($patternName -eq 'Toggle' -and $pattern.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { return $false }
    Start-NativePtWrite -Action click
    $script:checkinClickAttempted = $true
    $script:nativeLocalSubmissionAttempted = $true
    if ($patternName -eq 'Invoke') { [void]$pattern.Invoke() } else { [void]$pattern.Toggle() }
    return $true
}

if ((Get-ProfileChromeProcesses).Count -gt 0) { throw '机器人专用 Chrome 配置正被占用。' }
$started = $false
$diagnosticStage = 'launch'
$checkinClicked = $false
try {
    # Use named-parameter splatting.  An array splat is positional in
    # PowerShell; it previously bound "-Urls" to Open-PlainLoginChrome's
    # integer port parameter and prevented Chrome from
    # starting at all.
    $openParameters = @{
        DisableExtensions = $true
        Urls = @($targetUri.AbsoluteUri)
        UserDataDirOverride = $profilePath
    }
    if ($WindowMode -eq 'minimized') {
        $openParameters.Minimized = $true
    } elseif ($WindowMode -eq 'visible') {
        # Visible mode is intentionally opt-in and is useful for a supervised
        # diagnostic run. The normal unattended path uses a minimized window.
    } else {
        $openParameters.Offscreen = $true
    }
    if (Test-NativePtNavigationRisk) {
        Start-NativePtWrite -Action navigation
        $script:nativeLocalSubmissionAttempted = $true
    }
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openParameters | Out-Null
    $diagnosticStage = 'window_discovery'
    $windowDeadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) { Start-Sleep -Milliseconds 500 }
    if (@(Get-ChromeAutomationRoots).Count -eq 0) { throw '原生 Chrome 没有可用的无障碍窗口。' }
    $started = $true
    $diagnosticStage = 'page_readback'

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $confirmationClickAttempted = $false
    $confirmationClicked = $false
    $cloudflareObservedAt = $null
    $cloudflareChallengeClicked = $false
    $last = $null
    do {
        $last = Read-PageSnapshot
        if ($last.browserFailureCode) {
            [pscustomobject]@{status='unconfirmed';failureCode=$last.browserFailureCode;
                reason='浏览器未能连接到站点，尚未读取账号或签到页面';inspection=$last;
                submissionAttempted=[bool]$script:nativeLocalSubmissionAttempted} |
                Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 2
        }
        if ($last.securityVerification) {
            [pscustomobject]@{
                status = 'needs_attention'
                failureCode = 'two_factor_required'
                attentionKind = 'trusted_device_initialization'
                nativeSecurityDiagnostic = $last.nativeSecurityDiagnostic
                retryableLoginRecovery = $false
                reason = '站点要求完成异地登录 2FA 验证'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                checkinClickAttempted = $checkinClickAttempted
                checkinClicked = $checkinClicked
                inspection = $last
                submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
            } | Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 2
        }
        $pageEvidence = Get-ConfirmedNativePageEvidence $last $Url $checkinClicked -FormalVisit:(-not $ReadOnly -and
            [bool]$last.attendanceEndpoint -and ([bool]$PerformCheckin -or [bool]$script:nativeLocalSubmissionAttempted))
        if (Test-NativePageCompletion $last $originValue $pageEvidence) {
            [pscustomobject]@{
                status = 'signed'
                reason = '无调试原生 Chrome 页面确认签到完成'
                evidence = $pageEvidence
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                checkinClickAttempted = $checkinClickAttempted
                checkinClicked = $checkinClicked
                inspection = $last
                submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
            } | Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 0
        }
        if ($ReadOnly) {
            $unsignedEvidence = Get-ConfirmedNativeUnsignedEvidence $last $Url
            if ($null -ne $unsignedEvidence) {
                [pscustomobject]@{status='not_signed';reason='执行 Profile 已登录首页确认今日尚未签到';
                    submissionAttempted=$false;clicked=$false;inspection=$last;evidence=$unsignedEvidence} |
                    Complete-NativePtResult | ConvertTo-Json -Depth 8
                exit 0
            }
        }
        if (-not $PerformCheckin -and $last.siteBodyLoaded -and $last.attendanceEndpoint -and -not $last.loginRoute) {
            [pscustomobject]@{
                status = 'ready'
                reason = '无调试原生 Chrome 已通过 WAF 并加载签到页面'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                checkinClickAttempted = $checkinClickAttempted
                checkinClicked = $checkinClicked
                inspection = $last
                submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
            } | Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 0
        }
        if (-not $PerformCheckin -and $AllowPreparedSiteBody -and $last.siteBodyLoaded -and -not $last.loginRoute) {
            [pscustomobject]@{
                status = 'ready'
                reason = '无调试原生 Chrome 已完成安全验证预热'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                checkinClickAttempted = $checkinClickAttempted
                checkinClicked = $checkinClicked
                inspection = $last
                submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
            } | Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 0
        }
        # A WAF challenge can keep the original /login.php URL while its own
        # interstitial is still rendered. Do not classify that URL as an
        # authenticated-site login form until the challenge body is gone.
        if (-not $last.waf -and $last.siteBodyLoaded -and ($last.loginRoute -or $last.nonAddressEdits -ge 2)) {
            [pscustomobject]@{
                status = 'login_required'
                reason = '无调试原生 Chrome 进入登录页'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                checkinClickAttempted = $checkinClickAttempted
                checkinClicked = $checkinClicked
                inspection = $last
                submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
            } | Complete-NativePtResult | ConvertTo-Json -Depth 8
            exit 2
        }
        if (-not $ReadOnly -and $last.waf -and $last.bodyText -match '客户端异常.*确认.*合法用户' -and -not $confirmationClickAttempted) {
            $confirmationClickAttempted = $true
            $confirmationClicked = Invoke-LeichiConfirmationClick
            if ($confirmationClicked) {
                Start-Sleep -Seconds 2
                continue
            }
        }
        if (-not $ReadOnly -and $PerformCheckin -and $last.siteBodyLoaded -and $last.attendanceEndpoint -and
            (-not $last.success -or (Test-NativeUnverifiedTextAllowsForm $last)) -and -not $checkinClickAttempted) {
            $checkinClicked = Invoke-NativeCheckinAction
            if ($checkinClicked) {
                Start-Sleep -Seconds 2
                continue
            }
        }
        if ($last.cloudflareWaf -and $null -eq $cloudflareObservedAt) { $cloudflareObservedAt = Get-Date }
        if (-not $ReadOnly -and $AllowCloudflareChallengeClick -and $last.cloudflareWaf -and -not $cloudflareChallengeClicked -and
            $null -ne $cloudflareObservedAt -and ((Get-Date) - $cloudflareObservedAt).TotalSeconds -ge 8) {
            $cloudflareChallengeClicked = Invoke-CloudflareChallengeClick
            if ($cloudflareChallengeClicked) {
                Start-Sleep -Seconds 3
                continue
            }
        }
        Start-Sleep -Milliseconds 750
    } while ((Get-Date) -lt $deadline)
    [pscustomobject]@{
        status = if ($last.waf) { 'managed_challenge' } elseif ($checkinClicked) { 'needs_attention' } else { 'unconfirmed' }
        reason = if ($checkinClicked) {
            '无调试原生 Chrome 已提交签到动作，但页面未返回权威结果'
        } else {
            "无调试原生 Chrome 未取得签到终态（雷池确认点击=$confirmationClicked，Cloudflare 验证点击=$cloudflareChallengeClicked）"
        }
        failureCode = if ($checkinClicked) { 'submission_outcome_unknown' } elseif (-not $last.currentUrl) { 'accessibility_unavailable' } else { $null }
        submissionAttempted = [bool]$script:nativeLocalSubmissionAttempted
        retryable = if ($checkinClicked) { $false } else { $null }
        confirmationClickAttempted = $confirmationClickAttempted
        confirmationClicked = $confirmationClicked
        cloudflareChallengeClicked = $cloudflareChallengeClicked
        checkinClickAttempted = $checkinClickAttempted
        checkinClicked = $checkinClicked
        inspection = $last
    } | Complete-NativePtResult | ConvertTo-Json -Depth 8
    exit 2
}
catch {
    # Do not lose all diagnostic information through the parent's stderr sink.
    # No raw exception message/page text: it can contain private session data.
    $failure = Get-NativePtFailure -ErrorRecord $_
    $failure | Add-Member -NotePropertyName diagnosticStage -NotePropertyValue $diagnosticStage -Force
    $failure | Add-Member -NotePropertyName checkinClickAttempted -NotePropertyValue ([bool]$script:checkinClickAttempted) -Force
    $failure | Add-Member -NotePropertyName checkinClicked -NotePropertyValue ([bool]$checkinClicked) -Force
    if ($script:nativeLocalSubmissionAttempted) {
        $failure | Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $true -Force
    }
    $failure | Complete-NativePtResult | ConvertTo-Json -Depth 8
    exit 2
}
finally {
    if ($started -or (Get-ProfileChromeProcesses).Count -gt 0) { Close-ProfileChrome }
}
