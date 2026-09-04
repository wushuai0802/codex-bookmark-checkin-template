[CmdletBinding()]
param(
    [int]$LoadTimeoutSeconds = 20,
    [string[]]$Origins,
    [switch]$AllConfigured
)

$ErrorActionPreference = 'Stop'
if ($AllConfigured -and $PSBoundParameters.ContainsKey('Origins')) {
    throw '不能同时指定 -Origins 和 -AllConfigured。'
}
if (-not $AllConfigured -and (-not $PSBoundParameters.ContainsKey('Origins') -or @($Origins).Count -eq 0)) {
    throw '必须显式传入非空 -Origins；确需预热全部配置项时请使用 -AllConfigured。'
}
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ResultContract.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$defaultProfilePath = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir)
$allowedDataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedDataPrefix = $allowedDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
function Resolve-NativeProfilePath([string]$ConfiguredPath) {
    $candidate = if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) {
        $defaultProfilePath
    } elseif ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        [System.IO.Path]::GetFullPath($ConfiguredPath)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $root $ConfiguredPath))
    }
    if (-not $candidate.StartsWith($allowedDataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "原生 Chrome profile 必须位于 $allowedDataRoot"
    }
    return $candidate
}
function Test-TwoFactorResult($Result) {
    return $null -ne $Result -and (
        [string]$Result.failureCode -eq 'two_factor_required' -or
        ([string]$Result.status -eq 'needs_attention' -and [string]$Result.attentionKind -eq 'trusted_device_initialization')
    )
}
$profilePath = $defaultProfilePath
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'Native-ChromeDebug.ps1')
$node = Resolve-CheckinNode $config
$inspector = Join-Path $root 'src\native-browser-inspect.mjs'
$items = @($config.nativeWafPreflightUrls | ForEach-Object {
    $rawUrl = if ($_ -is [string]) { [string]$_ } else { [string]$_.url }
    $uri = [uri]$rawUrl
    $waitSeconds = if ($_ -is [string] -or $null -eq $_.waitSeconds) { 30 } else { [int]$_.waitSeconds }
    $passiveOnly = $_ -isnot [string] -and [bool]$_.passiveOnly
    $trustAsSigned = if ($_ -isnot [string] -and $null -ne $_.trustAsSigned) { [bool]$_.trustAsSigned } else { $true }
    $windowMode = if ($_ -isnot [string] -and $_.windowMode) { [string]$_.windowMode } else { 'offscreen' }
    if ($windowMode -notin @('offscreen', 'minimized', 'visible')) { throw "原生 WAF 窗口模式无效：$rawUrl" }
    $itemProfilePath = Resolve-NativeProfilePath $(if ($_ -isnot [string]) { [string]$_.automationUserDataDir } else { '' })
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生 WAF 预热地址无效：$rawUrl" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生 WAF 等待时间必须为 5 到 120 秒：$rawUrl" }
    $nativeActionOrigins = @($config.nativeAccessibilityCheckinOrigins | ForEach-Object { [string]$_ })
    $action = if ($nativeActionOrigins -contains $uri.GetLeftPart([System.UriPartial]::Authority)) { 'checkin' } else { '' }
    [pscustomobject]@{ url = $uri.AbsoluteUri; waitSeconds = $waitSeconds; trustAsSigned = $trustAsSigned; passiveOnly = $passiveOnly; action = $action; windowMode = $windowMode; profilePath = $itemProfilePath }
})
$items += @($config.nativeChallengePreflight | ForEach-Object {
    $uri = [uri][string]$_.url
    $waitSeconds = [int]$_.waitSeconds
    $passiveOnly = [bool]$_.passiveOnly
    $windowMode = if ($_.windowMode) { [string]$_.windowMode } else { 'offscreen' }
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生验证预热地址无效：$($_.url)" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生验证等待时间必须为 5 到 120 秒：$($_.url)" }
    if ($windowMode -notin @('offscreen', 'minimized', 'visible')) { throw "原生验证窗口模式无效：$($_.url)" }
    $action = if ($null -eq $_.action) { '' } else { [string]$_.action }
    if ($action -notin @('', 'checkin')) { throw "原生验证动作无效：$action" }
    $reloadOnChallengeAfterSeconds = if ($null -eq $_.reloadOnChallengeAfterSeconds) { 0 } else { [int]$_.reloadOnChallengeAfterSeconds }
    if ($reloadOnChallengeAfterSeconds -ne 0 -and (
        $reloadOnChallengeAfterSeconds -lt 5 `
        -or $reloadOnChallengeAfterSeconds -ge $waitSeconds
    )) {
        throw "验证页重载等待时间必须为 0，或介于 5 秒和总等待时间之间：$($_.url)"
    }
    [pscustomobject]@{
        url = $uri.AbsoluteUri
        waitSeconds = $waitSeconds
        trustAsSigned = $false
        action = $action
        passiveOnly = $passiveOnly
        windowMode = $windowMode
        reloadOnChallengeAfterSeconds = $reloadOnChallengeAfterSeconds
        profilePath = Resolve-NativeProfilePath ([string]$_.automationUserDataDir)
    }
})

$mainFallbackByOrigin = @{}
foreach ($entry in @($config.mainChromeFallbackUrls)) {
    $rawUrl = if ($entry -is [string]) { [string]$entry } else { [string]$entry.url }
    $uri = [uri]$rawUrl
    $sourceOrigin = if ($entry -isnot [string] -and $entry.sourceOrigin) {
        ([uri][string]$entry.sourceOrigin).GetLeftPart([System.UriPartial]::Authority)
    } else {
        $uri.GetLeftPart([System.UriPartial]::Authority)
    }
    $waitSeconds = if ($entry -is [string] -or $null -eq $entry.waitSeconds) { 90 } else { [int]$entry.waitSeconds }
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or -not $uri.Host) { throw "主 Chrome 回退地址无效：$rawUrl" }
    $sourceUri = [uri]$sourceOrigin
    if ($sourceUri.Scheme -ne 'https' -or $sourceUri.UserInfo -or -not $sourceUri.Host) { throw "主 Chrome 回退来源无效：$sourceOrigin" }
    $relatedProperty = $config.relatedCandidateUrls.PSObject.Properties[$sourceOrigin]
    $relatedOrigins = @(if ($null -ne $relatedProperty) {
        $relatedProperty.Value | ForEach-Object {
            ([uri][string]$_).GetLeftPart([System.UriPartial]::Authority)
        }
    })
    if ($uri.GetLeftPart([System.UriPartial]::Authority) -ne $sourceOrigin -and
        $uri.GetLeftPart([System.UriPartial]::Authority) -notin $relatedOrigins) {
        throw "主 Chrome 回退目标不在书签关联来源中：$sourceOrigin"
    }
    if ($waitSeconds -lt 10 -or $waitSeconds -gt 180) { throw "主 Chrome 回退等待时间必须为 10 到 180 秒：$rawUrl" }
    $entryOrigin = $sourceOrigin
    if ($mainFallbackByOrigin.ContainsKey($entryOrigin)) { throw "主 Chrome 回退来源重复：$entryOrigin" }
    $mainFallbackByOrigin[$entryOrigin] = [pscustomobject]@{
        url = $uri.AbsoluteUri
        waitSeconds = $waitSeconds
        oauthProvider = if ($entry -isnot [string]) { [string]$entry.oauthProvider } else { '' }
    }
}

$configuredItemOrigins = @{}
foreach ($configuredItem in $items) {
    $configuredOrigin = if ($configuredItem.sourceOrigin) {
        [string]$configuredItem.sourceOrigin
    } else {
        ([uri][string]$configuredItem.url).GetLeftPart([System.UriPartial]::Authority)
    }
    $configuredItemOrigins[$configuredOrigin] = $true
}
foreach ($entryOrigin in @($mainFallbackByOrigin.Keys)) {
    if ($configuredItemOrigins.ContainsKey($entryOrigin)) { continue }
    $fallback = $mainFallbackByOrigin[$entryOrigin]
    $items += [pscustomobject]@{
        url = [string]$fallback.url
        waitSeconds = [int]$fallback.waitSeconds
        trustAsSigned = $false
        passiveOnly = $true
        profilePath = $defaultProfilePath
        mainChromeFallbackOnly = $true
        sourceOrigin = $entryOrigin
    }
}

if (-not $AllConfigured) {
    $originSet = @{};
    foreach ($origin in $Origins) { $originSet[([uri]$origin).GetLeftPart([System.UriPartial]::Authority)] = $true }
    $items = @($items | Where-Object {
        $itemOrigin = if ($_.sourceOrigin) { [string]$_.sourceOrigin } else { ([uri]$_.url).GetLeftPart([System.UriPartial]::Authority) }
        $originSet.ContainsKey($itemOrigin)
    })
}

$knownNoCheckin = @{}
foreach ($value in @($config.knownNoCheckinFeatureOrigins)) { $knownNoCheckin[[string]$value] = $true }
$autoClickTurnstile = @{}
foreach ($value in @($config.autoClickTurnstileOrigins)) { $autoClickTurnstile[[string]$value] = $true }
$siteStatePath = Join-Path $root 'data\site-state.json'
if ($knownNoCheckin.Count -gt 0 -and (Test-Path -LiteralPath $siteStatePath)) {
    try {
        $siteState = Get-Content -Raw -Encoding UTF8 -LiteralPath $siteStatePath | ConvertFrom-Json
        $configuredHours = if ($null -ne $config.knownNoCheckinRecheckHours) { [double]$config.knownNoCheckinRecheckHours } else { 168 }
        $recheckHours = [Math]::Max(24, [Math]::Min(720, $configuredHours))
        $items = @($items | Where-Object {
            $itemOrigin = ([uri][string]$_.url).GetLeftPart([System.UriPartial]::Authority)
            if (-not $knownNoCheckin.ContainsKey($itemOrigin)) { return $true }
            $prior = $siteState.sites.PSObject.Properties[$itemOrigin].Value
            if ($null -eq $prior -or -not $prior.lastConfirmedAt) { return $true }
            $nowOffset = [datetimeoffset]::Now
            $cachedResult = [pscustomobject]@{
                status = [string]$prior.lastConfirmedStatus
                availabilityKind = [string]$prior.lastAvailabilityKind
                evidence = $prior.lastConfirmedEvidence
            }
            if (-not (Test-ConfirmedNotAvailableResult $cachedResult $nowOffset)) { return $true }
            $stateConfirmedAt = [datetimeoffset]::MinValue
            $evidenceConfirmedAt = [datetimeoffset]::MinValue
            if (-not [datetimeoffset]::TryParse([string]$prior.lastConfirmedAt, [ref]$stateConfirmedAt) -or
                -not [datetimeoffset]::TryParse([string]$prior.lastConfirmedEvidence.confirmedAt, [ref]$evidenceConfirmedAt) -or
                $stateConfirmedAt -gt $nowOffset.AddMinutes(5) -or
                $evidenceConfirmedAt -gt $stateConfirmedAt.AddMinutes(5)) { return $true }
            return ($nowOffset - $evidenceConfirmedAt).TotalHours -ge $recheckHours
        })
    }
    catch { Write-Warning '无法读取近期未开放签到缓存，将继续执行原生预热。' }
}

if ($items.Count -eq 0) { return }

function Get-AutomationChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}

$preflightResults = @()

function Invoke-MainChromeFallbackResult([string]$Origin, [string]$Url, [int]$TimeoutSeconds) {
    if (-not $mainFallbackByOrigin.ContainsKey($Origin)) { return $null }
    $transientWindowFailures = @(
        'window_not_created',
        'target_not_loaded',
        'window_merged',
        'accessibility_unavailable'
    )
    $lastResult = $null
    for ($fallbackAttempt = 1; $fallbackAttempt -le 2; $fallbackAttempt++) {
        try {
            $powershellExecutable = (Get-Process -Id $PID).Path
            $fallbackArguments = @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                (Join-Path $PSScriptRoot 'Invoke-MainChromeCheckinAccessibility.ps1'),
                '-Origin', $Origin, '-Url', $Url, '-TimeoutSeconds', [string]$TimeoutSeconds
            )
            $fallbackText = & $powershellExecutable @fallbackArguments 2>$null
            if ($fallbackText) { $lastResult = ($fallbackText | ConvertFrom-Json) }
        }
        catch {
            $lastResult = [pscustomobject]@{
                status = 'unconfirmed'
                failureCode = 'accessibility_unavailable'
                reason = '主 Chrome 回退子进程未能返回可解析结果'
            }
        }
        if ($null -ne $lastResult -and (
            [string]$lastResult.status -in @('signed', 'already_signed', 'login_required', 'needs_attention', 'managed_challenge') -or
            [string]$lastResult.failureCode -notin $transientWindowFailures
        )) {
            return $lastResult
        }
        if ($fallbackAttempt -lt 2) { Start-Sleep -Seconds 1 }
    }
    return $lastResult
}

function Close-AutomationChrome {
    $targets = @(Get-AutomationChromeProcesses)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }

    $closeDeadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AutomationChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $closeDeadline)
    if ($remaining.Count -gt 0) {
        $remainingIds = @($remaining.ProcessId)
        $remainingRoots = @($remaining | Where-Object { $remainingIds -notcontains $_.ParentProcessId })
        foreach ($processInfo in $remainingRoots) {
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
        $remaining = @(Get-AutomationChromeProcesses)
    }
    if ($remaining.Count -gt 0) { throw '机器人专用原生 Chrome 未能退出。' }
}

function Clear-StaleAutomationChrome {
    $targets = @(Get-AutomationChromeProcesses)
    if ($targets.Count -eq 0) { return $true }

    # A native WAF helper is bounded to at most two minutes plus startup and
    # shutdown time. A profile process older than five minutes can only be a
    # leftover from an interrupted helper. This remains strictly scoped to the
    # already validated project data profile and never matches the user's main
    # Chrome profile.
    $staleBefore = (Get-Date).AddMinutes(-5)
    $recent = @($targets | Where-Object {
        try { [datetime]$_.CreationDate -gt $staleBefore } catch { $true }
    })
    if ($recent.Count -gt 0) { return $false }
    Close-AutomationChrome
    return @(Get-AutomationChromeProcesses).Count -eq 0
}

foreach ($configuredProfile in @($items.profilePath | Select-Object -Unique)) {
    $profilePath = [string]$configuredProfile
    if ((Get-AutomationChromeProcesses).Count -gt 0 -and -not (Clear-StaleAutomationChrome)) {
        throw "机器人专用 Chrome 配置正被占用，无法执行原生 WAF 预热：$profilePath"
    }
}
$profilePath = $defaultProfilePath

# Chrome 会节流离屏的非活动标签页，因此逐站打开并正常关闭，确保每个
# 雷池通行 Cookie 都在独立配置中完成落盘。
foreach ($item in $items) {
    $profilePath = [string]$item.profilePath
    $url = [string]$item.url
    $origin = if ($item.sourceOrigin) { [string]$item.sourceOrigin } else { ([uri]$url).GetLeftPart([System.UriPartial]::Authority) }
    $hostName = ([uri]$url).Host

    if ([string]$item.action -eq 'checkin') {
        $checkinInspection = $null
        try {
            $powershellExecutable = (Get-Process -Id $PID).Path
            $checkinArguments = @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                (Join-Path $PSScriptRoot 'Invoke-PlainWafAccessibility.ps1'),
                '-Origin', $origin, '-Url', $url, '-TimeoutSeconds', [string]([int]$item.waitSeconds),
                '-UserDataDirOverride', $profilePath, '-WindowMode', [string]$item.windowMode,
                '-PerformCheckin'
            )
            if ($autoClickTurnstile.ContainsKey($origin)) { $checkinArguments += '-AllowCloudflareChallengeClick' }
            $checkinText = & $powershellExecutable @checkinArguments 2>$null
            if ($checkinText) { $checkinInspection = $checkinText | ConvertFrom-Json }
        } catch { $checkinInspection = $null }
        finally { if ((Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome } }
        $confirmed = $null -ne $checkinInspection -and [string]$checkinInspection.status -in @('signed', 'already_signed')
        $twoFactorRequired = Test-TwoFactorResult $checkinInspection
        $submissionAttempted = $null -ne $checkinInspection -and (
            [bool]$checkinInspection.submissionAttempted -or [bool]$checkinInspection.checkinClicked
        )
        $preflightResults += [pscustomobject]@{
            origin = $origin
            url = $url
            status = if ($confirmed) { [string]$checkinInspection.status } elseif ($twoFactorRequired -or $submissionAttempted) { 'needs_attention' } else { 'unconfirmed' }
            reason = if ($confirmed) { [string]$checkinInspection.reason } elseif ($checkinInspection) { [string]$checkinInspection.reason } else { '无调试原生 Chrome 未取得签到终态' }
            inspectionStatus = if ($checkinInspection) { [string]$checkinInspection.status } else { 'unavailable' }
            failureCode = if ($twoFactorRequired) { 'two_factor_required' } elseif ($submissionAttempted) { 'submission_outcome_unknown' } elseif ($checkinInspection) { [string]$checkinInspection.failureCode } else { 'accessibility_unavailable' }
            submissionAttempted = $submissionAttempted
            retryable = if ($submissionAttempted) { $false } else { $null }
            attentionKind = if ($twoFactorRequired) { 'trusted_device_initialization' } else { $null }
            retryableLoginRecovery = if ($twoFactorRequired) { $false } else { $null }
            checkinClickAttempted = if ($checkinInspection) { [bool]$checkinInspection.checkinClickAttempted } else { $false }
            checkinClicked = if ($checkinInspection) { [bool]$checkinInspection.checkinClicked } else { $false }
        }
        continue
    }

    $mainInspection = $null
    if (-not [bool]$item.passiveOnly -and $mainFallbackByOrigin.ContainsKey($origin)) {
        $fallbackEntry = $mainFallbackByOrigin[$origin]
        $mainInspection = Invoke-MainChromeFallbackResult $origin ([string]$fallbackEntry.url) ([int]$fallbackEntry.waitSeconds)
        $mainConfirmed = $null -ne $mainInspection -and [string]$mainInspection.status -in @('signed', 'already_signed')
        $mainTwoFactorRequired = Test-TwoFactorResult $mainInspection
        $mainSubmissionAttempted = $null -ne $mainInspection -and [bool]$mainInspection.submissionAttempted
        if ($mainConfirmed -or $mainTwoFactorRequired -or $mainSubmissionAttempted -or [bool]$item.mainChromeFallbackOnly) {
            $preflightResults += [pscustomobject]@{
                origin = $origin
                url = [string]$fallbackEntry.url
                status = if ($mainConfirmed) { 'signed' } elseif ($mainTwoFactorRequired -or $mainSubmissionAttempted) { 'needs_attention' } elseif ([string]$mainInspection.status -eq 'managed_challenge') { 'managed_challenge' } else { 'unconfirmed' }
                reason = if ($mainInspection) { [string]$mainInspection.reason } else { '主 Chrome 回退未取得明确签到终态' }
                inspectionStatus = if ($mainInspection) { [string]$mainInspection.status } else { 'unavailable' }
                failureCode = if ($mainInspection) { [string]$mainInspection.failureCode } else { 'accessibility_unavailable' }
                submissionAttempted = $mainSubmissionAttempted
                retryable = if ($mainSubmissionAttempted) { $false } else { $null }
                attentionKind = if ($mainTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
                retryableLoginRecovery = if ($mainTwoFactorRequired) { $false } else { $null }
            }
            continue
        }
    }

    if ([bool]$item.passiveOnly) {
        $passivePrepared = $false
        $passiveInspection = $null
        try {
            # WAF services may reject any Chrome instance launched with a
            # remote-debugging port. Passive preparation therefore uses only
            # the native accessibility tree and persists the resulting cookie
            # before the automation browser is allowed to inspect the site.
            $powershellExecutable = (Get-Process -Id $PID).Path
            for ($plainAttempt = 1; $plainAttempt -le 2 -and -not $passivePrepared; $plainAttempt++) {
                $plainArguments = @(
                    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                    (Join-Path $PSScriptRoot 'Invoke-PlainWafAccessibility.ps1'),
                    '-Origin', $origin, '-Url', $url, '-TimeoutSeconds', [string]([int]$item.waitSeconds),
                    '-UserDataDirOverride', $profilePath, '-WindowMode', [string]$item.windowMode
                )
                if (-not [bool]$item.trustAsSigned) { $plainArguments += '-AllowPreparedSiteBody' }
                if ($autoClickTurnstile.ContainsKey($origin)) { $plainArguments += '-AllowCloudflareChallengeClick' }
                $inspectionText = & $powershellExecutable @plainArguments 2>$null
                if ($inspectionText) {
                    $inspection = $inspectionText | ConvertFrom-Json
                    $passiveInspection = $inspection
                    $passivePrepared = [string]$inspection.status -in @('signed', 'already_signed') `
                        -or ([string]$inspection.status -eq 'ready' `
                            -and [bool]$inspection.inspection.siteBodyLoaded `
                            -and (-not [bool]$item.trustAsSigned -or [bool]$inspection.inspection.attendanceEndpoint))
                    if ([string]$inspection.status -eq 'login_required' -or (Test-TwoFactorResult $inspection)) { break }
                }
                if (-not $passivePrepared -and $plainAttempt -lt 2) { Start-Sleep -Seconds 2 }
            }
        }
        catch {
            $passivePrepared = $false
        }
        finally {
            if ((Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome }
        }

        # Windows UI Automation is unavailable while the interactive desktop
        # is locked. The no-debug launch above still lets Chrome establish the
        # WAF/session state. Reopen the same isolated profile once with a debug
        # port only for authoritative readback; never use this path to click.
        if (-not $passivePrepared -and (
            $null -eq $passiveInspection -or
            [string]$passiveInspection.failureCode -eq 'accessibility_unavailable'
        )) {
            $readbackStarted = $false
            try {
                [void](Reset-NativeChromeDebugPort $profilePath)
                $readbackPort = Get-NativeChromeDebugPort
                & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
                    -RemoteDebuggingPort $readbackPort `
                    -Urls @($url) `
                    -Offscreen `
                    -UserDataDirOverride $profilePath | Out-Null
                $readbackStarted = $true
                $readbackPort = Wait-NativeChromeDebugPort $profilePath $readbackPort 25
                $readbackText = & $node $inspector $readbackPort $origin ([int]$item.waitSeconds) 'require-confirmed' 0 2>$null
                if ($LASTEXITCODE -eq 0 -and $readbackText) {
                    $readback = $readbackText | ConvertFrom-Json
                    if ([string]$readback.status -in @('signed', 'already_signed')) {
                        $passiveInspection = $readback
                        $passivePrepared = $true
                    }
                }
            }
            catch { }
            finally {
                if ($readbackStarted -and (Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome }
            }
        }

        # Keep the user's normal Chrome as the last resort. A healthy isolated
        # profile should finish without creating or moving any main-profile
        # window.
        if (-not $passivePrepared -and $mainFallbackByOrigin.ContainsKey($origin)) {
            $fallbackEntry = $mainFallbackByOrigin[$origin]
            $mainInspection = Invoke-MainChromeFallbackResult $origin ([string]$fallbackEntry.url) ([int]$fallbackEntry.waitSeconds)
            $mainConfirmed = $null -ne $mainInspection -and [string]$mainInspection.status -in @('signed', 'already_signed')
            $mainTwoFactorRequired = Test-TwoFactorResult $mainInspection
            $mainSubmissionAttempted = $null -ne $mainInspection -and [bool]$mainInspection.submissionAttempted
            if ($mainConfirmed -or $mainTwoFactorRequired -or $mainSubmissionAttempted -or [bool]$item.mainChromeFallbackOnly) {
                $preflightResults += [pscustomobject]@{
                    origin = $origin
                    url = [string]$fallbackEntry.url
                    status = if ($mainConfirmed) { [string]$mainInspection.status } elseif ($mainTwoFactorRequired -or $mainSubmissionAttempted) { 'needs_attention' } elseif ([string]$mainInspection.status -eq 'managed_challenge') { 'managed_challenge' } else { 'unconfirmed' }
                    reason = if ($mainInspection) { [string]$mainInspection.reason } else { '主 Chrome 回退未取得明确签到终态' }
                    inspectionStatus = if ($mainInspection) { [string]$mainInspection.status } else { 'unavailable' }
                    failureCode = if ($mainInspection) { [string]$mainInspection.failureCode } else { 'accessibility_unavailable' }
                    submissionAttempted = $mainSubmissionAttempted
                    retryable = if ($mainSubmissionAttempted) { $false } else { $null }
                    attentionKind = if ($mainTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
                    retryableLoginRecovery = if ($mainTwoFactorRequired) { $false } else { $null }
                }
                continue
            }
        }

        if (-not $passivePrepared) {
            Write-Warning "被动原生预热未完成：$hostName"
        }
        $explicitlyConfirmed = $null -ne $passiveInspection `
            -and [string]$passiveInspection.status -in @('signed', 'already_signed')
        $preparedOnly = $passivePrepared -and -not $explicitlyConfirmed -and -not [bool]$item.trustAsSigned
        $passiveTwoFactorRequired = Test-TwoFactorResult $passiveInspection
        $preflightResults += [pscustomobject]@{
            origin = $origin
            url = $url
            status = if ($explicitlyConfirmed -or ($passivePrepared -and [bool]$item.trustAsSigned)) {
                'signed'
            } elseif ($preparedOnly) {
                'prepared'
            } elseif ($passiveTwoFactorRequired) {
                'needs_attention'
            } elseif ([string]$passiveInspection.status -eq 'managed_challenge') {
                'managed_challenge'
            } else {
                'unconfirmed'
            }
            reason = if ($explicitlyConfirmed -or ($passivePrepared -and [bool]$item.trustAsSigned)) {
                '无调试原生 Chrome 页面确认签到完成'
            } elseif ($preparedOnly) {
                '无调试原生 Chrome 已完成验证预热，等待自动化复查'
            } elseif ([bool]$passiveInspection.inspection.securityVerification) {
                '站点要求完成异地登录 2FA 验证'
            } elseif ([string]$passiveInspection.status -eq 'login_required') {
                '无调试原生 Chrome 需要重新登录'
            } else {
                if ($passiveInspection.reason) { [string]$passiveInspection.reason } else { '原生 Chrome 未取得明确签到终态' }
            }
            inspectionStatus = if ($passiveInspection) { [string]$passiveInspection.status } else { 'unconfirmed' }
            failureCode = if ($passiveTwoFactorRequired) { 'two_factor_required' } elseif ($passiveInspection) { [string]$passiveInspection.failureCode } else { 'accessibility_unavailable' }
            attentionKind = if ($passiveTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
            retryableLoginRecovery = if ($passiveTwoFactorRequired) { $false } else { $null }
        }
        continue
    }

    $inspection = $null
    $inspectionMode = if ([string]$item.action -eq 'checkin') { 'native-checkin' } elseif ([bool]$item.trustAsSigned) { 'allow-endpoint' } else { 'require-confirmed' }
    $maximumInspectionAttempts = if ([string]$item.action -eq 'checkin') { 1 } else { 2 }
    for ($inspectionAttempt = 1; $inspectionAttempt -le $maximumInspectionAttempts -and $null -eq $inspection; $inspectionAttempt++) {
        [void](Reset-NativeChromeDebugPort $profilePath)
        $debugPort = Get-NativeChromeDebugPort
        $openParameters = @{
            RemoteDebuggingPort = $debugPort
            Urls = @($url)
            Offscreen = $true
            UserDataDirOverride = $profilePath
        }
        # Native preflight is unattended. Keep every real Chrome window
        # offscreen, including action=checkin flows, so retries never interrupt
        # the user's desktop.
        $nativeChromeStarted = $false
        try {
            & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openParameters
            $nativeChromeStarted = $true
            $debugPort = Wait-NativeChromeDebugPort $profilePath $debugPort 25
            $inspectionText = & $node $inspector $debugPort $origin ([int]$item.waitSeconds) $inspectionMode ([int]$item.reloadOnChallengeAfterSeconds) 2>$null
            if ($LASTEXITCODE -eq 0 -and $inspectionText) {
                $inspection = $inspectionText | ConvertFrom-Json
                $attemptExplicit = [string]$inspection.status -in @('signed', 'already_signed') `
                    -or (Test-ConfirmedNotAvailableResult $inspection)
                $attemptEndpoint = [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [bool]$inspection.attendanceEndpoint -and [string]$inspection.status -eq 'ready'
                $attemptPrepared = [string]$item.action -ne 'checkin' -and -not [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [string]$inspection.status -notin @('login_required', 'needs_attention', 'interactive_challenge', 'managed_challenge')
                $attemptAttention = Test-TwoFactorResult $inspection
                $attemptSubmitted = [bool]$inspection.submissionAttempted -or [bool]$inspection.checkinClicked
                if (-not $attemptExplicit -and -not $attemptEndpoint -and -not $attemptPrepared -and -not $attemptAttention -and -not $attemptSubmitted) { $inspection = $null }
            }
        }
        catch { $inspection = $null }
        finally {
            if ($nativeChromeStarted) { Close-AutomationChrome }
        }
        if ($null -eq $inspection -and $inspectionAttempt -lt $maximumInspectionAttempts) { Start-Sleep -Seconds 1 }
    }
    $explicitlyConfirmed = $null -ne $inspection -and (
        [string]$inspection.status -in @('signed', 'already_signed') -or
        (Test-ConfirmedNotAvailableResult $inspection)
    )
    $endpointConfirmed = [bool]$item.trustAsSigned -and $null -ne $inspection `
        -and [bool]$inspection.siteBodyLoaded -and [bool]$inspection.attendanceEndpoint `
        -and [string]$inspection.status -eq 'ready'
    $prepared = [string]$item.action -ne 'checkin' -and $null -ne $inspection -and [bool]$inspection.siteBodyLoaded `
        -and [string]$inspection.status -notin @('login_required', 'needs_attention', 'interactive_challenge', 'managed_challenge')
    $twoFactorRequired = Test-TwoFactorResult $inspection
    $submissionAttempted = $null -ne $inspection -and (
        [bool]$inspection.submissionAttempted -or [bool]$inspection.checkinClicked
    )
    if (-not $explicitlyConfirmed -and -not $endpointConfirmed -and -not $prepared) {
        Write-Warning "原生验证未能确认站点正文：$hostName"
    }
    $preflightResults += [pscustomobject]@{
        origin = $origin
        url = $url
        status = if ($explicitlyConfirmed) { [string]$inspection.status } elseif ($endpointConfirmed) { 'signed' } elseif ($prepared) { 'prepared' } elseif ($twoFactorRequired -or $submissionAttempted) { 'needs_attention' } else { 'unconfirmed' }
        reason = if ($explicitlyConfirmed) {
            if ([string]$inspection.status -eq 'not_available') { [string]$inspection.reason }
            else { '原生 Chrome 已通过 WAF，并由页面明确确认今天已签到' }
        } elseif ($endpointConfirmed) {
            '原生 Chrome 已通过 WAF，并确认签到端点完整加载'
        } elseif ($prepared) {
            '原生 Chrome 已完成验证预热，等待自动化复查'
        } elseif ($twoFactorRequired) {
            '站点要求完成异地登录 2FA 验证'
        } elseif ($submissionAttempted) {
            '原生 Chrome 已提交签到动作，但页面或接口未返回权威结果'
        } else {
            '原生验证页面未能确认签到结果'
        }
        inspectionStatus = if ($null -ne $inspection) { [string]$inspection.status } else { 'unavailable' }
        failureCode = if ($twoFactorRequired) { 'two_factor_required' } elseif ($submissionAttempted) { 'submission_outcome_unknown' } elseif ($inspection) { [string]$inspection.failureCode } else { 'accessibility_unavailable' }
        submissionAttempted = $submissionAttempted
        retryable = if ($submissionAttempted) { $false } else { $null }
        attentionKind = if ($twoFactorRequired) { 'trusted_device_initialization' } else { $null }
        retryableLoginRecovery = if ($twoFactorRequired) { $false } else { $null }
        availabilityKind = if ($explicitlyConfirmed) { [string]$inspection.availabilityKind } else { $null }
        evidence = if ($explicitlyConfirmed) { $inspection.evidence } else { $null }
    }
}

$preflightPath = Join-Path $root 'tmp\native-waf-preflight.json'
$preflightReport = [pscustomobject]@{
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    results = $preflightResults
}
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $preflightPath)) | Out-Null
[System.IO.File]::WriteAllText(
    $preflightPath,
    ($preflightReport | ConvertTo-Json -Depth 5),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Output "已完成 $($items.Count) 个原生验证会话预热。"
