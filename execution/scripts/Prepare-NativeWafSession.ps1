[CmdletBinding()]
param(
    [int]$LoadTimeoutSeconds = 20,
    [string[]]$Origins,
    [switch]$AllConfigured
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
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
function Resolve-NativeProfilePath([string]$ConfiguredPath, [string]$Origin = '') {
    if ($Origin -and $config.oauthExecutionAccountBindings) {
        $binding = $config.oauthExecutionAccountBindings.PSObject.Properties[$Origin]
        if ($binding) {
            . (Join-Path $PSScriptRoot 'OAuth-AccountConfig.ps1')
            $account = Resolve-OAuthAccountConfiguration $config $root ([string]$binding.Value)
            if ($ConfiguredPath -and (Resolve-NativeProfilePath $ConfiguredPath) -ne $account.AutomationUserDataDir) { throw 'Native preflight profile conflicts with execution account.' }
            return $account.AutomationUserDataDir
        }
    }
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
    if ([string]$Result.failureCode -ceq 'submission_outcome_unknown' -or $Result.submissionAttempted -eq $true -or
        $Result.clicked -eq $true -or $Result.checkinClicked -eq $true -or $Result.checkinClickAttempted -eq $true) { return $false }
    return $null -ne $Result -and (
        [string]$Result.failureCode -eq 'two_factor_required' -or
        ([string]$Result.status -eq 'needs_attention' -and [string]$Result.attentionKind -eq 'trusted_device_initialization')
    )
}
function Copy-NativeReceiptBindingFields($Result, $Source) {
    # Preserve only explicit child receipt metadata. In particular, never
    # invent a current Profile binding for a legacy/unbound success record.
    if ($null -ne $Source) {
        foreach ($field in @(
            @{ name = 'profileBinding'; pattern = '^[a-f0-9]{64}$' },
            @{ name = 'accountKey'; pattern = '^site-default$' },
            @{ name = 'operationMode'; pattern = '^safe_history_page$' },
            @{ name = 'readSafety'; pattern = '^reviewed_passive$' }
            @{ name = 'underlyingFailureCode'; pattern = '^two_factor_required$' }
        )) {
            $value = [string]$Source.($field.name)
            if ($value -cmatch $field.pattern) {
                $Result | Add-Member -NotePropertyName $field.name -NotePropertyValue $value -Force
            }
        }
        if ($Source.nativeSecurityDiagnostic -or $Source.inspection.nativeSecurityDiagnostic) {
            $facts = Get-NativeSecurityFacts $Source
            if ($facts) { $Result | Add-Member -NotePropertyName nativeSecurityDiagnostic -NotePropertyValue $facts -Force }
        }
        if ($Source.nativeTwoFactorRecovery -and $Source.nativeTwoFactorRecovery.attempted -is [bool] -and
            $Source.nativeTwoFactorRecovery.accepted -is [bool] -and [string]$Source.nativeTwoFactorRecovery.reason -cmatch '^[a-z_]{1,80}$') {
            $Result|Add-Member -NotePropertyName nativeTwoFactorRecovery -NotePropertyValue $Source.nativeTwoFactorRecovery -Force
        }
    }
    return $Result
}
$profilePath = $defaultProfilePath
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'Native-ChromeDebug.ps1')
. (Join-Path $PSScriptRoot 'Native-PtGuard.ps1')
$node = Resolve-CheckinNode $config
$inspector = Join-Path $root 'src\native-browser-inspect.mjs'
function Resolve-UnattendedNativeWindowMode([string]$RequestedMode) {
    if ($RequestedMode -and $RequestedMode -notin @('offscreen', 'minimized', 'visible')) {
        throw '原生预热窗口模式无效。'
    }
    # The daily runner's background preference applies to every native path,
    # including older per-site minimized/visible overrides. Manual login uses
    # its own explicit launcher and is not routed through this preflight.
    if (-not $config.backgroundWindowMode -or [string]$config.backgroundWindowMode -eq 'offscreen') {
        return 'offscreen'
    }
    if ($RequestedMode) { return $RequestedMode }
    return 'offscreen'
}
$items = @($config.nativeWafPreflightUrls | ForEach-Object {
    $rawUrl = if ($_ -is [string]) { [string]$_ } else { [string]$_.url }
    $uri = [uri]$rawUrl
    $waitSeconds = if ($_ -is [string] -or $null -eq $_.waitSeconds) { 30 } else { [int]$_.waitSeconds }
    $passiveOnly = $_ -isnot [string] -and [bool]$_.passiveOnly
    $trustAsSigned = if ($_ -isnot [string] -and $null -ne $_.trustAsSigned) { [bool]$_.trustAsSigned } else { $true }
    $windowMode = Resolve-UnattendedNativeWindowMode $(if ($_ -isnot [string]) { [string]$_.windowMode } else { '' })
    if ($windowMode -notin @('offscreen', 'minimized', 'visible')) { throw "原生 WAF 窗口模式无效：$rawUrl" }
    $itemProfilePath = Resolve-NativeProfilePath $(if ($_ -isnot [string]) { [string]$_.automationUserDataDir } else { '' }) ($uri.GetLeftPart([System.UriPartial]::Authority))
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
    $windowMode = Resolve-UnattendedNativeWindowMode ([string]$_.windowMode)
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
        profilePath = Resolve-NativeProfilePath ([string]$_.automationUserDataDir) ($uri.GetLeftPart([System.UriPartial]::Authority))
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
        $lastResult = $null
        try {
            $powershellExecutable = (Get-Process -Id $PID).Path
            $fallbackArguments = @(
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
                (Join-Path $PSScriptRoot 'Invoke-MainChromeCheckinAccessibility.ps1'),
                '-Origin', $Origin, '-Url', $Url, '-TimeoutSeconds', [string]$TimeoutSeconds
            )
            $fallbackText = & $powershellExecutable @fallbackArguments 2>$null
            if ($fallbackText) { $lastResult = ($fallbackText | ConvertFrom-Json) } else { throw 'Native helper returned no result' }
        }
        catch {
            $lastResult = [pscustomobject]@{
                status = 'needs_attention'
                failureCode = 'submission_outcome_unknown'
                submissionAttempted = $true
                retryable = $false
                reason = '主 Chrome 子进程结果不可确认，先只读核验，禁止自动重放'
            }
        }
        if ($null -eq $lastResult) {
            $lastResult = [pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';
                submissionAttempted=$true;retryable=$false;reason='主 Chrome 子进程无结果，先只读核验，禁止自动重放'}
        }
        if ($null -ne $lastResult -and (
            $lastResult.submissionAttempted -ne $false -or $lastResult.nativeGate -eq $true -or
            [string]$lastResult.status -in @('signed', 'already_signed', 'login_required', 'needs_attention', 'managed_challenge') -or
            [string]$lastResult.failureCode -notin $transientWindowFailures
        )) {
            return $lastResult
        }
        if ($fallbackAttempt -lt 2) { Start-Sleep -Seconds 1 }
    }
    return $lastResult
}

function Invoke-MainChromeReadOnlyFallbackResult([string]$Origin, [int]$TimeoutSeconds, [bool]$UseMain = $true) {
    if ($UseMain -and -not $mainFallbackByOrigin.ContainsKey($Origin)) { return $null }
    try {
        $fallback = $mainFallbackByOrigin[$Origin]
        $readOnlyUrl = ([uri]$Origin).GetLeftPart([System.UriPartial]::Authority) + '/index.php'
        # Use the same bounded UTF-8 transport as the evidence worker. Its
        # ASCII JSON envelope is safe even in Windows PowerShell 5.1. The
        # shared read budget is independent of a formal attendance timeout.
        $node = Resolve-CheckinNode $config
        $arguments = @((Join-Path $PSScriptRoot 'Read-NativePtHeader.mjs'),
            '--origin', $Origin, '--url', $readOnlyUrl, '--isolated', ([string](-not $UseMain)).ToLowerInvariant())
        $text = & $node @arguments 2>$null
        if (-not $text) { throw 'Read entrypoint returned no envelope' }
        $value = $text | ConvertFrom-Json
        if ($null -eq $value -or $null -eq $value.nativeReadback) { throw 'Read entrypoint returned no diagnostic' }
        $value | Add-Member -NotePropertyName origin -NotePropertyValue $Origin -Force
        $value | Add-Member -NotePropertyName url -NotePropertyValue $readOnlyUrl -Force
        $value | Add-Member -NotePropertyName nativeGate -NotePropertyValue $true -Force
        return $value
    } catch {
        return [pscustomobject]@{status='unconfirmed';submissionAttempted=$false;
            failureCode='native_readback_unavailable';
            reason='主 Chrome 只读入口未能返回结构化回执，已保留诊断';
            nativeReadback=[pscustomobject]@{stage='transport';code='entrypoint_unavailable';
                exitCode=$null;durationMs=0;stderrPresent=$false;stderrBytes=0}}
    }
}

function Convert-NativeChildReceipt([object[]]$Output) {
    # Native stdout is a line array in Windows PowerShell. Parse the entire
    # envelope once; never rescue a trailing JSON object from mixed output.
    $text = ($Output -join [Environment]::NewLine).Trim().TrimStart([char]0xFEFF)
    $code = if (-not $text) { 'receipt_missing' } elseif (-not $text.StartsWith('{') -or -not $text.EndsWith('}')) { 'invalid_receipt' } else { '' }
    if (-not $code) {
        try { $value = ConvertFrom-Json -InputObject $text -ErrorAction Stop } catch { $code = 'invalid_json' }
        if (-not $code -and ($value -isnot [pscustomobject] -or $value.status -isnot [string] -or [string]::IsNullOrWhiteSpace($value.status))) {
            $code = 'invalid_receipt'
        }
    }
    if ($code) {
        $failure = [IO.InvalidDataException]::new('Native child returned no valid result envelope')
        $failure.Data['NativeChildReceiptCode'] = $code
        throw $failure
    }
    return $value
}

function Write-NativeChildTransportDiagnostic([string]$Origin, $Diagnostic) {
    # The preflight report is consumed and removed by the engine. Keep only
    # bounded metadata for recurrence analysis, never stderr or page text.
    try {
        $directory = Join-Path $root 'logs'
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $record = [pscustomobject]@{origin=$Origin;observedAt=[datetimeoffset]::UtcNow.ToString('o');
            stage=$Diagnostic.stage;code=$Diagnostic.code;exceptionType=$Diagnostic.exceptionType;
            exitCode=$Diagnostic.exitCode;stdoutCharacters=$Diagnostic.stdoutCharacters;stdoutLines=$Diagnostic.stdoutLines;
            stdoutCaptureComplete=$Diagnostic.stdoutCaptureComplete}
        [IO.File]::AppendAllText((Join-Path $directory 'native-child-transport.jsonl'),
            ((ConvertTo-Json -InputObject $record -Depth 4 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    } catch { }
}

function New-NativeChildTransportFailure([string]$Origin, [string]$Stage, $ErrorRecord, [object[]]$Output, $ExitCode) {
    $code = [string]$ErrorRecord.Exception.Data['NativeChildReceiptCode']
    if ($code -cnotin @('receipt_missing','invalid_receipt','invalid_json')) { $code = 'child_command_failed' }
    $type = if ($ErrorRecord) { [string]$ErrorRecord.Exception.GetType().FullName } else { '' }
    if ($type -cnotmatch '^(?:System|Microsoft\.PowerShell|Newtonsoft\.Json)\.[A-Za-z0-9._+]{1,120}$') { $type = 'OtherException' }
    $diagnostic = [pscustomobject]@{stage=$Stage;code=$code;exceptionType=$type;
        exitCode=if($ExitCode -is [int]){$ExitCode}else{$null};
        stdoutCharacters=[Math]::Min(200000, ($Output -join [Environment]::NewLine).Length);
        stdoutLines=[Math]::Min(10000, @($Output | Where-Object { $null -ne $_ }).Count);
        stdoutCaptureComplete=($Stage -ceq 'decode')}
    Write-NativeChildTransportDiagnostic $Origin $diagnostic
    # Do not invent the lost child's identity or success. This parent-only
    # marker authorizes passive inspection from its original validated guard.
    return [pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;retryable=$false;
        reason=if($code -ceq 'receipt_missing'){'原生执行器无结果，先只读核验'}else{'原生执行器结果不可解析，先只读核验'};
        nativeChildResultUnavailable=$true;diagnosticStage=('native_child_'+$Stage);nativeChildDiagnostic=$diagnostic}
}

function Test-NativePostActionReceipt {
    param($Result, [string]$Origin, [string]$AccountKey, [string]$ProfileBinding,
        [datetimeoffset]$Now, [switch]$ReceiptContext, [switch]$GateConfirmation)
    if ($null -eq $Result -or [string]$Result.status -notin @('signed','already_signed') -or
        (-not $GateConfirmation -and ([string]$Result.origin -cne $Origin -or [string]$Result.url -cne ($Origin + '/index.php'))) -or
        ($GateConfirmation -and $Result.origin -and [string]$Result.origin -cne $Origin) -or
        [string]$Result.accountKey -cne $AccountKey -or [string]$Result.profileBinding -cne $ProfileBinding -or
        $Result.submissionAttempted -isnot [bool] -or $Result.submissionAttempted -ne $false -or
        $Result.clicked -or $Result.checkinClicked -or $Result.checkinClickAttempted -or
        $Result.evidence.authoritative -isnot [bool] -or $Result.evidence.authoritative -ne $true -or
        ($GateConfirmation -and [string]$Result.evidence.source -notin @('page_text','pt_page','api','usage_log')) -or
        (-not $GateConfirmation -and ([string]$Result.evidence.source -cne 'page_text' -or [string]$Result.evidence.pagePath -cne '/index.php' -or
            [string]$Result.evidence.statusSignal -cne 'nexus_daily_header_signed')) -or $Result.failureCode) { return $false }
    $at = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse((Convert-NativeReceiptTimestamp $Result.evidence.confirmedAt), [ref]$at) -or
        $at -gt $Now -or ($Now - $at).TotalSeconds -gt 300) { return $false }
    $day = $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
    if ($at.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -cne $day -or
        [string]$Result.evidence.businessDate -cne $day) { return $false }
    if ($ReceiptContext) {
        $observed = [datetimeoffset]::MinValue
        if ([string]$Result.operationMode -cne 'safe_history_page' -or [string]$Result.readSafety -cne 'reviewed_passive' -or
            [string]$Result.businessDate -cne $day -or [string]$Result.evidence.evidenceScope -cne 'site_account_day' -or
            -not [datetimeoffset]::TryParse((Convert-NativeReceiptTimestamp $Result.observedAt), [ref]$observed) -or
            $observed -gt $Now -or ($Now - $observed).TotalSeconds -gt 300 -or
            $observed.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -cne $day -or
            [Math]::Abs(($observed - $at).TotalSeconds) -gt 60) { return $false }
    }
    return $true
}

function Get-NativeSecurityFacts($Result) {
    $raw = if ($Result.nativeSecurityDiagnostic) { $Result.nativeSecurityDiagnostic } else { $Result.inspection.nativeSecurityDiagnostic }
    if ($null -eq $raw) { return $null }
    $facts = [pscustomobject]@{}
    foreach ($name in @('verificationRoute','otpInputPresent','scopedOtpInputPresent','passwordInputPresent','sameOrigin','pageContentAvailable','waf')) {
        if ($raw.$name -isnot [bool]) { return $null }
        $facts | Add-Member -NotePropertyName $name -NotePropertyValue $raw.$name
    }
    $rules = @($raw.matchedRules | Where-Object { $_ -is [string] -and $_ -cin @('remote_login_text','secondary_recovery_link',
        'secondary_code_text','explicit_secondary_prompt','verification_route','scoped_secondary_input') } | Select-Object -Unique)
    $facts | Add-Member -NotePropertyName matchedRules -NotePropertyValue $rules
    return $facts
}

function Write-NativeSecurityDiagnostic([string]$Origin, $Result) {
    $facts = Get-NativeSecurityFacts $Result
    if ($null -eq $facts) { return }
    try {
        $directory = Join-Path $root 'logs'
        [IO.Directory]::CreateDirectory($directory) | Out-Null
        $record = [pscustomobject]@{origin=$Origin;observedAt=[datetimeoffset]::UtcNow.ToString('o');
            submissionAttempted=($Result.submissionAttempted -is [bool] -and $Result.submissionAttempted -eq $true);
            twoFactorUnderlying=([string]$Result.underlyingFailureCode -ceq 'two_factor_required' -or [string]$Result.failureCode -ceq 'two_factor_required');
            diagnostic=$facts}
        [IO.File]::AppendAllText((Join-Path $directory 'native-security-observations.jsonl'),
            ((ConvertTo-Json -InputObject $record -Depth 5 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
    } catch { }
}

function Invoke-NativePostActionReadback {
    param($Child, [string]$Origin, [string]$Url, [string]$ProfilePath, [int]$TimeoutSeconds,
        [scriptblock]$Clock = { [datetimeoffset]::UtcNow })
    # This is one passive confirmation of the action that already happened,
    # never a fallback submission. Keep the original unknown on every failure.
    if ($null -eq $config.ptReadOnlyPolicies) { return $Child }
    $policy = $config.ptReadOnlyPolicies.PSObject.Properties[$Origin]
    $state = $script:NativePtGuard
    $boundChild = $null -ne $Child -and [string]$Child.profileBinding -ceq [string]$state.profileBinding -and
        [string]$Child.accountKey -ceq [string]$state.accountKey
    $lostTransportIdentity = $null -ne $Child -and $Child.nativeChildResultUnavailable -is [bool] -and $Child.nativeChildResultUnavailable -eq $true -and
        $null -eq $Child.PSObject.Properties['profileBinding'] -and $null -eq $Child.PSObject.Properties['accountKey'] -and
        [string]$Child.diagnosticStage -cin @('native_child_transport','native_child_decode') -and
        [string]$Child.nativeChildDiagnostic.stage -cin @('transport','decode') -and
        [string]$Child.nativeChildDiagnostic.code -cin @('child_command_failed','receipt_missing','invalid_receipt','invalid_json')
    if ($null -eq $Child -or $null -eq $policy -or $policy.Value.reviewed -isnot [bool] -or $policy.Value.reviewed -ne $true -or
        $policy.Value.nativeApiHeaderFallback -isnot [bool] -or $policy.Value.nativeApiHeaderFallback -ne $true -or
        $Child.submissionAttempted -isnot [bool] -or $Child.submissionAttempted -ne $true -or
        $Child.postActionReadbackAttempted -or
        -not ([string]$Child.failureCode -ceq 'submission_outcome_unknown' -or
            ([string]$Child.status -ceq 'needs_attention' -and -not $Child.failureCode)) -or
        $state.managed -ne $true -or $state.mainProfile -ne $false -or
        [string]$state.origin -cne $Origin -or [string]$state.url -cne $Url -or
        [string]$state.profileBinding -cnotmatch '^[a-f0-9]{64}$' -or [string]$state.accountKey -cne 'site-default' -or
        (-not $boundChild -and -not $lostTransportIdentity) -or
        ($null -ne $Child.PSObject.Properties['origin'] -and [string]$Child.origin -cne $Origin)) { return $Child }
    try {
        if (-not [string]::Equals([IO.Path]::GetFullPath($ProfilePath), [IO.Path]::GetFullPath([string]$state.profile), [StringComparison]::OrdinalIgnoreCase)) { return $Child }
        $Child | Add-Member -NotePropertyName postActionReadbackAttempted -NotePropertyValue $true -Force
        $account = [string]$state.accountKey; $binding = [string]$state.profileBinding
        $readback = Invoke-MainChromeReadOnlyFallbackResult $Origin $TimeoutSeconds $false
        $now = [datetimeoffset](& $Clock)
        if (-not (Test-NativePostActionReceipt $readback $Origin $account $binding $now) -or
            -not (Test-NativePostActionReceipt $readback.readbackReceipt $Origin $account $binding $now -ReceiptContext)) { return $Child }
        $freshAt = [datetimeoffset](Convert-NativeReceiptTimestamp $readback.evidence.confirmedAt)
        $receiptAt = [datetimeoffset](Convert-NativeReceiptTimestamp $readback.readbackReceipt.evidence.confirmedAt)
        if ($freshAt -ne $receiptAt) { return $Child }
        $registered = Register-NativePtReadback $readback
        if ($registered.allow -isnot [bool] -or $registered.allow -ne $true -or
            $registered.receiptAccepted -isnot [bool] -or $registered.receiptAccepted -ne $true -or
            $registered.submissionAttempted -isnot [bool] -or $registered.submissionAttempted -ne $false -or
            [string]$registered.profileBinding -cne $binding -or [string]$registered.accountKey -cne $account) { return $Child }
        $confirmed = Initialize-NativePtGuard -Root $root -Origin $Origin -Url $Url -ProfilePath $ProfilePath
        $now = [datetimeoffset](& $Clock)
        if ([string]$confirmed.status -cne 'already_signed' -or
            -not (Test-NativePostActionReceipt $confirmed $Origin $account $binding $now -GateConfirmation)) { return $Child }
        # An older fresh journal confirmation may take precedence in inspect.
        # Publish the current receipt that registration has just persisted.
        $currentEvidence = $readback.readbackReceipt.evidence
        return [pscustomobject]@{origin=$Origin;url=$Url;status='already_signed';nativeGate=$true;
            accountKey=$account;profileBinding=$binding;submissionAttempted=$true;retryable=$false;
            operationMode='legacy_checkin';readSafety='attendance_page_risk';attendanceRisk=$true;confirmationState='confirmed';
            postActionReadbackAttempted=$true;postActionReadbackConfirmed=$true;
            checkinClickAttempted=[bool]$Child.checkinClickAttempted;checkinClicked=[bool]$Child.checkinClicked;
            reason='原生签到动作已提交，同账号只读回执已确认今日完成并持久化';
            evidence=[pscustomobject]@{source=[string]$currentEvidence.source;authoritative=$true;
                confirmedAt=(Convert-NativeReceiptTimestamp $currentEvidence.confirmedAt);businessDate=[string]$currentEvidence.businessDate;
                pagePath=[string]$currentEvidence.pagePath;statusSignal=[string]$currentEvidence.statusSignal;evidenceScope='site_account_day'};
            nativeReadback=$readback.nativeReadback;
            underlyingFailureCode=$Child.underlyingFailureCode;nativeSecurityDiagnostic=(Get-NativeSecurityFacts $Child);
            nativeChildResultUnavailable=($Child.nativeChildResultUnavailable -is [bool] -and $Child.nativeChildResultUnavailable -eq $true);
            nativeChildDiagnostic=$Child.nativeChildDiagnostic}
    } catch { return $Child }
}

function Test-NativeTwoFactorRecoveryOptIn([string]$Origin) {
    $entry=if($config.nativePtTwoFactorRecovery){$config.nativePtTwoFactorRecovery.PSObject.Properties[$Origin]}else{$null}
    return $Origin -ceq 'https://piggo.me' -and $null -ne $entry -and
        $entry.Value.enabled -is [bool] -and $entry.Value.enabled -eq $true -and
        $entry.Value.reviewed -is [bool] -and $entry.Value.reviewed -eq $true -and $entry.Value.provider -ceq 'bitwarden'
}

function Invoke-NativeTwoFactorReadOnlyReopen([string]$Origin,[string]$ProfilePath) {
    $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
        (Join-Path $PSScriptRoot 'Invoke-PlainWafAccessibility.ps1'),'-Origin',$Origin,'-Url',($Origin+'/index.php'),
        '-UserDataDirOverride',$ProfilePath,'-WindowMode','offscreen','-TimeoutSeconds','25','-ReadOnly')
    return Convert-NativeChildReceipt @(& ([string]$config.powershellExecutable) @arguments 2>$null)
}

function Invoke-NativeTwoFactorRecovery {
    param($Child,[string]$Origin,[string]$Url,[string]$ProfilePath,[int]$TimeoutSeconds)
    $output = [pscustomobject]@{handled=$false;resumeAllowed=$false;result=$Child}
    if (-not (Test-NativeTwoFactorRecoveryOptIn $Origin) -or $null -eq $Child) { return $output }
    $facts = Get-NativeSecurityFacts $Child
    $hash = [string]$Child.profileBinding
    if ($hash -cnotmatch '^[a-f0-9]{64}$' -or [string]$Child.accountKey -cne 'site-default' -or
        ([string]$Child.origin -and [string]$Child.origin -cne $Origin) -or
        ([string]$Child.failureCode -cne 'two_factor_required' -and [string]$Child.underlyingFailureCode -cne 'two_factor_required') -or
        $null -eq $facts -or $facts.otpInputPresent -ne $true -or $facts.scopedOtpInputPresent -ne $true -or $facts.passwordInputPresent -ne $false -or
        $facts.sameOrigin -ne $true -or $facts.pageContentAvailable -ne $true -or $facts.waf -ne $false) { return $output }
    foreach ($name in @('verificationRoute','otpInputPresent','scopedOtpInputPresent','passwordInputPresent','sameOrigin','pageContentAvailable','waf')) {
        if ($facts.($name) -isnot [bool]) { return $output }
    }
    if ($null -eq $script:nativeTwoFactorRecoveryInvoked) { $script:nativeTwoFactorRecoveryInvoked=@{} }
    if ($script:nativeTwoFactorRecoveryInvoked.ContainsKey($Origin)) { return $output }
    $script:nativeTwoFactorRecoveryInvoked[$Origin]=$true
    $output.handled=$true
    try {
        $diagnostic=[pscustomobject]@{origin=$Origin;accountKey='site-default';profileBinding=$hash;
            observedAt=[datetimeoffset]::UtcNow.ToString('o');failureCode=[string]$Child.failureCode;
            underlyingFailureCode=[string]$Child.underlyingFailureCode;nativeSecurityDiagnostic=$facts}
        $request=[pscustomobject]@{origin=$Origin;expectedProfileBinding=$hash;nativeDiagnostic=$diagnostic}
        $lines=@(($request|ConvertTo-Json -Depth 5 -Compress)| & $node (Join-Path $PSScriptRoot 'Recover-NativePtTwoFactor.mjs') '--root' $root 2>$null)
        $text=($lines -join [Environment]::NewLine).Trim().TrimStart([char]0xFEFF)
        if (-not $text.StartsWith('{') -or -not $text.EndsWith('}')) { return $output }
        $recovery=$text|ConvertFrom-Json -ErrorAction Stop
        $meta=$recovery.nativeTwoFactorRecovery
        if ($null -eq $meta -or $meta.attempted -isnot [bool] -or $meta.accepted -isnot [bool] -or
            [string]$meta.reason -cnotmatch '^[a-z_]{1,80}$') { return $output }
        $safeMeta=[pscustomobject]@{attempted=$meta.attempted;accepted=$meta.accepted;reason=[string]$meta.reason}
        $Child|Add-Member -NotePropertyName nativeTwoFactorRecovery -NotePropertyValue $safeMeta -Force
        $receipt=$recovery.readbackReceipt
        if ($null -eq $receipt -or $receipt.origin -cne $Origin -or $receipt.profileBinding -cne $hash -or
            $receipt.accountKey -cne 'site-default' -or $receipt.submissionAttempted -isnot [bool] -or $receipt.submissionAttempted -ne $false -or
            $receipt.evidence.authoritative -isnot [bool] -or $receipt.evidence.authoritative -ne $true -or
            $receipt.status -cnotin @('signed','already_signed','not_signed')) { return $output }
        if ($receipt.status -ceq 'not_signed') {
            if ($meta.accepted -ne $true) { return $output }
            $reopen=Invoke-NativeTwoFactorReadOnlyReopen $Origin $ProfilePath
            $inspection=$reopen.inspection
            $security=Get-NativeSecurityFacts $reopen
            if ($reopen.profileBinding -cne $hash -or $reopen.accountKey -cne 'site-default' -or
                $reopen.submissionAttempted -isnot [bool] -or $reopen.submissionAttempted -ne $false -or
                $inspection.securityVerification -isnot [bool] -or $inspection.securityVerification -ne $false -or
                $inspection.sameOrigin -isnot [bool] -or $inspection.sameOrigin -ne $true -or
                $inspection.siteBodyLoaded -isnot [bool] -or $inspection.siteBodyLoaded -ne $true -or
                $inspection.waf -isnot [bool] -or $inspection.waf -ne $false -or
                $inspection.loginRoute -isnot [bool] -or $inspection.loginRoute -ne $false -or
                $security.otpInputPresent -isnot [bool] -or $security.otpInputPresent -ne $false -or
                $security.scopedOtpInputPresent -isnot [bool] -or $security.scopedOtpInputPresent -ne $false -or
                $security.passwordInputPresent -isnot [bool] -or $security.passwordInputPresent -ne $false) { return $output }
            # The site's account menu can be hidden from UIA. This reopening
            # proves the secondary challenge is gone; the separate API receipt
            # and normal guard still supply the account/day submission proof.
        }
        $registered=Register-NativePtReadback $receipt
        if ($registered.allow -isnot [bool] -or $registered.allow -ne $true -or
            $registered.receiptAccepted -isnot [bool] -or $registered.receiptAccepted -ne $true -or
            $registered.profileBinding -cne $hash -or $registered.accountKey -cne 'site-default' -or
            $registered.submissionAttempted -isnot [bool] -or $registered.submissionAttempted -ne $false) { return $output }
        $decision=Initialize-NativePtGuard -Root $root -Origin $Origin -Url $Url -ProfilePath $ProfilePath
        if ($null -eq $decision -and $receipt.status -ceq 'not_signed' -and $meta.accepted -eq $true) {
            $output.resumeAllowed=$true
        } elseif ($null -ne $decision -and $decision.status -cin @('signed','already_signed') -and $decision.evidence.authoritative -eq $true) {
            $decision|Add-Member -NotePropertyName nativeTwoFactorRecovery -NotePropertyValue $safeMeta -Force
            $decision|Add-Member -NotePropertyName origin -NotePropertyValue $Origin -Force
            $decision|Add-Member -NotePropertyName nativeGate -NotePropertyValue $true -Force
            if ($Child.submissionAttempted -eq $true -or $Child.clicked -eq $true -or $Child.checkinClicked -eq $true -or $Child.checkinClickAttempted -eq $true) {
                $decision|Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $true -Force
            }
            $output.result=$decision
        }
    } catch { }
    return $output
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

$eligibleItems = @()
foreach ($candidate in $items) {
    $candidateOrigin = if ($candidate.sourceOrigin) { [string]$candidate.sourceOrigin } else { ([uri][string]$candidate.url).GetLeftPart([UriPartial]::Authority) }
    $useMain = [string]$candidate.action -ne 'checkin' -and $mainFallbackByOrigin.ContainsKey($candidateOrigin) -and
        (-not [bool]$candidate.passiveOnly -or [bool]$candidate.mainChromeFallbackOnly)
    $candidate | Add-Member -NotePropertyName nativeMainDirect -NotePropertyValue $useMain -Force
    $candidateUrl = if ($useMain) { [string]$mainFallbackByOrigin[$candidateOrigin].url } else { [string]$candidate.url }
    $candidateProfile = if ($useMain) { Split-Path -Parent ([string]$config.bookmarksPath) } else { [string]$candidate.profilePath }
    $decision = Initialize-NativePtGuard -Root $root -Origin $candidateOrigin -Url $candidateUrl -ProfilePath $candidateProfile -MainProfile:$useMain
    if ($null -ne $decision) {
        if ([string]$decision.failureCode -eq 'submission_outcome_unknown') {
            $readback = Invoke-MainChromeReadOnlyFallbackResult $candidateOrigin ([int]$candidate.waitSeconds) $useMain
            if ($null -ne $readback -and [string]$readback.status -in @('signed','already_signed','not_signed') -and
                $readback.submissionAttempted -eq $false -and $readback.evidence.authoritative -eq $true -and
                [string]$readback.accountKey -eq 'site-default' -and [string]$readback.profileBinding -match '^[a-f0-9]{64}$' -and
                $null -ne $readback.readbackReceipt) {
                $registered = $null
                try { $registered = Register-NativePtReadback $readback } catch { }
                if ($registered.allow -eq $true) {
                    $decision = Initialize-NativePtGuard -Root $root -Origin $candidateOrigin -Url $candidateUrl -ProfilePath $candidateProfile -MainProfile:$useMain
                    if ($null -eq $decision) { $eligibleItems += $candidate; continue }
                    if ([string]$decision.status -in @('signed','already_signed') -and $decision.submissionAttempted -eq $false) {
                        $decision | Add-Member -NotePropertyName origin -NotePropertyValue $candidateOrigin -Force
                        $decision | Add-Member -NotePropertyName url -NotePropertyValue $readback.url -Force
                        $preflightResults += $decision
                        continue
                    }
                }
            }
            if ($null -ne $readback.nativeReadback) {
                $decision | Add-Member -NotePropertyName nativeReadback -NotePropertyValue $readback.nativeReadback -Force
            }
            # An unknown prior navigation can block the execution branch before
            # it gets a chance to observe today's real secondary verification.
            # Read only the same bound profile; never infer it from hidden HTML.
            if (-not $useMain -and (Test-NativeTwoFactorRecoveryOptIn $candidateOrigin)) {
                try {
                    $probeArguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
                        (Join-Path $PSScriptRoot 'Invoke-PlainWafAccessibility.ps1'),'-Origin',$candidateOrigin,
                        '-Url',($candidateOrigin+'/index.php'),'-UserDataDirOverride',$candidateProfile,
                        '-WindowMode','offscreen','-TimeoutSeconds','25','-ReadOnly')
                    $probeOutput=@(& ([string]$config.powershellExecutable) @probeArguments 2>$null)
                    $probe=Convert-NativeChildReceipt $probeOutput
                    if ($probe.status -cin @('signed','already_signed','not_signed') -and $probe.submissionAttempted -eq $false -and
                        $probe.evidence.authoritative -eq $true -and $probe.profileBinding -ceq $script:NativePtGuard.profileBinding -and
                        $probe.accountKey -ceq 'site-default') {
                        $ack=Register-NativePtReadback $probe
                        if ($ack.allow -eq $true -and $ack.receiptAccepted -eq $true) {
                            $probeDecision=Initialize-NativePtGuard -Root $root -Origin $candidateOrigin -Url $candidateUrl -ProfilePath $candidateProfile
                            if ($null -eq $probeDecision) { $eligibleItems+=$candidate;continue }
                            if ($probeDecision.status -cin @('signed','already_signed') -and $probeDecision.evidence.authoritative -eq $true) {
                                $probeDecision|Add-Member -NotePropertyName origin -NotePropertyValue $candidateOrigin -Force
                                $probeDecision|Add-Member -NotePropertyName nativeGate -NotePropertyValue $true -Force
                                $preflightResults+=$probeDecision;continue
                            }
                        }
                    }
                    $recoveryArguments=@{Child=$probe;Origin=$candidateOrigin;Url=$candidateUrl;
                        ProfilePath=$candidateProfile;TimeoutSeconds=([int]$candidate.waitSeconds)}
                    $recovered=Invoke-NativeTwoFactorRecovery @recoveryArguments
                    if ($recovered.resumeAllowed) { $eligibleItems+=$candidate;continue }
                    if ($recovered.handled -and $recovered.result.nativeGate -eq $true -and
                        $recovered.result.status -cin @('signed','already_signed') -and $recovered.result.evidence.authoritative -eq $true) {
                        $preflightResults+=$recovered.result;continue
                    }
                    if ($probe.nativeTwoFactorRecovery) {
                        $decision|Add-Member -NotePropertyName nativeTwoFactorRecovery -NotePropertyValue $probe.nativeTwoFactorRecovery -Force
                    }
                } catch { }
            }
        }
        $decision | Add-Member -NotePropertyName origin -NotePropertyValue $candidateOrigin -Force
        $decision | Add-Member -NotePropertyName url -NotePropertyValue $candidateUrl -Force
        $decision | Add-Member -NotePropertyName nativeGate -NotePropertyValue $true -Force
        $preflightResults += $decision
    } else { $eligibleItems += $candidate }
}
$items = $eligibleItems

foreach ($configuredProfile in @($items | Where-Object { -not $_.nativeMainDirect } | Select-Object -ExpandProperty profilePath -Unique)) {
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
    # Reset per-item mutation metadata before any native branch. A missing
    # child receipt must never inherit a previous site's submission flag.
    $submissionAttempted = $false
    $gateUrl = if ($item.nativeMainDirect) { [string]$mainFallbackByOrigin[$origin].url } else { $url }
    $gateProfile = if ($item.nativeMainDirect) { Split-Path -Parent ([string]$config.bookmarksPath) } else { $profilePath }
    $decision = Initialize-NativePtGuard -Root $root -Origin $origin -Url $gateUrl -ProfilePath $gateProfile -MainProfile:([bool]$item.nativeMainDirect)
    if ($null -ne $decision) {
        $decision | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force
        $preflightResults += $decision
        continue
    }

    $apiProperty = $config.ptReadOnlyPolicies.PSObject.Properties[$origin]
    if ($null -ne $apiProperty -and $apiProperty.Value.nativeApiExecution -eq $true) {
        try {
            $apiText = & $node (Join-Path $PSScriptRoot 'Run-NativePtApiCheckin.mjs') '--origin' $origin '--url' $url
            if (-not $apiText) { throw 'Native API receipt missing' }
            $apiResult = $apiText | ConvertFrom-Json
        } catch {
            $apiResult = [pscustomobject]@{origin=$origin;status='needs_attention';failureCode='submission_outcome_unknown';
                submissionAttempted=$true;retryable=$false;reason='原生签到回执未能保存，先核验，禁止重放'}
        }
        $preflightResults += $apiResult
        continue
    }

    if ([string]$item.action -eq 'checkin') {
        $checkinInspection = $null
        $checkinText = $null; $checkinExitCode = $null; $checkinTransportStage = 'transport'
        $recoveryInfo=$null;$nativeSubmittedInThisItem=$false
        for ($nativeAttempt=0; $nativeAttempt -lt 2; $nativeAttempt++) {
        $checkinText=$null;$checkinExitCode=$null;$checkinTransportStage='transport'
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
            $checkinExitCode = $LASTEXITCODE
            $checkinTransportStage = 'decode'
            $checkinInspection = Convert-NativeChildReceipt $checkinText
        } catch { $checkinInspection = New-NativeChildTransportFailure $origin $checkinTransportStage $_ $checkinText $checkinExitCode }
        finally { if ((Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome } }
        if ($null -eq $checkinInspection) { $checkinInspection = [pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;retryable=$false;reason='原生执行器无结果，先只读核验'} }
        $nativeSubmittedInThisItem=$nativeSubmittedInThisItem -or $checkinInspection.submissionAttempted -eq $true -or
            $checkinInspection.clicked -eq $true -or $checkinInspection.checkinClicked -eq $true -or $checkinInspection.checkinClickAttempted -eq $true
        if ($origin -ceq 'https://piggo.me' -and $config.nativePtTwoFactorRecovery) {
            $recoveryArguments=@{Child=$checkinInspection;Origin=$origin;Url=$url;
                ProfilePath=$profilePath;TimeoutSeconds=([int]$item.waitSeconds)}
            $recovered=Invoke-NativeTwoFactorRecovery @recoveryArguments
            $checkinInspection=$recovered.result
            if ($checkinInspection.nativeTwoFactorRecovery) { $recoveryInfo=$checkinInspection.nativeTwoFactorRecovery }
            if ($nativeAttempt -eq 0 -and $recovered.resumeAllowed) { continue }
        }
        if ($recoveryInfo) { $checkinInspection|Add-Member -NotePropertyName nativeTwoFactorRecovery -NotePropertyValue $recoveryInfo -Force }
        if ($nativeSubmittedInThisItem) { $checkinInspection|Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $true -Force }
        break
        }
        Write-NativeSecurityDiagnostic $origin $checkinInspection
        $checkinInspection = Invoke-NativePostActionReadback -Child $checkinInspection -Origin $origin -Url $url -ProfilePath $profilePath -TimeoutSeconds ([int]$item.waitSeconds)
        if ($checkinInspection.nativeGate -eq $true) {
            $checkinInspection | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force
            $preflightResults += $checkinInspection
            continue
        }
        $confirmed = $null -ne $checkinInspection -and [string]$checkinInspection.status -in @('signed', 'already_signed')
        $twoFactorRequired = Test-TwoFactorResult $checkinInspection
        $submissionAttempted = $null -ne $checkinInspection -and (
            [bool]$checkinInspection.submissionAttempted -or [bool]$checkinInspection.checkinClicked
        )
        $preflightResults += Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{
            origin = $origin
            url = $url
            status = if ($confirmed) { [string]$checkinInspection.status } elseif ($twoFactorRequired -or $submissionAttempted) { 'needs_attention' } else { 'unconfirmed' }
            reason = if ($confirmed) { [string]$checkinInspection.reason } elseif ($checkinInspection) { [string]$checkinInspection.reason } else { '无调试原生 Chrome 未取得签到终态' }
            inspectionStatus = if ($checkinInspection) { [string]$checkinInspection.status } else { 'unavailable' }
            evidence = if ($confirmed) { $checkinInspection.evidence } else { $null }
            diagnosticStage = if ($checkinInspection) { [string]$checkinInspection.diagnosticStage } else { 'child_result' }
            nativeChildResultUnavailable = $checkinInspection.nativeChildResultUnavailable
            nativeChildDiagnostic = $checkinInspection.nativeChildDiagnostic
            postActionReadbackAttempted = $checkinInspection.postActionReadbackAttempted
            failureCode = if ($twoFactorRequired) { 'two_factor_required' } elseif ($submissionAttempted -and -not $confirmed) { 'submission_outcome_unknown' } elseif ($checkinInspection) { [string]$checkinInspection.failureCode } else { 'accessibility_unavailable' }
            submissionAttempted = $submissionAttempted
            retryable = if ($submissionAttempted) { $false } else { $null }
            attentionKind = if ($twoFactorRequired) { 'trusted_device_initialization' } else { $null }
            retryableLoginRecovery = if ($twoFactorRequired) { $false } else { $null }
            checkinClickAttempted = if ($checkinInspection) { [bool]$checkinInspection.checkinClickAttempted } else { $false }
            checkinClicked = if ($checkinInspection) { [bool]$checkinInspection.checkinClicked } else { $false }
        }) -Source $checkinInspection
        continue
    }

    $mainInspection = $null
    if ((-not [bool]$item.passiveOnly -or [bool]$item.mainChromeFallbackOnly) -and $mainFallbackByOrigin.ContainsKey($origin)) {
        $fallbackEntry = $mainFallbackByOrigin[$origin]
        $mainInspection = Invoke-MainChromeFallbackResult $origin ([string]$fallbackEntry.url) ([int]$fallbackEntry.waitSeconds)
        if ($mainInspection.nativeGate -eq $true) {
            $mainInspection | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force
            $preflightResults += $mainInspection
            continue
        }
        $mainConfirmed = $null -ne $mainInspection -and [string]$mainInspection.status -in @('signed', 'already_signed')
        $mainTwoFactorRequired = Test-TwoFactorResult $mainInspection
        $mainSubmissionAttempted = $null -ne $mainInspection -and [bool]$mainInspection.submissionAttempted
        if ($mainConfirmed -or $mainTwoFactorRequired -or $mainSubmissionAttempted -or [bool]$item.mainChromeFallbackOnly) {
            $preflightResults += Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{
                origin = $origin
                url = [string]$fallbackEntry.url
                status = if ($mainConfirmed) { 'signed' } elseif ($mainTwoFactorRequired -or $mainSubmissionAttempted) { 'needs_attention' } elseif ([string]$mainInspection.status -eq 'managed_challenge') { 'managed_challenge' } else { 'unconfirmed' }
                reason = if ($mainInspection) { [string]$mainInspection.reason } else { '主 Chrome 回退未取得明确签到终态' }
                inspectionStatus = if ($mainInspection) { [string]$mainInspection.status } else { 'unavailable' }
                evidence = if ($mainConfirmed) { $mainInspection.evidence } else { $null }
                cleanupFailureCode = [string]$mainInspection.cleanupFailureCode
                cleanupWarning = [string]$mainInspection.cleanupWarning
                failureCode = if ($mainInspection) { [string]$mainInspection.failureCode } else { 'accessibility_unavailable' }
                submissionAttempted = $mainSubmissionAttempted
                retryable = if ($mainSubmissionAttempted) { $false } else { $null }
                attentionKind = if ($mainTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
                retryableLoginRecovery = if ($mainTwoFactorRequired) { $false } else { $null }
            }) -Source $mainInspection
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
                if (-not $inspectionText) { throw 'Native passive helper returned no result' }
                if ($inspectionText) {
                    $inspection = $inspectionText | ConvertFrom-Json
                    $passiveInspection = $inspection
                    $passivePrepared = [string]$inspection.status -in @('signed', 'already_signed') `
                        -or ([string]$inspection.status -eq 'ready' `
                            -and [bool]$inspection.inspection.siteBodyLoaded `
                            -and (-not [bool]$item.trustAsSigned -or [bool]$inspection.inspection.attendanceEndpoint))
                    if ($inspection.submissionAttempted -eq $true -or $inspection.nativeGate -eq $true -or
                        [string]$inspection.status -eq 'login_required' -or (Test-TwoFactorResult $inspection)) { break }
                }
                if (-not $passivePrepared -and $plainAttempt -lt 2) { Start-Sleep -Seconds 2 }
            }
        }
        catch {
            $passivePrepared = $false
            $possibleSubmit = $script:NativePtGuard.managed -and $script:NativePtGuard.navigationRisk
            $passiveInspection = [pscustomobject]@{status=if($possibleSubmit){'needs_attention'}else{'unconfirmed'};
                failureCode=if($possibleSubmit){'submission_outcome_unknown'}else{'accessibility_unavailable'};
                submissionAttempted=[bool]$possibleSubmit;retryable=if($possibleSubmit){$false}else{$null};reason='原生预热结果不可确认，等待只读核验'}
        }
        finally {
            if ((Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome }
        }

        if ($passiveInspection.nativeGate -eq $true -or $passiveInspection.submissionAttempted -eq $true) {
            $passiveInspection | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force
            $passiveInspection | Add-Member -NotePropertyName nativeGate -NotePropertyValue $true -Force
            $preflightResults += $passiveInspection
            continue
        }

        # Windows UI Automation is unavailable while the interactive desktop
        # is locked. The no-debug launch above still lets Chrome establish the
        # WAF/session state. Reopen the same isolated profile once with a debug
        # port only for authoritative readback; never use this path to click.
        if (-not $passivePrepared -and (-not $script:NativePtGuard.managed -or $origin -in $CheckinNativePtHeaderOrigins) -and (
            $null -eq $passiveInspection -or
            [string]$passiveInspection.failureCode -eq 'accessibility_unavailable'
        )) {
            $readbackStarted = $false
            try {
                [void](Reset-NativeChromeDebugPort $profilePath)
                $readbackPort = Get-NativeChromeDebugPort
                $readbackUrl = if ($script:NativePtGuard.managed) { $origin + '/index.php' } else { $url }
                & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
                    -RemoteDebuggingPort $readbackPort `
                    -Urls @($readbackUrl) `
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
            if ($mainInspection.nativeGate -eq $true) {
                $mainInspection | Add-Member -NotePropertyName origin -NotePropertyValue $origin -Force
                $preflightResults += $mainInspection
                continue
            }
            $mainConfirmed = $null -ne $mainInspection -and [string]$mainInspection.status -in @('signed', 'already_signed')
            $mainTwoFactorRequired = Test-TwoFactorResult $mainInspection
            $mainSubmissionAttempted = $null -ne $mainInspection -and [bool]$mainInspection.submissionAttempted
            if ($mainConfirmed -or $mainTwoFactorRequired -or $mainSubmissionAttempted -or [bool]$item.mainChromeFallbackOnly) {
                $preflightResults += Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{
                    origin = $origin
                    url = [string]$fallbackEntry.url
                    status = if ($mainConfirmed) { [string]$mainInspection.status } elseif ($mainTwoFactorRequired -or $mainSubmissionAttempted) { 'needs_attention' } elseif ([string]$mainInspection.status -eq 'managed_challenge') { 'managed_challenge' } else { 'unconfirmed' }
                    reason = if ($mainInspection) { [string]$mainInspection.reason } else { '主 Chrome 回退未取得明确签到终态' }
                    inspectionStatus = if ($mainInspection) { [string]$mainInspection.status } else { 'unavailable' }
                    evidence = if ($mainConfirmed) { $mainInspection.evidence } else { $null }
                    cleanupFailureCode = [string]$mainInspection.cleanupFailureCode
                    cleanupWarning = [string]$mainInspection.cleanupWarning
                    failureCode = if ($mainInspection) { [string]$mainInspection.failureCode } else { 'accessibility_unavailable' }
                    submissionAttempted = $mainSubmissionAttempted
                    retryable = if ($mainSubmissionAttempted) { $false } else { $null }
                    attentionKind = if ($mainTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
                    retryableLoginRecovery = if ($mainTwoFactorRequired) { $false } else { $null }
                }) -Source $mainInspection
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
        $preflightResults += Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{
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
            evidence = if ($explicitlyConfirmed) { $passiveInspection.evidence } else { $null }
            diagnosticStage = if ($passiveInspection) { [string]$passiveInspection.diagnosticStage } else { 'child_result' }
            failureCode = if ($passiveTwoFactorRequired) { 'two_factor_required' } elseif ($passiveInspection) { [string]$passiveInspection.failureCode } else { 'accessibility_unavailable' }
             submissionAttempted = if ($passiveInspection) { [bool]$passiveInspection.submissionAttempted } else { [bool]$submissionAttempted }
             retryable = if (($passiveInspection -and [bool]$passiveInspection.submissionAttempted) -or
                 (-not $passiveInspection -and [bool]$submissionAttempted)) { $false } else { $null }
            attentionKind = if ($passiveTwoFactorRequired) { 'trusted_device_initialization' } else { $null }
            retryableLoginRecovery = if ($passiveTwoFactorRequired) { $false } else { $null }
        }) -Source $passiveInspection
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
            if (Test-NativePtNavigationRisk) { Start-NativePtWrite -Action navigation }
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
        catch { $inspection = Get-NativePtFailure -ErrorRecord $_ }
        finally {
            if ($nativeChromeStarted) { Close-AutomationChrome }
        }
        if ($script:NativePtGuard.attempted) {
            if ($null -eq $inspection) { $inspection = [pscustomobject]@{status='unconfirmed'} }
            $inspection = $inspection | Complete-NativePtResult
            break
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
    $preflightResults += Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{
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
        failureCode = if ($twoFactorRequired) { 'two_factor_required' } elseif ($submissionAttempted -and -not $explicitlyConfirmed) { 'submission_outcome_unknown' } elseif ($inspection) { [string]$inspection.failureCode } else { 'accessibility_unavailable' }
        submissionAttempted = $submissionAttempted
        retryable = if ($submissionAttempted) { $false } else { $null }
        attentionKind = if ($twoFactorRequired) { 'trusted_device_initialization' } else { $null }
        retryableLoginRecovery = if ($twoFactorRequired) { $false } else { $null }
        availabilityKind = if ($explicitlyConfirmed) { [string]$inspection.availabilityKind } else { $null }
        evidence = if ($explicitlyConfirmed) { $inspection.evidence } else { $null }
    }) -Source $inspection
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
