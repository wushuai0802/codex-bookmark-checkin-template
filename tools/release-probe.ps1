[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ExecutionRoot,
    [Parameter(Mandatory)][string]$ObservationRoot,
    [string]$OpsRoot,
    [switch]$NoOps,
    [Parameter(Mandatory)][string]$TaskNamesJson,
    [int]$CallerPid = 0
)
# Read only. Never dot-source a runtime script, invoke a worker, or change a
# scheduled task. Error messages and projections intentionally omit paths,
# command lines, site/account identities and raw report bodies.
$ErrorActionPreference = 'Stop'
if ([bool]$OpsRoot -eq [bool]$NoOps) { throw 'Specify OpsRoot or NoOps' }
$captured = [datetimeoffset]::UtcNow
$today = $captured.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
$jsonOptions = @{}
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $jsonOptions.DateKind = 'String' }

function Has($Value, [string]$Name) {
    return $null -ne $Value -and $null -ne $Value.PSObject.Properties[$Name]
}
function Require([bool]$Condition) { if (-not $Condition) { throw 'fields_missing' } }
function Exists([string]$File) {
    try { $null = Get-Item -LiteralPath $File -ErrorAction Stop; return $true }
    catch {
        if ($_.CategoryInfo.Category -eq 'ObjectNotFound') { return $false }
        throw 'read_failed'
    }
}
function Read-Json([string]$File) {
    if (-not (Exists $File)) { throw 'missing' }
    try { $text = [IO.File]::ReadAllText($File) } catch { throw 'read_failed' }
    try { $value = ConvertFrom-Json -InputObject $text @jsonOptions -ErrorAction Stop } catch { throw 'invalid_json' }
    if ($null -eq $value) { throw 'fields_missing' }
    return $value
}
function Capture([scriptblock]$Read) {
    try { return @{ ok = $true; value = (& $Read) } }
    catch {
        $code = [string]$_.Exception.Message
        if ($code -notin @('missing','invalid_json','read_failed','fields_missing','unavailable')) { $code = 'read_failed' }
        return @{ ok = $false; error = $code }
    }
}
function Timestamp($Value) {
    if ($null -eq $Value) { return $null }
    try { return ([datetimeoffset]$Value).ToUniversalTime().ToString('o') } catch { return 'invalid' }
}
function Day($Value) {
    try { return ([datetimeoffset]$Value).ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') } catch { throw 'fields_missing' }
}
function Project($Value, [string[]]$Fields) {
    $result = [ordered]@{}
    foreach ($field in $Fields) {
        if (-not (Has $Value $field)) { continue }
        $item = $Value.$field
        if (($field -match '(?:At|Date|RunId|runId)$' -or $field -eq 'time') -and $null -ne $item) {
            if ($field -match 'At$' -or $field -eq 'time') { $item = Timestamp $item }
            elseif ([string]$item -notmatch '^[0-9TZ:.+\-a-f]+$') { $item = 'invalid' }
        }
        elseif ($item -is [string] -and $item -notmatch '^[A-Za-z0-9_-]{1,100}$') { $item = 'invalid' }
        elseif ($null -ne $item -and $item -isnot [string] -and $item -isnot [bool] -and $item -isnot [ValueType]) { $item = 'invalid' }
        $result[$field] = $item
    }
    return $result
}
function Monitor {
    if (-not $OpsRoot) { throw 'unavailable' }
    $file = Join-Path $OpsRoot 'config/pt-monitor.local.json'
    if (-not (Exists $file)) { return @{ enabled = $false } }
    $config = Read-Json $file
    Require (Has $config 'harvestDatabase')
    Require ($config.harvestDatabase -is [string] -and $config.harvestDatabase.Length -gt 0)
    return @{ enabled = $true }
}
function Observation { return Read-Json (Join-Path $ObservationRoot 'outputs/shadow-beta-snapshot.json') }
function Previous-Evidence($State, $Origin, $AccountKey) {
    $key = if ($AccountKey -eq 'site-default') { $Origin } else { $Origin + '#account=' + [uri]::EscapeDataString($AccountKey) }
    $old = $State.sites.PSObject.Properties[$key]
    if ($null -eq $old) { return $null }
    $value = Project $old.Value @('businessDate','attempts','wakeups','totalAttempts','nextAttemptAt')
    if (-not $value.Contains('totalAttempts')) { $value.totalAttempts = $value.attempts }
    return @{ raw = $old.Value; summary = $value }
}
function Harvest-Confirmed($Snapshot, $Task) {
    $matching = @($Snapshot.ptStatus.sites | Where-Object { $_.origin -eq $Task.origin -and $_.accountRef -eq $Task.accountRef })
    if (-not ($Task.accountRef -is [string]) -or $Task.accountRef -notmatch '^[A-Za-z0-9_-]{1,80}$' -or $matching.Count -ne 1) { return $false }
    $e = $matching[0].effective
    return $e.source -eq 'harvest' -and $e.status -in @('signed','already_signed') -and $e.fresh -eq $true -and
        $e.authoritative -eq $true -and $e.evidence.source -eq 'harvest' -and $e.evidence.authoritative -eq $true -and
        $e.evidence.statusVerified -eq $true -and $e.evidence.businessDate -eq $Snapshot.businessDate -and
        $null -ne $e.observedAt -and (Day $e.observedAt) -eq $Snapshot.businessDate -and ([datetimeoffset]$e.observedAt) -le $captured.AddMinutes(1)
}

$tasks = Capture {
    $names = ConvertFrom-Json -InputObject $TaskNamesJson
    Require ((Has $names 'main') -and (Has $names 'sync'))
    $values = @(
        foreach ($property in $names.PSObject.Properties) {
            Require ($property.Name -match '^[a-z][a-z0-9_]{0,30}$' -and $property.Value -is [string])
            $task = Get-ScheduledTask -TaskName $property.Value -ErrorAction Stop
            $info = Get-ScheduledTaskInfo -TaskName $property.Value -ErrorAction Stop
            $xml = Export-ScheduledTask -TaskName $property.Value -ErrorAction Stop
            Require (@($task).Count -eq 1 -and @($info).Count -eq 1 -and $xml -is [string] -and $xml.Length -gt 0)
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-','').ToLowerInvariant() }
            finally { $sha.Dispose() }
            @{ role = $property.Name; state = [string]$task.State; definitionHash = $hash;
                lastRun = Timestamp $info.LastRunTime; lastResult = $info.LastTaskResult;
                nextRunMs = ([datetimeoffset]$info.NextRunTime).ToUnixTimeMilliseconds() }
        }
    )
    return ,$values
}
$processes = Capture {
    $roles = [Collections.Generic.List[string]]::new()
    $unreadable = 0
    $roots = @($ExecutionRoot,$ObservationRoot,$OpsRoot | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\','/') })
    $workers = '(?i)(Start-UserScheduler|Run-Checkin|Sync-NasShadow|Start-NasShadowScheduler|Invoke-PtEvidenceRepair|Invoke-DashboardOperations|Run-DryWorker)\.ps1|(run-v1-engine|harvest-fallback|reconcile-pt-evidence|process-dashboard-operations|Run-PtSupplement|worker-once)\.mjs'
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='chrome.exe' OR Name='python.exe'" -ErrorAction Stop)) {
        if ($process.ProcessId -eq $PID -or $process.ProcessId -eq $CallerPid) { continue }
        # Same-user elevated processes can hide CommandLine. Our scheduled
        # tasks run Limited, so project workers remain readable; apply holds
        # the runtime locks that enforce mutual exclusion.
        if ($null -eq $process.CommandLine) { $unreadable++; continue }
        $line = [string]$process.CommandLine
        $bound = @($roots | Where-Object { $line.IndexOf($_,[StringComparison]::OrdinalIgnoreCase) -ge 0 -or $line.IndexOf($_.Replace('\','/'),[StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0
        if ($bound -or $line -match $workers) {
            $role = if ($process.Name -eq 'chrome.exe') { 'project_browser' } elseif ($line -match 'Evidence|evidence') { 'evidence_worker' }
                elseif ($line -match 'Shadow|shadow') { 'sync_worker' } else { 'project_worker' }
            $roles.Add($role)
        }
    }
    return @{ count = $roles.Count; roles = @($roles | Sort-Object -Unique); unreadable = $unreadable }
}
$lifecycle = Capture { @{ exists = Exists (Join-Path $ObservationRoot 'data/pt-worker-lifecycle.json') } }
$manual = Capture {
    $values = @(
        foreach ($relative in @('tmp/manual-handoff.json','tmp/manual-verification.json','tmp/manual-session.json')) {
            $file = Join-Path $ExecutionRoot $relative
            if (-not (Exists $file)) { @{ exists = $false }; continue }
            $value = Read-Json $file
            Require ((Has $value 'state') -and $value.state -is [string])
            $active = $false
            if ($null -ne $value.pid) {
                Require ($value.pid -is [ValueType] -and $value.pid -gt 0 -and [long]$value.pid -eq $value.pid)
                # Get-Process does not change or signal the target process.
                try { $active = $null -ne (Get-Process -Id $value.pid -ErrorAction Stop) }
                catch { if ($_.CategoryInfo.Category -ne 'ObjectNotFound') { throw 'read_failed' } }
            }
            @{ exists = $true; state = (Project $value @('state')).state; pidActive = $active }
        }
    )
    return ,$values
}
$finalReport = Capture {
    $raw = Read-Json (Join-Path $ExecutionRoot 'logs/latest.json')
    $value = Project $raw @('runId','runState','isComplete','executionComplete','finishedAt','nextRetryAt')
    if (Has $raw 'results') {
        Require ($raw.results -is [array])
        $value.results = @($raw.results | ForEach-Object { Project $_ @('status','retryable','submissionAttempted','retryExhaustedForDay','nextEligibleAt') })
    }
    return $value
}
$scheduler = Capture {
    Project (Read-Json (Join-Path $ExecutionRoot 'data/scheduler-state.json')) @('phase','lastAttemptDate','lastRunId','reportValid','reportExecutionComplete','automaticRetryCount','nextEligibleAt')
}
$harvest = Capture {
    $monitor = Monitor
    if (-not $monitor.enabled) { return @{ enabled = $false } }
    $raw = Read-Json (Join-Path $OpsRoot 'tmp/nas-sync/harvest-pt-status.json')
    $snapshot = Observation
    Require ($raw.source -eq 'harvest' -and (Has $raw 'taskCompletion') -and (Has $snapshot.ptStatus 'harvestWindow') -and $snapshot.businessDate -eq $today)
    $value = Project $raw @('businessDate','generatedAt')
    $value.enabled = $true
    $value.taskCompletion = Project $raw.taskCompletion @('resultId','status','activeTaskCount','activityCoverage','startedAt','completedAt')
    # Only existence/phase is needed. Never emit an origin from harvestWindow.
    $value.harvestWindow = if ($null -eq $snapshot.ptStatus.harvestWindow) { $null } else { @{ phase = 'unsettled' } }
    return $value
}
$evidence = Capture {
    $monitor = Monitor
    if (-not $monitor.enabled) { return @{ enabled = $false } }
    $snapshot = Observation
    $catalog = Read-Json (Join-Path $OpsRoot 'tmp/nas-sync/pt-monitor-catalog.json')
    $state = Read-Json (Join-Path $ObservationRoot 'data/pt-evidence-repair.json')
    Require ($snapshot.tasks -is [array] -and $snapshot.receipts -is [array] -and $snapshot.ptStatus.sites -is [array] -and $catalog.sites -is [array] -and (Has $state 'sites'))
    $candidates = @{}
    $origins = @($catalog.sites | ForEach-Object { Require ($_.origin -is [string]); $_.origin })
    foreach ($task in $snapshot.tasks) {
        Require ($task.origin -is [string] -and $task.observedStatus -is [string] -and $task.taskId -is [string])
        $review = $task.observedStatus -eq 'needs_attention' -and $task.failureCode -eq 'submission_outcome_unknown' -and $task.submissionAttempted -eq $true
        $positive = $task.observedStatus -in @('signed','already_signed')
        $receipt = @($snapshot.receipts | Where-Object { $_.taskId -eq $task.taskId -and $_.evidence.authoritative -eq $true }).Count -gt 0
        if ($task.origin -notin $origins -or (-not $positive -and -not $review) -or $receipt -or (Harvest-Confirmed $snapshot $task)) { continue }
        $account = if ($task.accountKey) { $task.accountKey } else { 'site-default' }
        $old = Previous-Evidence $state $task.origin $account
        $key = $task.origin + '|' + $account
        $candidates[$key] = @{ ptOnly = $false; changedReview = $false; previous = if ($old) { $old.summary } else { $null } }
    }
    foreach ($site in $snapshot.ptStatus.sites) {
        Require ($site.origin -is [string] -and $site.capabilities.read -is [bool])
        $e = $site.effective
        $uncertain = $e.failureCode -eq 'submission_outcome_unknown' -or ($e.submissionAttempted -eq $true -and $e.status -notin @('signed','already_signed'))
        if ($site.inLegacyPlan -or -not $site.fallbackEnabled -or $site.disabledByConfig -or $site.origin -notin $origins -or -not $site.capabilities.read -or
            $site.evidenceState -eq 'external_blocked' -or $e.fresh -ne $true -or -not $uncertain) { continue }
        Require ($null -ne $e.observedAt)
        if ((Day $e.observedAt) -ne $today -or $captured - ([datetimeoffset]$e.observedAt) -lt [timespan]::FromMinutes(1)) { continue }
        $key = $site.origin + '|site-default'
        if ($candidates.ContainsKey($key)) { continue }
        $old = Previous-Evidence $state $site.origin 'site-default'
        $sameReview = $false
        if ($null -ne $old -and $old.raw.reviewKey -is [string] -and $old.raw.reviewKey.Contains('|')) {
            $parts = $old.raw.reviewKey.Split(@('|'),2,[StringSplitOptions]::None)
            $sameReview = (Timestamp $parts[0]) -eq (Timestamp $e.observedAt) -and $parts[1] -eq [string]$e.evidence.profileBinding
        }
        $changed = $null -ne $old -and $old.raw.businessDate -eq $today -and -not $sameReview -and
            ([datetimeoffset]$e.observedAt) -gt ([datetimeoffset]$old.raw.checkedAt)
        $candidates[$key] = @{ ptOnly = $true; changedReview = $changed; previous = if ($old) { $old.summary } else { $null } }
    }
    return @{ enabled = $true; businessDate = $snapshot.businessDate; candidates = @($candidates.Values);
        dirtyMarkerPresent = Exists (Join-Path $ObservationRoot "outputs/pt-evidence-repair-dirty-$today.json") }
}
$fallback = Capture {
    $monitor = Monitor
    if (-not $monitor.enabled) { return @{ pending = @() } }
    $raw = Read-Json (Join-Path $ObservationRoot "outputs/harvest-fallback-attempts-$today.json")
    Require ($raw.businessDate -eq $today -and $raw.attempts -is [array])
    # Audits are append-only: an old busy/preflight entry must not keep an
    # already completed attempt pending. Group only in memory; omit identities.
    $deferred = @('deferred_busy','deferred_preflight')
    $pending = @(
        $receiptFile = Join-Path $ObservationRoot "outputs/pt-fallback-results-$today.json"
        if (Exists $receiptFile) {
            $receipts = Read-Json $receiptFile
            Require ($receipts.businessDate -eq $today -and $receipts.sites -is [array])
            foreach ($site in $receipts.sites) {
                if ($site.status -eq 'not_signed' -and $site.submissionAttempted -eq $false -and $site.evidence.authoritative -eq $true) {
                    Require ($null -ne $site.evidence.confirmedAt)
                    $confirmed = [datetimeoffset]$site.evidence.confirmedAt
                    # A fresh unsigned proof can reopen the passive fallback
                    # budget. Without recomputing its private candidate scope,
                    # refuse even if the ordinary audit budget is exhausted.
                    if ((Day $confirmed) -eq $today -and $confirmed -le $captured -and $captured - $confirmed -le [timespan]::FromHours(1)) {
                        @{ kind = 'unsettled_unsigned_wakeup' }
                    }
                }
            }
        }
        foreach ($kind in @('attempts','verifications')) {
            $entries = @($raw.$kind | Where-Object { $null -ne $_ })
            foreach ($entry in $entries) { Require ($entry.origin -is [string] -and $entry.state -is [string]) }
            $groups = @($entries | Group-Object { $_.origin + '|' + $(if ($_.accountKey) { $_.accountKey } else { 'site-default' }) })
            foreach ($group in $groups) {
                $items = @($group.Group)
                if (@($items | Where-Object state -eq 'in_progress').Count) { @{ kind = 'active_fallback' }; continue }
                $used = @($items | Where-Object { $_.state -notin $deferred }).Count
                $busy = @($items | Where-Object { $_.state -in $deferred }).Count
                if ($used -ge 3 -or ($kind -eq 'verifications' -and $busy -ge 24)) { continue }
                if ($kind -eq 'attempts') {
                    foreach ($entry in $items) {
                        $waiting = $entry.state -in @('completed','deferred_preflight') -and $entry.submissionState -eq 'not_submitted' -and $entry.harvestWakeup -ne $true -and
                            ($entry.v1Status -eq 'deferred' -or $entry.outcome.retryCause -eq 'harvest_waiting' -or $entry.outcome.failureCode -eq 'harvest_waiting')
                        if ($waiting -and ($null -eq $entry.nextEligibleAt -or (Day $entry.nextEligibleAt) -le $today)) { @{ kind = 'harvest_wakeup' } }
                    }
                }
                $latest = $items[-1]
                if ($latest.state -in $deferred) {
                    Require ($null -ne $latest.nextEligibleAt)
                    if ((Day $latest.nextEligibleAt) -le $today) { @{ kind = 'scheduled_fallback' } }
                }
                elseif ($kind -eq 'verifications' -and $latest.outcome.status -notin @('signed','already_signed')) {
                    # Completed candidates no longer enter preview.eligible.
                    # Only close the passive budget; activity and wakeups above
                    # must still block even when completion is already known.
                    $account = if ($latest.accountKey) { $latest.accountKey } else { 'site-default' }
                    $completed = @($raw.attempts | Where-Object {
                        $_.origin -eq $latest.origin -and $(if ($_.accountKey) { $_.accountKey } else { 'site-default' }) -eq $account -and
                        $_.state -eq 'completed' -and $_.outcome.status -in @('signed','already_signed')
                    }).Count -gt 0
                    if ($completed) { continue }
                    $snapshot = Observation
                    Require ($snapshot.ptStatus.sites -is [array])
                    $matching = @($snapshot.ptStatus.sites | Where-Object { $_.origin -eq $latest.origin })
                    if ($matching.Count -eq 1) {
                        $effective = $matching[0].effective
                        if ($effective.status -in @('signed','already_signed') -and $effective.authoritative -eq $true -and $effective.fresh -eq $true -and
                            $null -ne $effective.observedAt -and (Day $effective.observedAt) -eq $today) { continue }
                    }
                    # Without a remaining candidate proof, an unused passive
                    # budget cannot be declared settled from its status alone.
                    Require ($null -ne $latest.startedAt)
                    if ((Day (([datetimeoffset]$latest.startedAt).AddMinutes(30))) -le $today) { @{ kind = 'unsettled_passive_fallback_budget' } }
                }
            }
        }
    )
    return @{ pending = $pending }
}
$notifications = Capture {
    $directory = Join-Path $ExecutionRoot 'data/notification-outbox'
    if (-not (Exists $directory)) { throw 'missing' }
    $items = @(
        foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter '*.json' -File -ErrorAction Stop)) {
            Project (Read-Json $file.FullName) @('delivered')
        }
    )
    return ,$items
}
$markers = Capture {
    $value = @{}
    $roots = @{ execution = $ExecutionRoot; observation = $ObservationRoot }
    if ($OpsRoot) { $roots.operations = $OpsRoot }
    foreach ($role in $roots.Keys) { $value[$role] = Project (Read-Json (Join-Path $roots[$role] 'release.json')) @('revision','deployedAt') }
    return $value
}
$gatewayEvents = Capture {
    $directory = Join-Path $ExecutionRoot 'data'
    if (-not (Exists $directory)) { throw 'missing' }
    $events = @(
        foreach ($file in @(Get-ChildItem -LiteralPath $directory -Filter 'gateway-events.jsonl*' -File -ErrorAction Stop)) {
            foreach ($line in [IO.File]::ReadLines($file.FullName)) {
                if (-not $line.Trim()) { continue }
                try { $event = ConvertFrom-Json -InputObject $line @jsonOptions -ErrorAction Stop } catch { throw 'invalid_json' }
                Project $event @('time')
            }
        }
    )
    return ,$events
}
@{ schemaVersion = 1; capturedAt = $captured.ToString('o'); tasks = $tasks; processes = $processes; lifecycle = $lifecycle;
    manualSessions = $manual; finalReport = $finalReport; scheduler = $scheduler; harvest = $harvest; evidence = $evidence;
    fallback = $fallback; notifications = $notifications; markers = $markers; gatewayEvents = $gatewayEvents } | ConvertTo-Json -Depth 20 -Compress
