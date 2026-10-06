[CmdletBinding()]
param([switch]$Once, [switch]$ForceSync, [string]$OpsRootOverride = '')

$ErrorActionPreference = 'Stop'
if ($ForceSync -and -not $Once) { throw 'ForceSync requires Once' }
$opsRoot = if ($OpsRootOverride) { [IO.Path]::GetFullPath($OpsRootOverride) } else { Split-Path -Parent $PSScriptRoot }
$configPath = Join-Path $opsRoot 'config\config.json'
$statePath = Join-Path $opsRoot 'outputs\scheduler-state.json'
$heartbeatPath = Join-Path $opsRoot 'outputs\scheduler-heartbeat.json'
$logPath = Join-Path $opsRoot 'logs\scheduler.log'
$syncScript = Join-Path $PSScriptRoot 'Sync-NasShadow.ps1'
$hiddenLauncher = Join-Path $opsRoot 'scripts/Run-HiddenPowerShell.vbs'
$wscript = (Get-Command wscript.exe -ErrorAction Stop).Source
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $statePath)) | Out-Null
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $logPath)) | Out-Null

function Write-AtomicJson([string]$Path, [object]$Value) {
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
    if ([System.IO.File]::Exists($Path)) {
        $backup = "$Path.$([guid]::NewGuid().ToString('N')).bak"
        [System.IO.File]::Replace($temporary, $Path, $backup, $true)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
    else { [System.IO.File]::Move($temporary, $Path) }
}

function Write-SchedulerLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" -Encoding UTF8
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return [pscustomobject]@{} }
    try { return Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json }
    catch { return [pscustomobject]@{} }
}

function Convert-StateToMap([object]$State) {
    $map = [ordered]@{}
    if ($State) {
        foreach ($property in $State.PSObject.Properties) { $map[$property.Name] = $property.Value }
    }
    return $map
}

function Write-Heartbeat([string]$Phase) {
    Write-AtomicJson $heartbeatPath ([ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o'); phase = $Phase })
}

function Get-CurrentFinalResultFingerprint([string]$LegacyRoot) {
    $latestPath = Join-Path $LegacyRoot 'logs\latest.json'
    if (-not (Test-Path -LiteralPath $latestPath -PathType Leaf)) { return $null }
    try {
        $latest = Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json
        if ([string]$latest.runState -ne 'final' -or $latest.isComplete -ne $true) { return $null }
        if ([string]$latest.runId -notlike "$(Get-Date -Format 'yyyyMMdd')-*") { return $null }
        return (Get-FileHash -Algorithm SHA256 -LiteralPath $latestPath).Hash.ToLowerInvariant()
    }
    catch { return $null }
}

function Get-ObservationPublicationFingerprint([string]$ProjectRoot) {
    return (Get-ChildItem -LiteralPath (Join-Path $ProjectRoot 'outputs') -File |
        Where-Object Name -Match '^(canary-result-|canary-observation-|notification-notice_|migration-|pt-fallback-results-|pt-evidence-repair-dirty-)' |
        Sort-Object Name | ForEach-Object { "$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }) -join '|'
}

function Get-PendingEvidenceMarkers([string]$ProjectRoot) {
    $outputRoot = Join-Path $ProjectRoot 'outputs'
    if (-not (Test-Path -LiteralPath $outputRoot -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $outputRoot -File -Filter 'pt-evidence-repair-dirty-*.json' -ErrorAction SilentlyContinue |
        Where-Object Name -Match '^pt-evidence-repair-dirty-\d{4}-\d{2}-\d{2}\.json$' |
        Sort-Object Name)
}


$created = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\CodexCheckinFabricV2NasShadowScheduler', [ref]$created)
if (-not $created) { exit 0 }
try {
    Write-SchedulerLog "Scheduler started (PID=$PID)."
    while ($true) {
        try {
            Write-Heartbeat 'idle'
            $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
            . (Join-Path ([string]$config.v2ProjectRoot) 'scripts/Sync-OperationsSupport.ps1')
            if ([string]$config.dailyTime -notmatch '^([01]\d|2[0-3]):[0-5]\d$') { throw 'dailyTime is invalid' }
            $now = Get-Date
            $scheduled = [datetime]::ParseExact("$($now.ToString('yyyy-MM-dd')) $($config.dailyTime)", 'yyyy-MM-dd HH:mm', $null)
            $state = Read-State
            $newState = Convert-StateToMap $state
            $stateChanged = $false
            $normalSyncAttempted = $false
            $normalSyncSucceeded = $false
            $retryAt = try { [datetime]$state.nextRetryAt } catch { $null }
            $sourceFingerprint = Get-CurrentFinalResultFingerprint ([string]$config.legacyRoot)
            $sourceChanged = $sourceFingerprint -and [string]$state.lastSourceFingerprint -ne $sourceFingerprint
            $v2Fingerprint = Get-ObservationPublicationFingerprint ([string]$config.v2ProjectRoot)
            $v2Changed = [string]$state.lastV2Fingerprint -ne $v2Fingerprint
            $dailyDue = $now -ge $scheduled -and [string]$state.lastSuccessDate -ne $now.ToString('yyyy-MM-dd')
            $monitorEnabled = Test-Path -LiteralPath (Join-Path $opsRoot 'config\pt-monitor.local.json')
            $lastSyncAt = try { [datetime]$state.lastSuccessAt } catch { [datetime]::MinValue }
            $monitorDue = $monitorEnabled -and ($now - $lastSyncAt).TotalMinutes -ge 30
            $due = $sourceChanged -or $v2Changed -or $dailyDue -or $monitorDue
            if ($ForceSync -or ($due -and ($null -eq $retryAt -or $now -ge $retryAt))) {
                $normalSyncAttempted = $true
                Write-Heartbeat 'syncing'
                $trigger = if ($ForceSync) { 'manual_sync' } elseif ($sourceChanged) { 'final_result_changed' } elseif ($v2Changed) { 'v2_status_changed' } elseif ($dailyDue) { 'daily_fallback' } else { 'pt_observation_refresh' }
                Write-SchedulerLog "Starting shadow sync (trigger=$trigger)."
                try {
                $shell = (Get-Command pwsh.exe,powershell.exe,pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                if (-not $shell) { throw 'PowerShell executable was not found' }
                $arguments = @(
                    # The VBS launcher supplies PowerShell host switches and -File.
                    '-LegacyRoot', [string]$config.legacyRoot,
                    '-ProjectRoot', [string]$config.v2ProjectRoot,
                    '-OpsRoot', $opsRoot,
                    '-SshTarget', [string]$config.sshTarget
                )
                $quoteArgument = {
                    param([object]$value)
                    '"' + ([string]$value -replace '"', '""') + '"'
                }
                $launcherArguments = @(
                    '//B', '//NoLogo',
                    (& $quoteArgument $hiddenLauncher),
                    (& $quoteArgument $shell),
                    (& $quoteArgument $syncScript),
                    (& $quoteArgument $opsRoot)
                ) + @($arguments | ForEach-Object { & $quoteArgument $_ })
                $process = $null
                $syncExitCode = 1
                $syncFailureCause = 'process_start_failed'
                try {
                    $process = Start-Process -FilePath $wscript -ArgumentList $launcherArguments -WindowStyle Hidden -PassThru
                    if (-not $process.WaitForExit(300000)) {
                        try { $process.Kill($true) } catch {
                            try { & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null } catch { try { $process.Kill() } catch { } }
                        }
                        $syncExitCode = 124
                        $syncFailureCause = 'sync_timeout'
                    } else {
                        $syncExitCode = $process.ExitCode
                        $syncFailureCause = if ($syncExitCode -eq 0) { '' } else { 'sync_command_failed' }
                    }
                } catch {
                    $syncExitCode = 1
                    $syncFailureCause = 'process_start_or_wait_failed'
                } finally {
                    if ($process) { try { $process.Dispose() } catch { } }
                }
                } catch {
                    $syncExitCode = 1
                    $syncFailureCause = 'process_start_or_wait_failed'
                }
                $normalSyncSucceeded = $syncExitCode -eq 0
                $publishedFingerprint = if ($normalSyncSucceeded) {
                    Get-ObservationPublicationFingerprint ([string]$config.v2ProjectRoot)
                } else { $v2Fingerprint }
                Set-SyncAttemptOutcome $newState $state $syncExitCode (Get-Date) ([string]$config.dailyTime) $sourceFingerprint $publishedFingerprint $syncFailureCause
                Write-Heartbeat $(if ($syncExitCode -eq 0) { 'idle' } else { 'error' })
                # Persist the sync outcome before any notification or worker can block.
                Write-AtomicJson $statePath $newState
                $stateChanged = $false
            }
            if (Invoke-PendingNotification $newState ([string]$config.legacyRoot) (Get-Date)) { $stateChanged = $true }
            $operationWorker = Join-Path ([string]$config.v2ProjectRoot) 'scripts/Invoke-DashboardOperations.ps1'
            if (Test-Path -LiteralPath $operationWorker) {
                try { & $operationWorker -ProjectRoot ([string]$config.v2ProjectRoot) -SshTarget ([string]$config.sshTarget) | Out-Null }
                catch { Write-SchedulerLog 'Dashboard operation worker deferred; scheduled check-ins remain independent.' }
            }
            $dryWorkerDispatch = Join-Path $opsRoot 'scripts/Invoke-DryWorkerIfDue.ps1'
            $evidenceWorker = Join-Path ([string]$config.v2ProjectRoot) 'scripts/Invoke-PtEvidenceRepair.ps1'
            $beforeEvidence = Get-ObservationPublicationFingerprint ([string]$config.v2ProjectRoot)
            if (Test-Path -LiteralPath $evidenceWorker) {
                try { & $evidenceWorker -ProjectRoot ([string]$config.v2ProjectRoot) -CatalogFile (Join-Path $opsRoot 'tmp/nas-sync/pt-monitor-catalog.json') -MaxSites 2 | Out-Null }
                catch { Write-SchedulerLog 'Passive evidence review deferred; no check-in was resubmitted.' }
            }
            $afterEvidence = Get-ObservationPublicationFingerprint ([string]$config.v2ProjectRoot)
            # Publish a completed passive read in the same scheduler turn. No
            # check-in fallback is queued by this second, observation-only pass.
            $dirtyMarkers = Get-PendingEvidenceMarkers ([string]$config.v2ProjectRoot)
            # A failed normal sync has already scheduled its bounded retry. Do
            # not run a second SSH publication in the same turn for evidence.
            $currentRetryAt = try { [datetime]$newState.nextRetryAt } catch { $null }
            $evidenceRetryAllowed = -not $normalSyncAttempted -or $normalSyncSucceeded
            if (($afterEvidence -ne $beforeEvidence -or $dirtyMarkers.Count -gt 0) -and $evidenceRetryAllowed -and
                ($ForceSync -or $null -eq $currentRetryAt -or (Get-Date) -ge $currentRetryAt)) {
                try {
                    $shell = (Get-Command pwsh.exe,powershell.exe,pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
                    if (-not $shell) { throw 'PowerShell executable was not found' }
                    $syncArguments = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$syncScript,
                        '-LegacyRoot',[string]$config.legacyRoot,'-ProjectRoot',[string]$config.v2ProjectRoot,
                        '-OpsRoot',$opsRoot,'-SshTarget',[string]$config.sshTarget,'-SkipHarvestFallback')
                    $afterRepairSync = Invoke-BoundedSyncProcess $shell $syncArguments 'evidence_dashboard_sync' '' 180
                    $previousSyncState = [pscustomobject]$newState
                    if ($afterRepairSync.exitCode -eq 0) {
                        # Remove every dated marker only after this publication
                        # completes. A prior-day marker must not disappear at
                        # midnight before its ledger is uploaded.
                        foreach ($marker in (Get-PendingEvidenceMarkers ([string]$config.v2ProjectRoot))) {
                            Remove-Item -LiteralPath $marker.FullName -Force -ErrorAction SilentlyContinue
                        }
                    }
                    $publishedEvidenceFingerprint = Get-ObservationPublicationFingerprint ([string]$config.v2ProjectRoot)
                    Set-SyncAttemptOutcome $newState $previousSyncState $afterRepairSync.exitCode (Get-Date) ([string]$config.dailyTime) $sourceFingerprint $publishedEvidenceFingerprint $(if ($afterRepairSync.exitCode -eq 0) { '' } else { 'evidence_dashboard_sync_failed' })
                    $stateChanged = $true
                } catch {
                    Write-SchedulerLog 'Passive receipt saved; its bounded dashboard publication will retry later.'
                    $failedAt = Get-Date
                    $previousSyncState = [pscustomobject]$newState
                    Set-SyncAttemptOutcome $newState $previousSyncState 1 $failedAt ([string]$config.dailyTime) $sourceFingerprint $afterEvidence 'evidence_dashboard_sync_failed'
                    $stateChanged = $true
                }
            }
            if (Test-Path -LiteralPath $dryWorkerDispatch) {
                try { & $dryWorkerDispatch -OpsRoot $opsRoot | Out-Null }
                catch { Write-SchedulerLog 'Dry worker dispatch failed; V1 and shadow sync unaffected.' }
            }
            if ($stateChanged) { Write-AtomicJson $statePath $newState }
        }
        catch {
            Write-SchedulerLog "Recoverable scheduler error: $($_.Exception.Message)"
            Write-Heartbeat 'error'
        }
        if ($Once) { break }
        Start-Sleep -Seconds 60
    }
}
finally {
    try { Write-SchedulerLog "Scheduler stopped (PID=$PID)." } catch { }
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
