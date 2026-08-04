[CmdletBinding()]
param(
    [ValidateSet('completed', 'failed', 'timeout', 'skipped')]
    [string]$RunnerStatus = 'completed',
    [string]$RunnerMessage = '',
    [string]$ReportPath,
    [string]$OutboxPath,
    [string]$ConfigPath,
    [switch]$Preview
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$localConfigPath = Join-Path $root 'config\config.json'
$defaultsPath = Join-Path $root 'config\defaults.json'
$effectiveConfigPath = if ($ConfigPath) { $ConfigPath } elseif (Test-Path -LiteralPath $localConfigPath) { $localConfigPath } else { $defaultsPath }
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $effectiveConfigPath | ConvertFrom-Json
$report = $null
$results = @()

function Remove-SensitiveText([object]$Value) {
    $text = [string]$Value
    $text = $text -replace '(?i)\b(authorization)\s*:\s*(?:bearer|basic)\s+[^\s,;，；]+', '$1: [REDACTED]'
    $text = $text -replace '(?i)\b(password|passwd|pwd|access[-_]?token|refresh[-_]?token|id[-_]?token|token|cookie|client[-_]?secret|secret|api[-_ ]?key)\b\s*[:=]\s*(?:"[^"]*"|''[^'']*''|[^\s,;，；]+)', '$1=[REDACTED]'
    $text = $text -replace '(密码|口令|令牌|密钥)\s*[:=：]\s*(?:"[^"]*"|''[^'']*''|[^\s,;，；]+)', '$1=[REDACTED]'
    return $text
}

function Compress-Text([object]$Value, [int]$MaximumLength = 120) {
    $text = ((Remove-SensitiveText $Value) -replace "`e\[[0-?]*[ -/]*[@-~]", '' -replace '[\r\n\t]+', ' ' -replace '\s{2,}', ' ').Trim()
    $text = ($text -replace '\s*Call log:.*$', '').Trim()
    if ($text.Length -gt $MaximumLength) { return $text.Substring(0, $MaximumLength) + '…' }
    return $text
}

function Get-LogicalSiteKey($Result) {
    $origin = [string]$Result.origin
    $accountKey = [string]$Result.accountKey
    $suffix = if ($accountKey) { "#account=$accountKey" } else { '' }
    if ($null -ne $config.logicalCheckinGroups) {
        $property = $config.logicalCheckinGroups.PSObject.Properties[$origin]
        if ($null -ne $property -and [string]$property.Value) { return "$([string]$property.Value)$suffix" }
    }
    return "$origin$suffix"
}

function Get-ResultDisplayName($Result) {
    $hostName = try { ([uri]$Result.origin).DnsSafeHost } catch { Compress-Text $Result.origin 30 }
    $label = Compress-Text $Result.accountLabel 60
    if (-not $label) { $label = Compress-Text $Result.accountId 60 }
    if ($label) { return "$hostName（$label）" }
    return $hostName
}

function Get-LogicalStatusPriority($Result) {
    $status = [string]$Result.status
    if ($status -eq 'signed') { return 100 }
    if ($status -eq 'already_signed') { return 95 }
    if ($status -in @('interactive_challenge', 'login_required', 'needs_attention', 'managed_challenge_timeout')) { return 90 }
    if ($status -in @('error', 'failed', 'no_action', 'visited', 'clicked')) { return 80 }
    if ($status -eq 'deferred') { return 70 }
    if ($status -eq 'not_available' -and $Result.disabledByConfig -eq $true) { return 61 }
    if ($status -eq 'not_available') { return 60 }
    return 50
}

function Merge-LogicalResults([object[]]$Items) {
    $selected = [ordered]@{}
    foreach ($item in @($Items)) {
        $key = Get-LogicalSiteKey $item
        if (-not $selected.Contains($key) -or (Get-LogicalStatusPriority $item) -gt (Get-LogicalStatusPriority $selected[$key])) {
            $selected[$key] = $item
        }
    }
    return @($selected.Values)
}

if ($ReportPath) {
    $resolvedReport = (Resolve-Path -LiteralPath $ReportPath).Path
    $logsRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'logs'))
    $logsPrefix = $logsRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedReport.StartsWith($logsPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '报告必须位于本项目 logs 目录。' }
    $report = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolvedReport | ConvertFrom-Json
    $results = @($report.results)
}

$reportingResults = @(Merge-LogicalResults $results)
$statuses = @($reportingResults | ForEach-Object { [string]$_.status })
$reportRunState = if ($null -ne $report) { [string]$report.runState } else { '' }
$plannedTotal = if ($null -ne $report -and $null -ne $report.plannedTotal) { [int]$report.plannedTotal } else { $results.Count }
$processedTotal = if ($null -ne $report -and $null -ne $report.processedTotal) { [int]$report.processedTotal } else { $results.Count }
$isCompleteFinalReport = $null -ne $report `
    -and $reportRunState -eq 'final' `
    -and $report.isComplete -eq $true `
    -and $plannedTotal -gt 0 `
    -and $processedTotal -ge $plannedTotal `
    -and $results.Count -ge $plannedTotal
$isPartialReport = $null -ne $report -and -not $isCompleteFinalReport
$logicalPlannedTotal = if ($null -ne $report -and $null -ne $report.bookmarkSummary -and $null -ne $report.bookmarkSummary.targets) {
    @($report.bookmarkSummary.targets | ForEach-Object { Get-LogicalSiteKey $_ } | Select-Object -Unique).Count
}
elseif ($isCompleteFinalReport) { $reportingResults.Count }
else { $plannedTotal }
$logicalProcessedTotal = $reportingResults.Count
$done = @($statuses | Where-Object { $_ -in @('signed', 'already_signed') }).Count
$disabled = @($reportingResults | Where-Object { $_.status -eq 'not_available' -and $_.disabledByConfig -eq $true }).Count
$notAvailable = @($reportingResults | Where-Object { $_.status -eq 'not_available' -and $_.disabledByConfig -ne $true }).Count
$problems = @($reportingResults | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') })
$attentionCount = @($problems | Where-Object { $_.status -in @('interactive_challenge', 'login_required', 'needs_attention') }).Count
$timeoutCount = @($problems | Where-Object { $_.status -eq 'managed_challenge_timeout' }).Count
$hardFailureCount = @($problems | Where-Object { $_.status -in @('error', 'failed') }).Count

if ($RunnerStatus -eq 'timeout') { $status = 'timeout' }
elseif ($isPartialReport) { $status = 'unconfirmed' }
elseif ($reportingResults.Count -gt 0 -and $problems.Count -eq 0 -and $statuses -contains 'signed') { $status = 'success' }
elseif ($reportingResults.Count -gt 0 -and $problems.Count -eq 0 -and $statuses -contains 'already_signed') { $status = 'already_done' }
elseif ($reportingResults.Count -gt 0 -and $problems.Count -eq 0) { $status = 'skipped' }
elseif ($reportingResults.Count -gt 0 -and $attentionCount -gt 0) { $status = 'needs_attention' }
elseif ($reportingResults.Count -gt 0 -and ($done -gt 0 -or $notAvailable -gt 0 -or $disabled -gt 0)) { $status = 'unconfirmed' }
elseif ($reportingResults.Count -gt 0 -and $timeoutCount -eq $reportingResults.Count) { $status = 'timeout' }
elseif ($reportingResults.Count -gt 0 -and $hardFailureCount -eq $reportingResults.Count) { $status = 'failed' }
elseif ($reportingResults.Count -gt 0 -and $statuses -contains 'deferred') { $status = 'skipped' }
elseif ($reportingResults.Count -gt 0) { $status = 'unconfirmed' }
elseif ($RunnerStatus -eq 'failed') { $status = 'failed' }
elseif ($RunnerStatus -eq 'skipped') { $status = 'skipped' }
else { $status = 'unconfirmed' }

$summary = if ($reportingResults.Count -gt 0 -or ($null -ne $report -and $plannedTotal -gt 0)) {
    $heading = if ($isCompleteFinalReport) { "共 $logicalPlannedTotal 站：" } else { "已处理 $logicalProcessedTotal/$logicalPlannedTotal 站（任务未完成）：" }
    $summaryValue = "$heading`n$done 个签到正常`n$notAvailable 个未开放签到"
    if ($disabled -gt 0) { $summaryValue += "`n$disabled 个已取消签到" }
    $summaryValue
}
else { Compress-Text $RunnerMessage 160 }
$accountResults = @($reportingResults | Where-Object { [string]$_.accountKey })
if ($accountResults.Count -gt 0) {
    $summary += "`n账号结果："
    $summary += "`n" + (($accountResults | ForEach-Object {
        $marker = if ($_.status -in @('signed', 'already_signed')) { '✅' } elseif ($_.status -eq 'not_available') { '⏭️' } else { '❌' }
        $reward = if ($_.evidence.rewardAmount) { " `$$([decimal]$_.evidence.rewardAmount)" } else { '' }
        "- $marker $(Get-ResultDisplayName $_)$reward"
    }) -join "`n")
}
if ($problems.Count -gt 0) {
    $summary += "`n需关注 $($problems.Count) 个："
    $brief = @($problems | ForEach-Object {
        $problem = $_
        $hostName = Get-ResultDisplayName $problem
        $reason = switch ([string]$problem.status) {
            'login_required' { '登录失效' }
            'interactive_challenge' { '需要验证' }
            'managed_challenge_timeout' { '验证超时' }
            'deferred' {
                $retryLabel = switch ([string]$problem.retryCause) {
                    'login_required' { '登录恢复未成功'; break }
                    'managed_challenge_timeout' { '验证未自动通过'; break }
                    default { '限频' }
                }
                if ($problem.nextEligibleAt) { try { "$retryLabel，计划 $(([datetime]$problem.nextEligibleAt).ToLocalTime().ToString('HH:mm')) 重试" } catch { "$retryLabel，已安排重试" } }
                else { "$retryLabel，已安排重试" }
            }
            'no_action' { '未找到入口' }
            'visited' { '结果未确认' }
            'clicked' { '结果未确认' }
            default { Compress-Text $problem.reason 40 }
        }
        "- $hostName：$reason"
    }) -join "`n"
    $summary += "`n$brief"
}
if ($summary.Length -gt 950) { $summary = $summary.Substring(0, 947) + "…`n（其余站点请查看本地日志）" }
$summary = Remove-SensitiveText $summary

$notification = $config.notification
$mode = if ($notification.mode) { [string]$notification.mode } else { 'none' }
$taskId = if ($notification.taskId) { [string]$notification.taskId } else { 'bookmark_daily' }
$name = if ($notification.name) { [string]$notification.name } else { '浏览器书签签到' }
$source = if ($notification.source) { [string]$notification.source } else { 'browser-codex' }

$stateParts = @($reportingResults | Sort-Object { Get-LogicalSiteKey $_ } | ForEach-Object {
    "$(Get-LogicalSiteKey $_)=$([string]$_.status):$([string]$_.retryCause)"
})
$stateMaterial = if ($stateParts.Count -gt 0) { "$status|$reportRunState|$($stateParts -join '|')" } else { "$status|$RunnerStatus" }
$stateBytes = [System.Text.Encoding]::UTF8.GetBytes($stateMaterial)
$stateHashBytes = [System.Security.Cryptography.SHA256]::HashData($stateBytes)
$stateHash = [System.Convert]::ToHexString($stateHashBytes).Substring(0, 16).ToLowerInvariant()
$eventKey = "external:$source`:$taskId`:$((Get-Date).ToString('yyyy-MM-dd')):$stateHash"
$payload = [ordered]@{
    status = $status
    summary = $summary
    siteCount = $reportingResults.Count
    problemCount = $problems.Count
    runState = $reportRunState
    plannedTotal = $logicalPlannedTotal
    processedTotal = $logicalProcessedTotal
    isComplete = [bool]$isCompleteFinalReport
    eventKey = $eventKey
    mode = $mode
}
if ($Preview -or $mode -eq 'none') {
    $payload.accepted = $false
    $payload.preview = [bool]$Preview
    $payload | ConvertTo-Json -Compress
    return
}
if ($mode -ne 'command') { throw "不支持的通知模式：$mode" }
if (-not $OutboxPath) { $OutboxPath = Join-Path $root 'data\notification-outbox' }
[System.IO.Directory]::CreateDirectory($OutboxPath) | Out-Null

$eventBytes = [System.Text.Encoding]::UTF8.GetBytes($eventKey)
$eventHashBytes = [System.Security.Cryptography.SHA256]::HashData($eventBytes)
$eventHash = [System.Convert]::ToHexString($eventHashBytes).ToLowerInvariant()
$itemPath = Join-Path $OutboxPath "$eventHash.json"
$payloadMaterial = @($eventKey, $taskId, $name, $source, $status, $summary) -join "`n"
$payloadHashBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($payloadMaterial))
$payloadHash = [System.Convert]::ToHexString($payloadHashBytes).ToLowerInvariant()
$now = [DateTimeOffset]::UtcNow
$existing = $null
if (Test-Path -LiteralPath $itemPath) {
    try { $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $itemPath | ConvertFrom-Json }
    catch { throw "通知 outbox 条目损坏：$itemPath" }
    if ([string]$existing.eventKey -ne $eventKey) { throw '通知 outbox 事件哈希冲突。' }
}

$item = [ordered]@{
    schemaVersion = 1
    eventKey = $eventKey
    payloadHash = $payloadHash
    taskId = $taskId
    name = $name
    source = $source
    status = $status
    summary = $summary
    createdAt = if ($existing.createdAt) { [string]$existing.createdAt } else { $now.ToString('o') }
    updatedAt = $now.ToString('o')
    nextAttemptAt = if ($existing.delivered -eq $true) { $null } elseif ($existing.nextAttemptAt) { [string]$existing.nextAttemptAt } else { $now.ToString('o') }
    attempts = if ($null -ne $existing.attempts) { [int]$existing.attempts } else { 0 }
    delivered = [bool]($existing.delivered -eq $true)
    deliveredAt = if ($existing.deliveredAt) { [string]$existing.deliveredAt } else { $null }
    disposition = if ($existing.disposition) { [string]$existing.disposition } else { $null }
    lastError = if ($existing.lastError) { Remove-SensitiveText $existing.lastError } else { $null }
}

$temporary = "$itemPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
try {
    [System.IO.File]::WriteAllText($temporary, ($item | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $itemPath -Force
}
finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

$payload.accepted = [bool]$item.delivered
$payload.enqueued = -not [bool]$item.delivered
$payload | ConvertTo-Json -Compress
