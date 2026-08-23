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
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$profilePath = [string]$config.automationUserDataDir
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
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生 WAF 预热地址无效：$rawUrl" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生 WAF 等待时间必须为 5 到 120 秒：$rawUrl" }
    [pscustomobject]@{ url = $uri.AbsoluteUri; waitSeconds = $waitSeconds; trustAsSigned = $trustAsSigned; passiveOnly = $passiveOnly }
})
$items += @($config.nativeChallengePreflight | ForEach-Object {
    $uri = [uri][string]$_.url
    $waitSeconds = [int]$_.waitSeconds
    $passiveOnly = [bool]$_.passiveOnly
    if ($uri.Scheme -ne 'https' -or -not $uri.Host) { throw "原生验证预热地址无效：$($_.url)" }
    if ($waitSeconds -lt 5 -or $waitSeconds -gt 120) { throw "原生验证等待时间必须为 5 到 120 秒：$($_.url)" }
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
        reloadOnChallengeAfterSeconds = $reloadOnChallengeAfterSeconds
    }
})

if (-not $AllConfigured) {
    $originSet = @{};
    foreach ($origin in $Origins) { $originSet[([uri]$origin).GetLeftPart([System.UriPartial]::Authority)] = $true }
    $items = @($items | Where-Object { $originSet.ContainsKey(([uri]$_.url).GetLeftPart([System.UriPartial]::Authority)) })
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
            $confirmedStatus = [string]$prior.lastConfirmedStatus
            if (-not $confirmedStatus -and -not $prior.lastSuccessAt -and [int]$prior.confirmedCount -gt 0) {
                $confirmedStatus = 'not_available'
            }
            if ($confirmedStatus -ne 'not_available') { return $true }
            try { return ((Get-Date) - [datetime]$prior.lastConfirmedAt).TotalHours -ge $recheckHours }
            catch { return $true }
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

if ((Get-AutomationChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 配置正被占用，无法执行原生 WAF 预热。'
}

$preflightResults = @()

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

# Chrome 会节流离屏的非活动标签页，因此逐站打开并正常关闭，确保每个
# 雷池通行 Cookie 都在独立配置中完成落盘。
foreach ($item in $items) {
    $url = [string]$item.url
    $origin = ([uri]$url).GetLeftPart([System.UriPartial]::Authority)
    $hostName = ([uri]$url).Host

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
                    '-Origin', $origin, '-Url', $url, '-TimeoutSeconds', [string]([int]$item.waitSeconds)
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
                    if ([string]$inspection.status -eq 'login_required') { break }
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

        if (-not $passivePrepared) {
            Write-Warning "被动原生预热未完成：$hostName"
        }
        $explicitlyConfirmed = $null -ne $passiveInspection `
            -and [string]$passiveInspection.status -in @('signed', 'already_signed')
        $preparedOnly = $passivePrepared -and -not $explicitlyConfirmed -and -not [bool]$item.trustAsSigned
        $preflightResults += [pscustomobject]@{
            origin = $origin
            url = $url
            status = if ($explicitlyConfirmed -or ($passivePrepared -and [bool]$item.trustAsSigned)) {
                'signed'
            } elseif ($preparedOnly) {
                'prepared'
            } elseif ([string]$passiveInspection.status -eq 'managed_challenge') {
                'managed_challenge'
            } else {
                'unconfirmed'
            }
            reason = if ($explicitlyConfirmed -or ($passivePrepared -and [bool]$item.trustAsSigned)) {
                if ($passiveInspection.reason) { [string]$passiveInspection.reason } else { '原生 Chrome 已确认签到完成' }
            } elseif ($preparedOnly) {
                '无调试原生 Chrome 已完成验证预热，等待自动化复查'
            } else {
                if ($passiveInspection.reason) { [string]$passiveInspection.reason } else { '原生 Chrome 未取得明确签到终态' }
            }
            inspectionStatus = if ($passiveInspection) { [string]$passiveInspection.status } else { 'unconfirmed' }
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
                $attemptExplicit = [string]$inspection.status -in @('signed', 'already_signed')
                $attemptEndpoint = [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [bool]$inspection.attendanceEndpoint -and [string]$inspection.status -eq 'ready'
                $attemptPrepared = [string]$item.action -ne 'checkin' -and -not [bool]$item.trustAsSigned -and [bool]$inspection.siteBodyLoaded `
                    -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
                if (-not $attemptExplicit -and -not $attemptEndpoint -and -not $attemptPrepared) { $inspection = $null }
            }
        }
        catch { $inspection = $null }
        finally {
            if ($nativeChromeStarted) { Close-AutomationChrome }
        }
        if ($null -eq $inspection -and $inspectionAttempt -lt $maximumInspectionAttempts) { Start-Sleep -Seconds 1 }
    }
    $explicitlyConfirmed = $null -ne $inspection -and [string]$inspection.status -in @('signed', 'already_signed')
    $endpointConfirmed = [bool]$item.trustAsSigned -and $null -ne $inspection `
        -and [bool]$inspection.siteBodyLoaded -and [bool]$inspection.attendanceEndpoint `
        -and [string]$inspection.status -eq 'ready'
    $prepared = [string]$item.action -ne 'checkin' -and $null -ne $inspection -and [bool]$inspection.siteBodyLoaded `
        -and [string]$inspection.status -notin @('login_required', 'interactive_challenge', 'managed_challenge')
    if (-not $explicitlyConfirmed -and -not $endpointConfirmed -and -not $prepared) {
        Write-Warning "原生验证未能确认站点正文：$hostName"
    }
    $preflightResults += [pscustomobject]@{
        origin = $origin
        url = $url
        status = if ($explicitlyConfirmed -or $endpointConfirmed) { 'signed' } elseif ($prepared) { 'prepared' } else { 'unconfirmed' }
        reason = if ($explicitlyConfirmed) {
            '原生 Chrome 已通过 WAF，并由页面明确确认今天已签到'
        } elseif ($endpointConfirmed) {
            '原生 Chrome 已通过 WAF，并确认签到端点完整加载'
        } elseif ($prepared) {
            '原生 Chrome 已完成验证预热，等待自动化复查'
        } else {
            '原生验证页面未能确认签到结果'
        }
        inspectionStatus = if ($null -ne $inspection) { [string]$inspection.status } else { 'unavailable' }
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
