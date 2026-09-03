[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$LoginUrl,
    [ValidateRange(20, 120)][int]$TimeoutSeconds = 60,
    [string]$UserDataDirOverride
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$originUri = [uri]$Origin
$loginUri = [uri]$LoginUrl
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$profilePath = [System.IO.Path]::GetFullPath($(if ($UserDataDirOverride) { $UserDataDirOverride } else { [string]$config.automationUserDataDir }))
$allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedPrefix = $allowedRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or
    $loginUri.Scheme -ne 'https' -or $loginUri.UserInfo -or
    $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '后台保存密码登录地址无效。'
}
if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedRoot"
}

. (Join-Path $PSScriptRoot 'Safe-UIAutomation.ps1')

function Get-ProfileChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}

function Get-ChromeAutomationRoots {
    $ids = @(Get-ProfileChromeProcesses | Select-Object -ExpandProperty ProcessId)
    if ($ids.Count -eq 0) { return @() }
    @(
        Get-Process chrome -ErrorAction SilentlyContinue | Where-Object {
            $_.Id -in $ids -and $_.MainWindowHandle -ne 0
        } | ForEach-Object {
            try { [System.Windows.Automation.AutomationElement]::FromHandle($_.MainWindowHandle) }
            catch { $null }
        } | Where-Object { $null -ne $_ }
    )
}

function Test-SecondFactorVisible {
    foreach ($window in @(Get-ChromeAutomationRoots)) {
        try {
            $elements = $window.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )
            $text = (@($elements | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join ' ')
            if ($text -match '异地登录安全验证|異地登錄安全驗證|忘记二级验证|忘記二級驗證|二级验证代码|二級驗證碼|\b2FA\b') { return $true }
        } catch { }
    }
    return $false
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

function Get-LoginEditControls {
    $controls = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or -not $element.Current.IsEnabled) { continue }
            $name = [string]$element.Current.Name
            $automationId = [string]$element.Current.AutomationId
            if ($name -match '^(Address and search bar|地址栏|地址和搜索栏|網址列|網址和搜尋列)$' -or $automationId -eq 'view_1022') { continue }
            if (-not $element.Current.IsKeyboardFocusable) { continue }
            $controls += $element
        }
        catch { }
    }
    return @($controls)
}

function Invoke-Control([System.Windows.Automation.AutomationElement]$Element) {
    return Invoke-SafeAutomationControl -Element $Element -AllowedPatterns @('Invoke')
}

function Dismiss-PasswordProtectionPrompt {
    $paneNames = @('使用 Windows Hello 保护密码', 'Use Windows Hello to protect passwords')
    $closeNames = @('关闭', 'Close')
    foreach ($automationRoot in @(Get-ChromeAutomationRoots)) {
        try {
            $panes = @($automationRoot.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )) | Where-Object {
                try {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Pane `
                        -and ([string]$_.Current.Name) -in $paneNames
                }
                catch { $false }
            }
            foreach ($pane in $panes) {
                $button = @($pane.FindAll(
                    [System.Windows.Automation.TreeScope]::Descendants,
                    [System.Windows.Automation.Condition]::TrueCondition
                )) | Where-Object {
                    try {
                        $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button `
                            -and ([string]$_.Current.Name) -in $closeNames
                    }
                    catch { $false }
                } | Select-Object -First 1
                if ($button -and (Invoke-Control $button)) { return $true }
            }
        }
        catch { }
    }
    return $false
}

function Disable-AutoLogoutOption {
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            if ($element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Group) { continue }
            $name = ([string]$element.Current.Name).Trim()
            if ($name -notmatch '(?:15\s*(?:分钟|分鐘|minutes?)\s*(?:后|後)?\s*(?:自动|自動)?(?:登出|退出|log\s*out)|(?:自动|自動)(?:登出|退出).{0,20}15)') { continue }
            $checkbox = @($element.FindAll(
                [System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition
            )) | Where-Object {
                try { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox }
                catch { $false }
            } | Select-Object -First 1
            if (-not $checkbox) { continue }
            $toggle = $checkbox.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
            return $true
        }
        catch { }
    }
    return $false
}

function Close-ProfileChrome {
    $targets = @(Get-ProfileChromeProcesses)
    $ids = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $ids -notcontains $_.ParentProcessId })
    foreach ($info in $roots) {
        $process = Get-Process -Id $info.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-ProfileChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) {
        $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
}

if ((Get-ProfileChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 正被占用，无法执行后台保存密码恢复。'
}

$submitted = $false
$loggedIn = $false
$twoFactorRequired = $false
$safeInteractionUnavailable = $false
$passwordPromptDismissed = $false
$autoLogoutDisabled = $false
try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -EnablePasswordManager -Urls @($loginUri.AbsoluteUri) -UserDataDirOverride $profilePath | Out-Null
    $windowDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) { Start-Sleep -Milliseconds 500 }
    if (@(Get-ChromeAutomationRoots).Count -eq 0) { throw '原生 Chrome 没有可用的无障碍窗口。' }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-SecondFactorVisible) {
            $twoFactorRequired = $true
            break
        }
        if (-not $passwordPromptDismissed) {
            $passwordPromptDismissed = Dismiss-PasswordProtectionPrompt
            if ($passwordPromptDismissed) { Start-Sleep -Milliseconds 500 }
        }
        $location = Get-PrivateCurrentUri
        if ($location -and $location.GetLeftPart([System.UriPartial]::Authority) -eq $originValue -and
            $location.AbsolutePath -notmatch '^/(?:log[-_]?in|sign[-_]?in|auth)(?:\.(?:php|asp|aspx|html?))?(?:/|$)') {
            $loggedIn = $true
            break
        }

        if (-not $autoLogoutDisabled) { $autoLogoutDisabled = Disable-AutoLogoutOption }
        $edits = @(Get-LoginEditControls)
        if ($edits.Count -ge 2) {
            # Chrome's password suggestion menu cannot be triggered reliably
            # without foreground keyboard input. Let the bounded retry chain
            # choose another recovery method instead of stealing user focus.
            $safeInteractionUnavailable = $true
            break
        }
        Start-Sleep -Seconds 2
    }

    [pscustomobject]@{
        status = if ($loggedIn) { 'logged_in' } elseif ($twoFactorRequired) { 'needs_attention' } else { 'failed' }
        failureCode = if ($twoFactorRequired) { 'two_factor_required' } else { $null }
        attentionKind = if ($twoFactorRequired) { 'trusted_device_initialization' } else { $null }
        diagnostic = if ($safeInteractionUnavailable) { 'safe_interaction_unavailable' } else { 'session_not_established' }
        safeInteractionUnavailable = $safeInteractionUnavailable
        submitted = $submitted
        passwordPromptDismissed = $passwordPromptDismissed
        autoLogoutDisabled = $autoLogoutDisabled
    } | ConvertTo-Json -Compress
    if (-not $loggedIn) { exit 2 }
}
finally {
    Close-ProfileChrome
}
