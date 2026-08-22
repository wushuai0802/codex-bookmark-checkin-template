Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

function Invoke-PlainCredentialLoginAccessibility {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][pscustomobject]$Config,
        [Parameter(Mandatory = $true)][string]$Origin,
        [Parameter(Mandatory = $true)][string]$LoginUrl,
        [Parameter(Mandatory = $true)][string]$VerificationUrl,
        [Parameter(Mandatory = $true)][string]$Username,
        [Parameter(Mandatory = $true)][string]$Password,
        [string]$AutomationUserDataDirOverride,
        [ValidateRange(20, 120)][int]$TimeoutSeconds = 120,
        [switch]$ProbeOnly
    )

    $originUri = [Uri]$Origin
    $loginUri = [Uri]$LoginUrl
    $verificationUri = [Uri]$VerificationUrl
    $originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
    $profilePath = [System.IO.Path]::GetFullPath([string]$Config.automationUserDataDir)
    $root = Split-Path -Parent $PSScriptRoot
    $allowedRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
    $allowedPrefix = $allowedRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar
    if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or
        $loginUri.Scheme -ne 'https' -or $loginUri.UserInfo -or
        $verificationUri.Scheme -ne 'https' -or $verificationUri.UserInfo -or
        $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue -or
        $verificationUri.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
        throw '无调试凭据登录地址必须属于目标 HTTPS origin。'
    }
    if (-not $profilePath.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "机器人 Chrome 目录必须位于 $allowedRoot"
    }

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

    function Test-AddressElement([System.Windows.Automation.AutomationElement]$Element) {
        try {
            $name = [string]$Element.Current.Name
            $automationId = [string]$Element.Current.AutomationId
            return $name -match '^(Address and search bar|地址栏|地址和搜索栏|網址列|網址和搜尋列)$' `
                -or $automationId -in @('view_1012', 'view_1022')
        }
        catch { return $false }
    }

    function Get-AddressElement {
        foreach ($element in @(Get-AllAutomationElements)) {
            try {
                if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
                    (Test-AddressElement $element)) { return $element }
            }
            catch { }
        }
        return $null
    }

    function Get-PrivateCurrentUri {
        $address = Get-AddressElement
        if (-not $address) { return $null }
        try {
            $pattern = $address.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $raw = [string]$pattern.Current.Value
            if ($raw -notmatch '^[a-z][a-z0-9+.-]*://' -and $raw -match '^[A-Za-z0-9.-]+(?:/|$)') {
                $raw = "https://$raw"
            }
            $value = $null
            if ([Uri]::TryCreate($raw, [System.UriKind]::Absolute, [ref]$value)) { return $value }
        }
        catch { }
        return $null
    }

    function Get-LoginEditControls {
        @(
            Get-AllAutomationElements | Where-Object {
                try {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit `
                        -and $_.Current.IsEnabled `
                        -and $_.Current.IsKeyboardFocusable `
                        -and -not (Test-AddressElement $_)
                }
                catch { $false }
            }
        )
    }

    function Set-ControlValue(
        [System.Windows.Automation.AutomationElement]$Element,
        [string]$Value
    ) {
        if (-not $Element) { return $false }
        try {
            $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $pattern.SetValue($Value)
            return $true
        }
        catch { return $false }
    }

    function Invoke-Control([System.Windows.Automation.AutomationElement]$Element) {
        if (-not $Element) { return $false }
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

    function Get-UniqueButton([string[]]$Labels) {
        $found = @(
            Get-AllAutomationElements | Where-Object {
                try {
                    $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button `
                        -and $_.Current.IsEnabled `
                        -and ([string]$_.Current.Name).Trim() -in $Labels
                }
                catch { $false }
            }
        )
        if ($found.Count -eq 1) { return $found[0] }
        return $null
    }

    function Invoke-AddressNavigation([string]$Url) {
        $address = Get-AddressElement
        if (-not $address -or -not (Set-ControlValue $address $Url)) { return $false }
        try {
            $address.SetFocus()
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            return $true
        }
        catch { return $false }
    }

    function Get-AccessibleText {
        $parts = @()
        foreach ($element in @(Get-AllAutomationElements)) {
            try {
                if (Test-AddressElement $element) { continue }
                $name = ([string]$element.Current.Name).Trim()
                if ($name -and $name.Length -le 300) { $parts += $name }
                if ($parts.Count -ge 800) { break }
            }
            catch { }
        }
        return ($parts -join "`n").Substring(0, [Math]::Min(30000, ($parts -join "`n").Length))
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
        if ($remaining.Count -gt 0) {
            $remaining | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
    }

    if ((Get-ProfileChromeProcesses).Count -gt 0) {
        return [pscustomobject]@{ status = 'failed'; diagnostic = 'profile_busy'; submitted = $false }
    }

    $started = $false
    $submitted = $false
    $challengeClicked = $false
    $stage = 'browser_startup'
    try {
        $openArguments = @('-Offscreen', '-DisableExtensions', '-Urls', @($loginUri.AbsoluteUri))
        if ($AutomationUserDataDirOverride) {
            $openArguments += @('-UserDataDirOverride', $AutomationUserDataDirOverride)
        }
        & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openArguments | Out-Null
        $started = $true
        $windowDeadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $windowDeadline -and @(Get-ChromeAutomationRoots).Count -eq 0) {
            Start-Sleep -Milliseconds 500
        }
        if (@(Get-ChromeAutomationRoots).Count -eq 0) {
            return [pscustomobject]@{ status = 'failed'; diagnostic = 'browser_startup'; submitted = $false }
        }

        $stage = 'wait_for_challenge'
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $controls = @()
        while ((Get-Date) -lt $deadline) {
            $location = Get-PrivateCurrentUri
            if ($location -and $location.GetLeftPart([System.UriPartial]::Authority) -eq $originValue) {
                $controls = @(Get-LoginEditControls)
                $usernameControl = @($controls | Where-Object { -not $_.Current.IsPassword -and [string]::IsNullOrWhiteSpace([string]$_.Current.Name) }) | Select-Object -First 1
                $passwordControl = @($controls | Where-Object { $_.Current.IsPassword }) | Select-Object -First 1
                if ($usernameControl -and $passwordControl) {
                    break
                }
            }
            Start-Sleep -Seconds 1
        }

        $controls = @(Get-LoginEditControls)
        $usernameControl = @($controls | Where-Object {
            -not $_.Current.IsPassword -and [string]::IsNullOrWhiteSpace([string]$_.Current.Name)
        }) | Select-Object -First 1
        $passwordControl = @($controls | Where-Object { $_.Current.IsPassword }) | Select-Object -First 1
        if (-not $usernameControl -or -not $passwordControl) {
            return [pscustomobject]@{
                status = 'needs_attention'
                diagnostic = 'form_unsupported'
                submitted = $false
                challengeClicked = $challengeClicked
            }
        }

        $stage = 'fill_form'
        if (-not (Set-ControlValue $usernameControl $Username) -or
            -not (Set-ControlValue $passwordControl $Password)) {
            return [pscustomobject]@{ status = 'failed'; diagnostic = 'form_fill_failed'; submitted = $false }
        }
        $stage = 'wait_for_post_fill_challenge'
        $postFillDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $postFillDeadline) {
            $challenge = Get-UniqueButton @('Verify you are human', '验证您是真人', '驗證您是真人')
            if ($challenge -and -not $challengeClicked -and (Invoke-Control $challenge)) {
                $challengeClicked = $true
            }
            Start-Sleep -Seconds 1
        }
        if ($ProbeOnly) {
            return [pscustomobject]@{
                status = 'ready_for_submit'
                submitted = $false
                challengeClicked = $challengeClicked
            }
        }
        $loginButton = Get-UniqueButton @('登录', '登入', '用户登录', '用戶登入', 'Log in', 'Sign in')
        if (-not $loginButton) {
            return [pscustomobject]@{ status = 'needs_attention'; diagnostic = 'submit_unavailable'; submitted = $false }
        }

        $stage = 'submit_form'
        if (-not (Invoke-Control $loginButton)) {
            return [pscustomobject]@{ status = 'failed'; diagnostic = 'submit_failed'; submitted = $false }
        }
        $submitted = $true
        Start-Sleep -Seconds 5

        $stage = 'verify_session'
        if (-not (Invoke-AddressNavigation $verificationUri.AbsoluteUri)) {
            return [pscustomobject]@{ status = 'failed'; diagnostic = 'verification_navigation_failed'; submitted = $true }
        }
        $verified = $false
        $finalLocation = $null
        $accessibleText = ''
        $verifyDeadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $verifyDeadline) {
            $finalLocation = Get-PrivateCurrentUri
            $accessibleText = Get-AccessibleText
            $passwordVisible = @(Get-LoginEditControls | Where-Object { $_.Current.IsPassword }).Count -gt 0
            $onVerificationOrigin = $finalLocation `
                -and $finalLocation.GetLeftPart([System.UriPartial]::Authority) -eq $originValue
            $onLoginRoute = $finalLocation -and $finalLocation.AbsolutePath -match '^/(?:take[-_]?(?:log[-_]?in|sign[-_]?in)|log[-_]?in|sign[-_]?in|auth)(?:\.(?:php|asp|aspx|html?))?(?:/|$)'
            $loggedOutText = $accessibleText -match '(未登录|尚未登录|请先登录|請先登入|必须登录后|必須登入後|not logged in|sign in to continue|login required)'
            $challengeText = $accessibleText -match '(Just a moment|正在进行安全验证|Performing security verification|当前环境正在被调试|verify you are human)'
            if ($onVerificationOrigin -and -not $onLoginRoute -and -not $passwordVisible `
                -and -not $loggedOutText -and -not $challengeText -and $accessibleText.Length -ge 20) {
                $verified = $true
                break
            }
            Start-Sleep -Seconds 1
        }

        if (-not $verified) {
            $invalidCredential = $accessibleText -match '(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)'
            return [pscustomobject]@{
                status = if ($invalidCredential) { 'invalid_credential' } else { 'failed' }
                diagnostic = if ($invalidCredential) { 'invalid_credential' } else { 'session_not_established' }
                submitted = $true
                challengeClicked = $challengeClicked
            }
        }

        $dailyStatus = if ($accessibleText -match '(今日已签到|今天已签到|今天已经签到过|已经签到|已完成签到|已签到|已簽到|already checked[ -]?in|checked in today)') {
            'already_signed'
        } elseif ($accessibleText -match '(签到成功|簽到成功|成功签到|成功簽到|successfully checked[ -]?in)') {
            'signed'
        } else { $null }
        $success = [ordered]@{
            status = 'logged_in'
            finalUrl = $verificationUri.GetLeftPart([System.UriPartial]::Authority) + $verificationUri.AbsolutePath
            submitted = $true
            challengeClicked = $challengeClicked
        }
        if ($dailyStatus) {
            $success.dailyCheckin = [pscustomobject]@{
                status = $dailyStatus
                reason = if ($dailyStatus -eq 'already_signed') { '今天已经签到' } else { '页面显示签到成功' }
                evidence = [pscustomobject]@{ source = 'credential_verification' }
            }
        }
        return [pscustomobject]$success
    }
    catch {
        return [pscustomobject]@{ status = 'failed'; diagnostic = $stage; submitted = $submitted }
    }
    finally {
        if ($started) { Close-ProfileChrome }
    }
}
