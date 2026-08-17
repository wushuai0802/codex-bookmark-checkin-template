[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Url,
    [ValidateRange(5, 120)][int]$TimeoutSeconds = 60,
    [string]$UserDataDirOverride,
    [switch]$AllowPreparedSiteBody,
    [switch]$AllowCloudflareChallengeClick
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
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

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

function Get-ProfileChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profilePath*" })
}

function Get-ChromeAutomationRoots {
    $ids = @(Get-ProfileChromeProcesses | Select-Object -ExpandProperty ProcessId)
    if ($ids.Count -eq 0) { return @() }
    @(
        Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -in $ids -and $_.MainWindowHandle -ne 0
        } | ForEach-Object {
            try { [System.Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) } catch { $null }
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
    $elements = @(Get-AllAutomationElements)
    $names = @()
    $documents = @()
    $nonAddressEdits = 0
    foreach ($element in $elements) {
        try {
            $name = ([string]$element.Current.Name).Trim()
            $type = [string]$element.Current.ControlType.ProgrammaticName
            if ($type -in @('ControlType.Text', 'ControlType.Hyperlink', 'ControlType.Document') -and $name) {
                $names += $name
            }
            if ($type -eq 'ControlType.Document' -and $name -and $name -notmatch '^Chrome(?:\s|$)') {
                $documents += $name
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
    $currentUri = Get-CurrentUri
    $leichiWaf = $bodyText -match '当前环境正在被调试|正在进行安全检测|安全检测能力由\s*雷池|如您是正常访问|客户端异常.*确认.*合法用户'
    $cloudflareWaf = $bodyText -match '请稍候[.…]*\s*[^ ]+\s*正在进行安全验证|本网站使用安全服务防护恶意自动程序|Just a moment|Performing security verification|Verify you are human|Cloudflare.*performance and security'
    $waf = $leichiWaf -or $cloudflareWaf
    $success = $bodyText -match '签到成功|签到已得\s*\d+|今日已签到|今天已签到|已签到'
    $loginRoute = $null -ne $currentUri -and $currentUri.AbsolutePath -match '/(?:log[-_]?in|sign[-_]?in|auth)(?:/|$)'
    # Some NexusPHP sites canonicalize between www and the bare host after the
    # WAF challenge. Treat only that narrow host alias as equivalent; scheme,
    # port, and the remaining hostname must still match.
    $sameOrigin = $null -ne $currentUri -and (Test-EquivalentWafOrigin $originUri $currentUri)
    $attendanceEndpoint = $null -ne $currentUri -and $currentUri.AbsolutePath -match '/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:/|$)'
    [pscustomobject]@{
        currentUrl = if ($currentUri) { $currentUri.AbsoluteUri } else { '' }
        bodyText = $bodyText.Substring(0, [Math]::Min(2000, $bodyText.Length))
        document = (@($documents | Select-Object -Unique) -join ' ').Substring(0, [Math]::Min(500, (@($documents | Select-Object -Unique) -join ' ').Length))
        waf = [bool]$waf
        leichiWaf = [bool]$leichiWaf
        cloudflareWaf = [bool]$cloudflareWaf
        success = [bool]$success
        loginRoute = [bool]$loginRoute
        sameOrigin = [bool]$sameOrigin
        attendanceEndpoint = [bool]$attendanceEndpoint
        siteBodyLoaded = (-not $waf -and $sameOrigin -and $bodyText.Length -gt 80)
        nonAddressEdits = $nonAddressEdits
    }
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
                try {
                    if (-not $button.Current.IsEnabled) { continue }
                    $invoke = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    $invoke.Invoke()
                    return $true
                }
                catch {
                    try {
                        $button.SetFocus()
                        [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                        return $true
                    }
                    catch { }
                }
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
    $control = $matches[0]
    try {
        $invoke = $control.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        return $true
    }
    catch { }
    try {
        $toggle = $control.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
        return $true
    }
    catch { }
    try {
        $legacy = $control.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $legacy.DoDefaultAction()
        return $true
    }
    catch { return $false }
}

if ((Get-ProfileChromeProcesses).Count -gt 0) { throw '机器人专用 Chrome 配置正被占用。' }
$started = $false
try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Minimized -DisableExtensions `
        -Urls @($targetUri.AbsoluteUri) -UserDataDirOverride $profilePath | Out-Null
    $windowDeadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) { Start-Sleep -Milliseconds 500 }
    if (@(Get-ChromeAutomationRoots).Count -eq 0) { throw '原生 Chrome 没有可用的无障碍窗口。' }
    $started = $true

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $confirmationClickAttempted = $false
    $confirmationClicked = $false
    $cloudflareObservedAt = $null
    $cloudflareChallengeClicked = $false
    $last = $null
    do {
        $last = Read-PageSnapshot
        if ($last.success -and $last.siteBodyLoaded) {
            [pscustomobject]@{
                status = 'signed'
                reason = '无调试原生 Chrome 页面确认签到完成'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                inspection = $last
            } | ConvertTo-Json -Depth 8
            exit 0
        }
        if ($last.siteBodyLoaded -and $last.attendanceEndpoint -and -not $last.loginRoute) {
            [pscustomobject]@{
                status = 'ready'
                reason = '无调试原生 Chrome 已通过 WAF 并加载签到页面'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                inspection = $last
            } | ConvertTo-Json -Depth 8
            exit 0
        }
        if ($AllowPreparedSiteBody -and $last.siteBodyLoaded -and -not $last.loginRoute) {
            [pscustomobject]@{
                status = 'ready'
                reason = '无调试原生 Chrome 已完成安全验证预热'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                inspection = $last
            } | ConvertTo-Json -Depth 8
            exit 0
        }
        if ($last.loginRoute -or $last.nonAddressEdits -ge 2) {
            [pscustomobject]@{
                status = 'login_required'
                reason = '无调试原生 Chrome 进入登录页'
                confirmationClickAttempted = $confirmationClickAttempted
                confirmationClicked = $confirmationClicked
                cloudflareChallengeClicked = $cloudflareChallengeClicked
                inspection = $last
            } | ConvertTo-Json -Depth 8
            exit 2
        }
        if ($last.waf -and $last.bodyText -match '客户端异常.*确认.*合法用户' -and -not $confirmationClickAttempted) {
            $confirmationClickAttempted = $true
            $confirmationClicked = Invoke-LeichiConfirmationClick
            if ($confirmationClicked) {
                Start-Sleep -Seconds 2
                continue
            }
        }
        if ($last.cloudflareWaf -and $null -eq $cloudflareObservedAt) { $cloudflareObservedAt = Get-Date }
        if ($AllowCloudflareChallengeClick -and $last.cloudflareWaf -and -not $cloudflareChallengeClicked -and
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
        status = if ($last.waf) { 'managed_challenge' } else { 'unconfirmed' }
        reason = "无调试原生 Chrome 未取得签到终态（雷池确认点击=$confirmationClicked，Cloudflare 验证点击=$cloudflareChallengeClicked）"
        confirmationClickAttempted = $confirmationClickAttempted
        confirmationClicked = $confirmationClicked
        cloudflareChallengeClicked = $cloudflareChallengeClicked
        inspection = $last
    } | ConvertTo-Json -Depth 8
    exit 2
}
finally {
    if ($started -or (Get-ProfileChromeProcesses).Count -gt 0) { Close-ProfileChrome }
}
