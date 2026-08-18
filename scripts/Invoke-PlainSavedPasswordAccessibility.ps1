[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$LoginUrl,
    [ValidateRange(20, 120)][int]$TimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$originUri = [uri]$Origin
$loginUri = [uri]$LoginUrl
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$profilePath = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
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

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

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

function Get-UniqueLoginButton {
    $labels = @('登录', '登入', '用户登录', '用戶登入', 'Log in', 'Sign in')
    $found = @()
    foreach ($element in @(Get-AllAutomationElements)) {
        try {
            if (-not $element.Current.IsEnabled -or $element.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
            if ([string]$element.Current.Name -in $labels) { $found += $element }
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
    catch { }
    try {
        $pattern = $Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
        $pattern.DoDefaultAction()
        return $true
    }
    catch { return $false }
}

function Focus-Control([System.Windows.Automation.AutomationElement]$Element) {
    try { $Element.SetFocus(); return $true }
    catch { return $false }
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

$attemptedPasswordSelection = $false
$submitted = $false
$loggedIn = $false
try {
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -EnablePasswordManager -Urls @($loginUri.AbsoluteUri) | Out-Null
    $windowDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) { Start-Sleep -Milliseconds 500 }
    if (@(Get-ChromeAutomationRoots).Count -eq 0) { throw '原生 Chrome 没有可用的无障碍窗口。' }

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $selectionAttempts = 0
    while ((Get-Date) -lt $deadline) {
        $location = Get-PrivateCurrentUri
        if ($location -and $location.GetLeftPart([System.UriPartial]::Authority) -eq $originValue -and
            $location.AbsolutePath -notmatch '^/(?:log[-_]?in|sign[-_]?in|auth)(?:/|$)') {
            $loggedIn = $true
            break
        }

        $edits = @(Get-LoginEditControls)
        if ($edits.Count -ge 2 -and $selectionAttempts -lt 3) {
            foreach ($control in @($edits[0], $edits[1], $edits[0])) {
                if (Focus-Control $control) {
                    [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
                    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
                    Start-Sleep -Milliseconds 900
                    $attemptedPasswordSelection = $true
                }
            }
            $selectionAttempts += 1
        }

        if (-not $submitted -and $attemptedPasswordSelection) {
            $button = Get-UniqueLoginButton
            if ($button -and (Invoke-Control $button)) {
                $submitted = $true
                Start-Sleep -Seconds 3
                continue
            }
        }
        Start-Sleep -Seconds 2
    }

    [pscustomobject]@{
        status = if ($loggedIn) { 'logged_in' } elseif ($attemptedPasswordSelection) { 'needs_attention' } else { 'no_saved_credential' }
        attemptedPasswordSelection = $attemptedPasswordSelection
        submitted = $submitted
    } | ConvertTo-Json -Compress
    if (-not $loggedIn) { exit 2 }
}
finally {
    Close-ProfileChrome
}
