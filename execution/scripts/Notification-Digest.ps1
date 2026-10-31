# Presentation and durable notification events only. Never invokes a notifier,
# runner, login recovery, scheduler mutation or site action.
function Get-DigestHash([string]$Text) {
    [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
}

function Get-DigestPayloadHash($Item) {
    Get-DigestHash (@($Item.eventKey,$Item.taskId,$Item.name,$Item.source,$Item.status,$Item.summary) -join "`n")
}

function Write-DigestOutboxItem($Event) {
    $itemPath = Join-Path $OutboxPath "$(Get-DigestHash $Event.eventKey).json"
    if (Test-Path -LiteralPath $itemPath) {
        $existing = Get-Content -Raw -Encoding UTF8 -LiteralPath $itemPath | ConvertFrom-Json
        if ($existing.eventKey -cne $Event.eventKey -or $existing.payloadHash -cne (Get-DigestPayloadHash $existing)) { throw '通知 outbox 校验失败。' }
        return $existing # A daily event is immutable, including while delivery is pending.
    }
    $item = [ordered]@{
        schemaVersion=1; eventKey=$Event.eventKey; taskId=$taskId; name=$name; source=$source
        status=$Event.status; summary=$Event.summary; payloadHash=''
        createdAt=$NowUtc.ToString('o'); updatedAt=$NowUtc.ToString('o'); nextAttemptAt=$NowUtc.ToString('o')
        attempts=0; delivered=$false; deliveredAt=$null; disposition=$null; lastError=$null
    }
    if ($Event.sites) { $item.notificationSites=@($Event.sites) }
    $item.payloadHash = Get-DigestPayloadHash ([pscustomobject]$item)
    $temporary = "$itemPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary,($item | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $itemPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    }
    [pscustomobject]$item
}

function Get-DigestTime([string]$Field,[string]$Fallback) {
    $value = if ($notification.$Field) { [string]$notification.$Field } elseif ($notificationDefaults.$Field) { [string]$notificationDefaults.$Field } else { $Fallback }
    if ($value -notmatch '^(?:[01]\d|2[0-3]):[0-5]\d$') { throw '通知时间必须为 HH:mm。' }
    [timespan]::ParseExact($value,'hh\:mm',$null)
}

function Get-DigestSiteName($Task) {
    # Reuse the display helper with site-only input: account labels, identities,
    # raw reasons and URLs must not enter digest or exception text.
    $value = Get-ResultDisplayName ([pscustomobject]@{origin=$Task.origin})
    if ($value -notmatch '^[\p{L}\p{N}.-]{1,100}$') { return '站点' }
    $value
}

function Limit-DigestText([string]$Text) {
    if ($Text.Length -le 950) { return $Text }
    $lines = @()
    foreach ($line in ($Text -split "`n")) {
        if ((($lines + $line) -join "`n").Length -gt 900) { break }
        $lines += $line
    }
    ($lines -join "`n").TrimEnd() + "`n… 更多明细见面板"
}

function Invoke-DailyDigest {
    $digestAt = Get-DigestTime 'dailyDigestAt' '11:00'
    $missingAfter = Get-DigestTime 'runMissingAfter' '12:00'
    $finalToday = $isCompleteFinalReport -and $report.finishedAt -and
        [string]$report.runId -like "$($businessDate.Replace('-',''))-*" -and
        ([datetimeoffset]$report.finishedAt) -le $NowUtc.AddMinutes(1) -and
        ([datetimeoffset]$report.finishedAt).ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -ceq $businessDate
    $verdict = $notificationView.dayVerdict
    $tasks = @($notificationView.verdictTasks)
    $events = [Collections.Generic.List[object]]::new()
    $prefix = "external:$source`:$taskId`:$businessDate"
    $payload.summary='当日结论尚未就绪，等待只读状态同步。'
    $payload.status='unconfirmed'
    $existingItems = @()
    if (-not $OutboxPath) { $OutboxPath = Join-Path $root 'data/notification-outbox' }
    $mutex = [Threading.Mutex]::new($false,"Local\CheckinDigest$(Get-DigestHash ([IO.Path]::GetFullPath($OutboxPath).ToLowerInvariant()))")
    $held = $false
    try {
        try { $held = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held=$true }
        if (-not $held) { throw '通知汇总繁忙，请稍后重试。' }
        if (Test-Path -LiteralPath $OutboxPath) {
            foreach ($file in @(Get-ChildItem -LiteralPath $OutboxPath -Filter '*.json' -File)) {
                try {
                    $item = Get-Content -Raw -Encoding UTF8 -LiteralPath $file.FullName | ConvertFrom-Json
                    if ($item.source -ceq $source -and $item.taskId -ceq $taskId -and
                        $item.payloadHash -ceq (Get-DigestPayloadHash $item)) { $existingItems += $item }
                } catch { } # The unchanged delivery worker owns quarantine.
            }
        }
        $seenSites = @()
        foreach ($item in $existingItems) {
            $sites = @($item.notificationSites | Sort-Object -Unique)
            if ($sites.Count -and $item.eventKey -ceq "$prefix`:action_needed:$(Get-DigestHash ($sites -join '|'))") { $seenSites += $sites }
        }
        if ($null -ne $verdict -and $verdict.businessDate -ceq $businessDate) {
            $c = $verdict.counts
            $payload.status = if ($c.actionNeeded -gt 0) { 'needs_attention' } elseif ($c.verifying -gt 0) { 'unconfirmed' } else { 'success' }
            $payload.dayVerdict = $verdict
            $payload.scope = $notificationView.verdictScope
            $actionIds = @($verdict.items | Where-Object class -eq 'actionNeeded' | ForEach-Object taskId)
            $actionTasks = @($tasks | Where-Object { $actionIds -ccontains $_.taskId } | Sort-Object origin -Unique)
            $actionSites = @($actionTasks | ForEach-Object { Get-DigestHash ([string]$_.origin) } | Sort-Object -Unique)
            $newSites = @($actionSites | Where-Object { $seenSites -cnotcontains $_ })
            if ($finalToday -and $newSites.Count) {
                $allSites = @($seenSites + $actionSites | Sort-Object -Unique)
                $text = "签到需处理 $($newSites.Count) 个站点"
                foreach ($task in $actionTasks) {
                    if ($newSites -ccontains (Get-DigestHash ([string]$task.origin))) { $text += "`n• $(Get-DigestSiteName $task)：需要人工恢复，详见面板" }
                }
                $events.Add([pscustomobject]@{eventKey="$prefix`:action_needed:$(Get-DigestHash ($allSites -join '|'))";status='needs_attention';summary=(Limit-DigestText $text);sites=$allSites;category='action_needed'})
            }
            $text = "签到日报 $($shanghaiNow.ToString('MM-dd'))`n有效 $($verdict.total)：已完成 $($c.done)，核验中 $($c.verifying)，需处理 $($c.actionNeeded)`n外部阻断 $($c.external) · 已暂停 $($c.paused) · 无此功能 $($c.noFeature)"
            if ($notificationView.verdictScope -eq 'regular_tasks') { $text += "`n仅主任务口径，观测范围待同步" }
            if ($actionTasks.Count) {
                $text += "`n`n需处理"
                foreach ($task in $actionTasks) {
                    $reason = if ($task.failureCode -eq 'two_factor_required') { '二次验证待重新授权' } elseif ($task.observedStatus -eq 'interactive_challenge') { '需要人工验证' } else { '登录或执行待人工恢复' }
                    $text += "`n• $(Get-DigestSiteName $task)：$reason"
                }
            }
            if ($notificationView.longUnsettled -gt 0) { $text += "`n`n长期未结 $($notificationView.longUnsettled) 个，详见面板" }
            $payload.summary = Limit-DigestText $text
            $payload.eventKey = $prefix
            if ($finalToday -and $shanghaiNow.TimeOfDay -ge $digestAt -and
                ($notificationView.verdictScope -eq 'authorized_workload' -or
                    ($notificationView.verdictScope -eq 'regular_tasks' -and $shanghaiNow.TimeOfDay -ge $missingAfter))) {
                $events.Add([pscustomobject]@{eventKey=$prefix;status=$payload.status;summary=$payload.summary;category='daily_digest'})
            }
        }
        $scheduler = $null
        try { $scheduler = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'data/scheduler-state.json') | ConvertFrom-Json } catch { }
        $noRetry = $scheduler.lastAttemptDate -ceq $businessDate -and $scheduler.phase -eq 'finished' -and
            $null -ne $scheduler.automaticRetryCount -and [int]$scheduler.automaticRetryCount -eq 0 -and
            -not $scheduler.nextEligibleAt -and
            @($results | Where-Object { $_.nextEligibleAt -and ([datetimeoffset]$_.nextEligibleAt).ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -eq $businessDate }).Count -eq 0
        if ($report.finishedAt) {
            $noRetry = $noRetry -and $scheduler.lastFinishedAt -and
                ([datetimeoffset]$scheduler.lastFinishedAt) -ge ([datetimeoffset]$report.finishedAt)
        }
        $failed = $RunnerStatus -in @('failed','timeout') -or ($scheduler.lastAttemptDate -ceq $businessDate -and
            $scheduler.phase -eq 'finished' -and $null -ne $scheduler.lastExitCode -and [int]$scheduler.lastExitCode -notin @(0,2))
        if ($failed -and $noRetry) {
            $events.Add([pscustomobject]@{eventKey="$prefix`:run_failed:once";status='failed';summary='签到主运行失败，今天没有后续自动重试，详见面板。';category='run_failed'})
        }
        if ($notificationView.identityConflict -eq $true) {
            $events.Add([pscustomobject]@{eventKey="$prefix`:identity_conflict:once";status='needs_attention';summary='签到回执存在身份冲突，请核对账号与重复提交风险。';category='identity_conflict'})
        }
        if ($CheckRunMissing -and $shanghaiNow.TimeOfDay -ge $missingAfter -and -not $finalToday) {
            $events.Add([pscustomobject]@{eventKey="$prefix`:run_missing:once";status='needs_attention';summary='今天尚未收到签到最终报告，请检查主运行。';category='run_missing'})
        }
        $newEvents = @($events | Where-Object { $existingItems.eventKey -cnotcontains $_.eventKey })
        $payload.policy='daily_digest'; $payload.accepted=$false; $payload.enqueued=$false
        $payload.deferred=$newEvents.Count -eq 0; $payload.preview=[bool]$Preview
        $payload.events=@($newEvents | ForEach-Object { [pscustomobject]@{eventKey=$_.eventKey;status=$_.status;summary=$_.summary;category=$_.category} })
        if ($Preview -or $mode -eq 'none') { return $payload }
        if ($mode -ne 'command') { throw "不支持的通知模式：$mode" }
        if ($newEvents.Count) {
            [IO.Directory]::CreateDirectory($OutboxPath) | Out-Null
            foreach ($event in $newEvents) { Write-DigestOutboxItem $event | Out-Null }
            $payload.enqueued=$true
        }
        $payload
    } finally {
        if ($held) { $mutex.ReleaseMutex() }
        $mutex.Dispose()
    }
}
