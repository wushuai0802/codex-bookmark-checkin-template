[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$SuppressReport,
    [int]$Attempts = 0,
    [string[]]$ManualConfirmedOrigins = @(),
    [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'RunLock.ps1')
$reporterScript = Join-Path $PSScriptRoot 'Submit-UnifiedCheckinReport.ps1'
$outboxScript = Join-Path $PSScriptRoot 'Invoke-CheckinNotificationOutbox.ps1'
$runLockPath = Join-Path $root 'tmp\run.lock'
$startedAt = Get-Date
$runnerStatus = 'failed'
$runnerMessage = '签到任务尚未开始。'
$nodeExitCode = 1
$locationPushed = $false
$resumeCandidate = $null
$wrapperMutex = $null
$wrapperMutexOwned = $false

function Get-FreshResumeReport([datetime]$NotBefore) {
    $logsRoot = Join-Path $root 'logs'
    if (-not (Test-Path -LiteralPath $logsRoot)) { return $null }
    $candidates = @()
    $latestPath = Join-Path $logsRoot 'latest.json'
    if (Test-Path -LiteralPath $latestPath) { $candidates += Get-Item -LiteralPath $latestPath }
    $candidates += @(Get-ChildItem -LiteralPath $logsRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        foreach ($name in @('result.json', 'progress.json')) {
            $path = Join-Path $_.FullName $name
            if (Test-Path -LiteralPath $path) { Get-Item -LiteralPath $path }
        }
    })
    $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
    $validCandidates = @()
    foreach ($file in @($candidates | Where-Object { $_.LastWriteTime -ge $NotBefore.AddSeconds(-2) } | Sort-Object LastWriteTime -Descending)) {
        try {
            $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName | ConvertFrom-Json
            if ([string]$value.runId -like "$todayPrefix*" -and $null -ne $value.results) {
                $plannedTotal = if ($null -ne $value.plannedTotal) { [int]$value.plannedTotal } else { 0 }
                $processedTotal = if ($null -ne $value.processedTotal) { [int]$value.processedTotal } else { @($value.results).Count }
                $completeFinal = [string]$value.runState -eq 'final' `
                    -and $value.isComplete -eq $true `
                    -and $plannedTotal -gt 0 `
                    -and $processedTotal -ge $plannedTotal `
                    -and @($value.results).Count -ge $plannedTotal
                $validCandidates += [pscustomobject]@{
                    Path = $file.FullName
                    Report = $value
                    LastWriteTime = $file.LastWriteTime
                    CompleteFinal = $completeFinal
                }
            }
        }
        catch { }
    }
    return @($validCandidates | Sort-Object `
        @{ Expression = { [int]$_.CompleteFinal }; Descending = $true }, `
        @{ Expression = { $_.LastWriteTime }; Descending = $true } | Select-Object -First 1)[0]
}

function Get-TodayResumeReport {
    $latestPath = Join-Path $root 'logs\latest.json'
    if (-not (Test-Path -LiteralPath $latestPath)) { return $null }
    try {
        $value = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        $todayPrefix = (Get-Date).ToString('yyyyMMdd') + '-'
        $minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
        if ([string]$value.runId -like "$todayPrefix*" `
            -and [string]$value.runState -eq 'final' `
            -and $value.isComplete -eq $true `
            -and @($value.results).Count -ge $minimumTargets) {
            return [pscustomobject]@{ Path = $latestPath; Report = $value; LastWriteTime = (Get-Item -LiteralPath $latestPath).LastWriteTime }
        }
    }
    catch { }
    return $null
}

function Test-IsCompleteFinalReport($Report) {
    if ($null -eq $Report) { return $false }
    if ([string]$Report.runState -ne 'final' -or $Report.isComplete -ne $true) { return $false }
    $plannedTotal = if ($null -ne $Report.plannedTotal) { [int]$Report.plannedTotal } else { 0 }
    $processedTotal = if ($null -ne $Report.processedTotal) { [int]$Report.processedTotal } else { @($Report.results).Count }
    return $plannedTotal -gt 0 -and $processedTotal -ge $plannedTotal -and @($Report.results).Count -ge $plannedTotal
}

function Test-HasImmediateRetry($Report, [datetime]$RetryAt) {
    $results = @($Report.results)
    if (-not (Test-IsCompleteFinalReport $Report)) { return $true }
    $unresolved = @($results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
    if ($unresolved.Count -eq 0) { return $false }
    foreach ($result in $unresolved) {
        if ([string]$result.status -ne 'deferred') { return $true }
        try {
            if (-not $result.nextEligibleAt -or [datetime]$result.nextEligibleAt -le $RetryAt) { return $true }
        }
        catch { return $true }
    }
    return $false
}

function Test-NeedsSavedLoginSync($ResumeCandidate, [datetime]$Now) {
    if ($null -eq $ResumeCandidate) { return $true }
    foreach ($result in @($ResumeCandidate.Report.results)) {
        $isLoginProblem = [string]$result.status -eq 'login_required' `
            -or ([string]$result.status -eq 'deferred' -and [string]$result.retryCause -eq 'login_required')
        if (-not $isLoginProblem) { continue }
        try { if (-not $result.nextEligibleAt -or [datetime]$result.nextEligibleAt -le $Now) { return $true } }
        catch { return $true }
    }
    return $false
}

try {
    Push-Location $root
    $locationPushed = $true
    $effectiveConfigPath = if ($ConfigPath) { [System.IO.Path]::GetFullPath($ConfigPath) } else { Join-Path $root 'config\config.json' }
    if (-not (Test-Path -LiteralPath $effectiveConfigPath -PathType Leaf)) { throw '尚未初始化，请先运行 scripts\Initialize-Checkin.ps1。' }
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $effectiveConfigPath | ConvertFrom-Json

    try { & (Join-Path $PSScriptRoot 'Clear-StalePrivateTemp.ps1') -RetentionHours 48 | Out-Null }
    catch { Write-Warning "过期临时文件清理未完成：$($_.Exception.Message)" }

    $wrapperMutexName = if ($config.runMutexName) { [string]$config.runMutexName } else { 'Local\CodexBookmarkCheckinRun' }
    $wrapperMutex = [System.Threading.Mutex]::new($false, $wrapperMutexName)
    try { $wrapperMutexOwned = $wrapperMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $wrapperMutexOwned = $true }
    if (-not $wrapperMutexOwned) {
        $runnerStatus = 'busy'
        $runnerMessage = '已有一个签到 wrapper 正在运行，本次不重复启动。'
        $nodeExitCode = 0
        $SuppressReport = $true
        return
    }

    $node = Resolve-CheckinNode $config

    $timeoutMinutes = if ($null -ne $config.taskTimeoutMinutes) { [int]$config.taskTimeoutMinutes } else { 25 }
    if ($timeoutMinutes -lt 5 -or $timeoutMinutes -gt 55) { throw 'taskTimeoutMinutes 必须为 5 到 55 分钟。' }
    $runAttempts = if ($Attempts -gt 0) { $Attempts } elseif ($null -ne $config.taskRunAttempts) { [int]$config.taskRunAttempts } else { 2 }
    if ($runAttempts -lt 1 -or $runAttempts -gt 3) { throw '任务级重试次数必须为 1 到 3。' }
    if ($DryRun) { $runAttempts = 1 }
    $retryDelayMinutes = if ($null -ne $config.taskRetryDelayMinutes) { [int]$config.taskRetryDelayMinutes } else { 3 }
    if ($retryDelayMinutes -lt 0 -or $retryDelayMinutes -gt 30) { throw '任务级重试间隔必须为 0 到 30 分钟。' }

    $arguments = @((Join-Path $root 'src\index.mjs'))
    if ($DryRun) { $arguments += '--dry-run' }

    if (-not $DryRun) { $resumeCandidate = Get-TodayResumeReport }
    $manualConfirmed = @($ManualConfirmedOrigins | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($manualConfirmed.Count -gt 0) {
        if ($DryRun) { throw '人工完成确认不能与 DryRun 同时使用。' }
        if ($null -eq $resumeCandidate) { throw '人工完成确认需要今天已有完整 final 报告。' }
        $arguments += @('--manual-confirmed-origins', ($manualConfirmed -join ','))
    }

    $shouldSyncSavedLogins = -not $DryRun `
        -and (Test-NeedsSavedLoginSync $resumeCandidate (Get-Date)) `
        -and $config.syncBookmarkSavedLogins -eq $true
    if ($shouldSyncSavedLogins) {
        try {
            & (Join-Path $PSScriptRoot 'Sync-ChromeSavedLogins.ps1')
            if ($LASTEXITCODE -ne 0) { throw "Chrome 保存密码同步退出码为 $LASTEXITCODE。" }
        }
        catch {
            # Password-database synchronization is an optional recovery aid.
            # A missing Python runtime or an unavailable source profile must
            # not prevent sites with an existing session from checking in.
            $syncFailure = ([string]$_.Exception.Message -replace '[\r\n\t]+', ' ').Trim()
            if ($syncFailure.Length -gt 240) { $syncFailure = $syncFailure.Substring(0, 240) }
            Write-Warning "Chrome 保存密码同步未完成，继续使用现有机器人会话：$syncFailure"
        }
    }

    if ($DryRun) {
        & $node @arguments
        $nodeExitCode = $LASTEXITCODE
        $runnerStatus = 'skipped'
        $runnerMessage = '仅执行书签读取与对比，未签到。'
    }
    else {
        for ($attempt = 1; $attempt -le $runAttempts; $attempt++) {
            $runArguments = @($arguments)
            if ($null -ne $resumeCandidate) {
                $runArguments += @('--resume-report', [string]$resumeCandidate.Path)
            }
            if (@($config.nativeWafPreflightUrls).Count -gt 0 -or @($config.nativeChallengePreflight).Count -gt 0) {
                $preflightOrigins = @()
                if ($null -ne $resumeCandidate) {
                    $preflightOrigins = @($resumeCandidate.Report.results | Where-Object {
                        ($_.status -notin @('signed', 'already_signed', 'not_available')) `
                            -and ($manualConfirmed -notcontains [string]$_.origin)
                    } | ForEach-Object { [string]$_.origin })
                }
                elseif ($attempt -eq 1) {
                    $preflightOutput = & $node (Join-Path $root 'src\index.mjs') '--preflight-origins'
                    if ($LASTEXITCODE -ne 0) { throw '无法根据已校验书签计划生成原生预热范围。' }
                    try { $preflightOrigins = @($preflightOutput | ConvertFrom-Json) }
                    catch { throw '原生预热范围输出无效。' }
                }
                if ($preflightOrigins.Count -gt 0) {
                    & (Join-Path $PSScriptRoot 'Prepare-NativeWafSession.ps1') -Origins $preflightOrigins
                }
            }

            Write-Output "开始签到任务级尝试 $attempt/$runAttempts。"
            $attemptStartedAt = Get-Date
            $process = Start-Process -FilePath $node -ArgumentList $runArguments -NoNewWindow -PassThru
            $processStartedAt = $process.StartTime
            $finishedInTime = $process.WaitForExit($timeoutMinutes * 60 * 1000)
            if (-not $finishedInTime) {
                try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
                $nodeExitCode = 124
                $runnerStatus = 'timeout'
                $runnerMessage = "第 $attempt 次尝试超过 $timeoutMinutes 分钟。"
                $processExited = $false
                try { $processExited = $process.WaitForExit(10000) } catch { }
                try { $process.Refresh(); $processExited = $processExited -or $process.HasExited } catch { }
                if (-not $processExited) {
                    $runnerStatus = 'timeout_process_alive'
                    $runnerMessage = "第 $attempt 次尝试超时且子进程仍存活；保留运行锁，拒绝并发重试。"
                    $SuppressReport = $true
                    Write-Warning $runnerMessage
                    break
                }
                [void](Remove-RunLockOwnedByProcess -LockPath $runLockPath -ProcessId $process.Id -ProcessStartedAt $processStartedAt)
            }
            else {
                $nodeExitCode = $process.ExitCode
                $runnerStatus = 'completed'
                $runnerMessage = "任务级尝试 $attempt/$runAttempts 已结束，退出码 $nodeExitCode。"
            }
            $freshCandidate = Get-FreshResumeReport $attemptStartedAt
            if ($null -ne $freshCandidate) { $resumeCandidate = $freshCandidate }
            if ($nodeExitCode -eq 0 -and ($null -eq $freshCandidate -or -not (Test-IsCompleteFinalReport $freshCandidate.Report))) {
                $nodeExitCode = 2
                $runnerMessage = "签到程序已结束，但第 $attempt 次尝试未生成完整的 final 报告。"
            }
            if ($nodeExitCode -eq 0) { break }
            if ($attempt -lt $runAttempts) {
                if ($null -ne $resumeCandidate -and -not (Test-HasImmediateRetry $resumeCandidate.Report ((Get-Date).AddMinutes($retryDelayMinutes)))) {
                    Write-Warning '剩余站点尚未到可重试时间，本次不空转，交由调度器按 nextEligibleAt 定向补跑。'
                    break
                }
                if ($retryDelayMinutes -gt 0) { Start-Sleep -Seconds ($retryDelayMinutes * 60) }
            }
        }
    }
}
catch {
    if ($nodeExitCode -eq 0) { $nodeExitCode = 1 }
    $runnerStatus = 'failed'
    $runnerMessage = ([string]$_.Exception.Message -replace '[\r\n\t]+', ' ')
    if ($runnerMessage.Length -gt 300) { $runnerMessage = $runnerMessage.Substring(0, 300) }
    Write-Warning $runnerMessage
}
finally {
    if (-not $DryRun -and -not $SuppressReport) {
        try {
            $notificationCandidate = Get-FreshResumeReport $startedAt
            if ($null -ne $notificationCandidate) { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage -ReportPath ([string]$notificationCandidate.Path) }
            else { & $reporterScript -RunnerStatus $runnerStatus -RunnerMessage $runnerMessage }
        }
        catch {
            Write-Warning "结果通知失败：$($_.Exception.Message)"
        }
        try { & $outboxScript | Out-Null }
        catch { Write-Warning "通知 outbox 暂未送达，将由后台调度器重试：$($_.Exception.Message)" }
    }
    if ($locationPushed) { Pop-Location }
    if ($wrapperMutexOwned -and $null -ne $wrapperMutex) {
        try { $wrapperMutex.ReleaseMutex() | Out-Null } catch { }
    }
    if ($null -ne $wrapperMutex) { $wrapperMutex.Dispose() }
}

exit $nodeExitCode
