[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$LegacyRoot,
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,
    [string]$OpsRoot,
    [string]$SshTarget = 'nas-checkin',
    [string]$NasStagingDir = '/volume3/docker/checkin-fabric-v2/.shadow-sync-stage',
    [string]$NasDataDir = '/volume3/docker/checkin-fabric-v2/nas-data',
    [string]$NodePath,
    [switch]$SkipHarvestFallback,
    [switch]$NoUpload
)

$ErrorActionPreference = 'Stop'

function Write-Log([string]$Message) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "$stamp $Message"
    Write-Output $line
    if ($script:LogPath) { Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8 }
}

function Assert-RemoteValue([string]$Value, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[A-Za-z0-9._/-]+$' -or $Value.Contains('..')) {
        throw "$Name contains unsupported characters"
    }
}

function Replace-File([string]$Source, [string]$Destination) {
    if ([System.IO.File]::Exists($Destination)) {
        $backup = "$Destination.$([guid]::NewGuid().ToString('N')).bak"
        [System.IO.File]::Replace($Source, $Destination, $backup, $true)
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
    else { [System.IO.File]::Move($Source, $Destination) }
}

function Invoke-BoundedDashboardStatusSync([string]$StatusScript, [string]$SshTarget, [string]$NasDataDir, [string]$LogRoot) {
    $shell = Get-Command pwsh.exe,powershell.exe,pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $shell) { throw 'PowerShell executable for dashboard status sync was not found' }
    $arguments = @(
        '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$StatusScript,
        '-SshTarget',$SshTarget,'-NasDataDir',$NasDataDir
    )
    $result = Invoke-BoundedSyncProcess $shell.Source $arguments 'dashboard_status_sync' '' 90
    if ($result.exitCode -ne 0) { throw $result.failure }
}

$resolvedOpsRoot = if ($OpsRoot) { [System.IO.Path]::GetFullPath($OpsRoot) } else { Split-Path -Parent $PSScriptRoot }
$resolvedProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$resolvedLegacyRoot = [System.IO.Path]::GetFullPath($LegacyRoot)
if (-not (Test-Path -LiteralPath $resolvedOpsRoot -PathType Container)) { throw "Ops root is missing: $resolvedOpsRoot" }
if (-not (Test-Path -LiteralPath $resolvedLegacyRoot -PathType Container)) { throw "Legacy root is missing: $resolvedLegacyRoot" }
if (-not (Test-Path -LiteralPath $resolvedProjectRoot -PathType Container)) { throw "Project root is missing: $resolvedProjectRoot" }
. (Join-Path $resolvedProjectRoot 'scripts/Sync-OperationsSupport.ps1')
. (Join-Path $resolvedProjectRoot 'scripts/Sync-ShadowPublication.ps1')

Assert-RemoteValue $SshTarget 'SshTarget'
Assert-RemoteValue $NasStagingDir 'NasStagingDir'
Assert-RemoteValue $NasDataDir 'NasDataDir'
if ($NasStagingDir -notmatch '^/volume3/docker/checkin-fabric-v2/[A-Za-z0-9._/-]+$' -or
    $NasDataDir -notmatch '^/volume3/docker/checkin-fabric-v2/[A-Za-z0-9._/-]+$') {
    throw 'NAS project files must stay under /volume3/docker/checkin-fabric-v2/'
}

if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe,node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($nodeCommand) { $NodePath = $nodeCommand.Source }
}
if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'Node.js executable was not found' }
$tarCommand = Get-Command tar.exe,tar -ErrorAction SilentlyContinue | Select-Object -First 1
$sshCommand = Get-Command ssh.exe,ssh -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $tarCommand) { throw 'tar executable was not found' }
if (-not $sshCommand) { throw 'ssh executable was not found' }

$outputRoot = Join-Path $resolvedProjectRoot 'outputs'
$syncRoot = Join-Path $resolvedOpsRoot 'tmp\nas-sync'
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
[System.IO.Directory]::CreateDirectory($syncRoot) | Out-Null
$script:LogPath = Join-Path $resolvedOpsRoot 'logs\shadow-sync.log'
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $script:LogPath)) | Out-Null
$canonicalSnapshot = Join-Path $outputRoot 'shadow-beta-snapshot.json'
$canonicalLedger = Join-Path $outputRoot 'shadow-ledger.jsonl'
$canonicalGeneration = Join-Path $outputRoot 'dashboard-generation.json'
$temporarySnapshot = Join-Path $syncRoot 'shadow-beta-snapshot.json'
$temporaryLedger = Join-Path $syncRoot 'shadow-ledger.jsonl'
$temporaryGeneration = Join-Path $syncRoot 'dashboard-generation.json'
$temporaryHealth = Join-Path $syncRoot 'health-report.json'
$temporaryHealthError = Join-Path $syncRoot 'health-report.stderr.log'
$previousSnapshot = if (Test-Path -LiteralPath $canonicalSnapshot -PathType Leaf) { $canonicalSnapshot } else { $null }

$mutex = [System.Threading.Mutex]::new($false, 'Local\CodexCheckinFabricV2ShadowSync')
if (-not $mutex.WaitOne(0)) {
    Write-Log 'Another sync process is running; skipped.'
    exit 0
}
try {
    Remove-Item -LiteralPath $temporarySnapshot,$temporaryLedger,$temporaryHealth,$temporaryHealthError -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $canonicalLedger -PathType Leaf) { Copy-Item -LiteralPath $canonicalLedger -Destination $temporaryLedger -Force }
    $healthScript = Join-Path $resolvedLegacyRoot 'scripts\Test-CheckinHealth.ps1'
    if (-not (Test-Path -LiteralPath $healthScript -PathType Leaf)) { throw "Legacy health script is missing: $healthScript" }
    $healthShell = Get-Command pwsh.exe,powershell.exe,pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $healthShell) { throw 'PowerShell executable for the health probe was not found' }
    $healthOutput = & $healthShell.Source '-NoProfile' '-NonInteractive' '-ExecutionPolicy' 'Bypass' '-File' $healthScript 2> $temporaryHealthError
    $healthExitCode = $LASTEXITCODE
    $healthText = ($healthOutput -join [Environment]::NewLine).Trim()
    try { $health = $healthText | ConvertFrom-Json }
    catch { throw "Legacy health probe did not return valid JSON (exit=$healthExitCode)" }
    if ($null -eq $health.PSObject.Properties['healthy'] -or [string]::IsNullOrWhiteSpace([string]$health.checkedAt)) {
        throw 'Legacy health probe omitted required healthy or checkedAt fields'
    }
    [System.IO.File]::WriteAllText($temporaryHealth, ($health | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    Write-Log "Captured current legacy health (exit=$healthExitCode, healthy=$([bool]$health.healthy))."
    $shadowScript = Join-Path $resolvedProjectRoot 'src\shadow-run.mjs'
    $desiredPlanFile = Join-Path $syncRoot 'desired-plan.json'
    & $NodePath (Join-Path $resolvedProjectRoot 'scripts\collect-desired-plan.mjs') $resolvedLegacyRoot $desiredPlanFile
    if ($LASTEXITCODE -ne 0) { throw 'Current desired plan could not be read; retaining previous snapshot.' }
    $monitorConfigFile = Join-Path $resolvedOpsRoot 'config\pt-monitor.local.json'
    $monitorArguments = @()
    if (Test-Path -LiteralPath $monitorConfigFile) {
        $monitorConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath $monitorConfigFile | ConvertFrom-Json
        $catalogFile = Join-Path $syncRoot 'pt-monitor-catalog.json'
        & $NodePath (Join-Path $resolvedProjectRoot 'scripts\collect-monitor-catalog.mjs') $resolvedLegacyRoot $monitorConfigFile $catalogFile
        if ($LASTEXITCODE -ne 0) { throw 'PT bookmark inventory failed; retaining previous snapshot.' }
        $monitorArguments += @('--monitor-catalog', $catalogFile)
        Assert-RemoteValue $monitorConfig.harvestDatabase 'HarvestDatabase'
        $harvestScript = Join-Path $resolvedProjectRoot 'scripts\harvest-observe.py'
        $harvestFile = Join-Path $syncRoot 'harvest-pt-status.json'
        # Only shadow-run can use this same-day cache, for display continuity.
        # The dispatcher below still requires a successful live Harvest read.
        $monitorArguments += @('--pt-status-cache-file', $harvestFile)
        $harvestProbe = Invoke-BoundedSyncProcess $sshCommand.Source @('-T','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',$SshTarget,"sudo -n python3 - '$($monitorConfig.harvestDatabase)'") 'harvest_read' $harvestScript 45
        $harvestOutput = $harvestProbe.output
        if ($harvestProbe.exitCode -eq 0) {
            try {
                $harvestReport = ($harvestOutput -join [Environment]::NewLine) | ConvertFrom-Json
                if ($harvestReport.source -ne 'harvest') { throw 'Invalid Harvest report' }
                [System.IO.File]::WriteAllText($harvestFile, ($harvestReport | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
                $monitorArguments += @('--pt-status-file', $harvestFile)
                Write-Log "Captured read-only Harvest observations ($($harvestReport.sites.Count) records)."
                $fallbackScript = Join-Path $resolvedProjectRoot 'scripts\harvest-fallback.mjs'
                if (-not $SkipHarvestFallback -and (Test-Path -LiteralPath $fallbackScript -PathType Leaf)) {
                    try {
                        $previewOutput = @(& $NodePath $fallbackScript '--report-file' $harvestFile '--catalog-file' $catalogFile 2>&1)
                        if ($LASTEXITCODE -ne 0) { throw 'Harvest fallback preview failed' }
                        $preview = ($previewOutput | Select-Object -Last 1) | ConvertFrom-Json
                        if (-not $NoUpload -and [int]$preview.newAttempts -gt 0) {
                            $started = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
                            $pendingDir = Join-Path $resolvedProjectRoot ('data\harvest-fallback-pending\' + $started + '-' + [guid]::NewGuid().ToString('N'))
                            [System.IO.Directory]::CreateDirectory($pendingDir) | Out-Null
                            $pendingFile = Join-Path $pendingDir 'harvest.json'
                            $pendingCatalog = Join-Path $pendingDir 'catalog.json'
                            Copy-Item -LiteralPath $harvestFile -Destination $pendingFile
                            Copy-Item -LiteralPath $catalogFile -Destination $pendingCatalog
                            $reportHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pendingFile).Hash.ToLowerInvariant()
                            $catalogHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $pendingCatalog).Hash.ToLowerInvariant()
                            $fallbackLog = Join-Path $resolvedProjectRoot "logs\harvest-fallback-$started.log"
                            $fallbackError = Join-Path $resolvedProjectRoot "logs\harvest-fallback-$started.err.log"
                            $arguments = @('"' + $fallbackScript + '"', '--apply', '--report-file', '"' + $pendingFile + '"', '--catalog-file', '"' + $pendingCatalog + '"', '--report-sha256', $reportHash, '--catalog-sha256', $catalogHash, '--harvest-ssh-target', $SshTarget, '--harvest-db-path', $monitorConfig.harvestDatabase)
                            Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $resolvedProjectRoot -WindowStyle Hidden -RedirectStandardOutput $fallbackLog -RedirectStandardError $fallbackError | Out-Null
                            Write-Log "Queued bounded execution-layer fallback for $([int]$preview.newAttempts) unattempted PT site(s)."
                        }
                    } catch { Write-Log "Harvest fallback unavailable; read-only PT status remains visible: $($_.Exception.Message)" }
                }
            } catch { Write-Log 'Harvest report invalid; PT inventory remains visible with unconfirmed status.' }
        } else { Write-Log 'Harvest unavailable; retain valid same-day cached observations for display only; do not queue fallback.' }
    }
    $arguments = @(
        $shadowScript, '--legacy-root', $resolvedLegacyRoot,
        '--health-file', $temporaryHealth,
        '--out', $temporarySnapshot,
        '--ledger', $temporaryLedger
    )
    $arguments += $monitorArguments
    $arguments += @('--desired-plan', $desiredPlanFile)
    $identityFile = Join-Path $resolvedOpsRoot 'outputs\display-identities.json'
    if (Test-Path -LiteralPath $identityFile) { $arguments += @('--identity-file', $identityFile) }
    if ($previousSnapshot) { $arguments += @('--previous', $previousSnapshot) }
    Write-Log "Generating shadow snapshot (legacy=$resolvedLegacyRoot)."
    $runOutput = & $NodePath @arguments 2>&1
    $runExitCode = $LASTEXITCODE
    if ($runExitCode -ne 0) { throw "shadow-run failed with exit code ${runExitCode}: $($runOutput | Select-Object -Last 1)" }
    $gateOutput = & $NodePath (Join-Path $resolvedProjectRoot 'src\shadow-acceptance.mjs') '--ledger' $temporaryLedger '--min-days' '3'
    $gateExitCode = $LASTEXITCODE
    if ($gateExitCode -notin @(0, 2)) { throw 'Shadow acceptance checker could not evaluate the ledger.' }
    $gate = ($gateOutput -join [Environment]::NewLine) | ConvertFrom-Json
    $gateTemporary = Join-Path $syncRoot 'shadow-acceptance.json'
    [System.IO.File]::WriteAllText($gateTemporary, ($gate | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    Replace-File $gateTemporary (Join-Path $resolvedOpsRoot 'outputs\shadow-acceptance.json')
    Write-Log "Observation gate: accepted=$($gate.accepted), recentEligibleDays=$($gate.eligibleRecentDays), required=$($gate.requiredConsecutiveDays). Unified executor configuration unchanged."
    if (-not (Test-Path -LiteralPath $temporarySnapshot -PathType Leaf) -or -not (Test-Path -LiteralPath $temporaryLedger -PathType Leaf) -or -not (Test-Path -LiteralPath $temporaryGeneration -PathType Leaf)) {
        throw 'shadow-run did not produce snapshot, ledger and generation manifest'
    }
    $snapshotText = Get-Content -Raw -Encoding UTF8 -LiteralPath $temporarySnapshot
    $snapshot = $snapshotText | ConvertFrom-Json
    if ($snapshot.mode -ne 'shadow_read_only' -or [string]$snapshot.planHash -notmatch '^[a-f0-9]{64}$') { throw 'snapshot validation failed' }
    if ($snapshotText -match '(?i)"(?:password|passwd|token|cookie|secret|profilepath|userdatadir|dpapi|screenshot)"\s*:') { throw 'snapshot contains a sensitive field' }
    $ledgerText = Get-Content -Raw -Encoding UTF8 -LiteralPath $temporaryLedger
    if ($ledgerText -match '(?i)"(?:password|passwd|token|cookie|secret|profilepath|userdatadir|dpapi|screenshot)"\s*:') { throw 'ledger contains a sensitive field' }

    if (-not $NoUpload) {
        Write-Log 'Starting dashboard status sync.'
        Invoke-BoundedDashboardStatusSync (Join-Path $resolvedProjectRoot 'scripts\sync-v2-status.ps1') $SshTarget $NasDataDir $syncRoot
        Write-Log 'V2 dashboard receipts and ownership synchronized.'
        Write-Log 'Uploading redacted snapshot and ledger to NAS staging.'
        $archivePath = Join-Path $syncRoot 'nas-upload.tar.gz'
        $publication = New-ShadowPublicationPlan $NasStagingDir $NasDataDir ([guid]::NewGuid().ToString('N'))
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
        & $tarCommand.Source '-czf' $archivePath '-C' $syncRoot 'shadow-beta-snapshot.json' 'shadow-ledger.jsonl' 'dashboard-generation.json'
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'local snapshot archive failed' }
        $sshOptions = @('-T','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',$SshTarget)
        $preflight = Invoke-ShadowPublicationCommand $sshCommand.Source @($sshOptions + @($publication.preflight)) 'nas_snapshot_preflight' '' 20 1
        if ($preflight.exitCode -ne 0) { throw $preflight.failure }
        $upload = Invoke-ShadowPublicationCommand $sshCommand.Source @($sshOptions + @($publication.upload)) 'nas_snapshot_upload' $archivePath 45 2
        if ($upload.exitCode -ne 0) { throw $upload.failure }
        $extract = Invoke-ShadowPublicationCommand $sshCommand.Source @($sshOptions + @($publication.extract)) 'nas_snapshot_extract' '' 30 2
        if ($extract.exitCode -ne 0) { throw $extract.failure }
        $commit = Invoke-ShadowPublicationCommand $sshCommand.Source @($sshOptions + @($publication.commit)) 'nas_commit' '' 30 2
        if ($commit.exitCode -ne 0) { throw $commit.failure }
        Write-Log 'NAS files replaced atomically.'
        Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
    }

    Replace-File $temporaryLedger $canonicalLedger
    Replace-File $temporarySnapshot $canonicalSnapshot
    if (Test-Path -LiteralPath $canonicalGeneration) { Copy-Item -LiteralPath $canonicalGeneration -Destination (Join-Path $outputRoot 'dashboard-generation.previous.json') -Force }
    Replace-File $temporaryGeneration $canonicalGeneration
    Write-Log "Sync complete: snapshot=$($snapshot.snapshotId), plan=$($snapshot.planHash.Substring(0, 12)), sites=$($snapshot.counts.logicalSites), units=$($snapshot.counts.executionUnits), uploaded=$(-not $NoUpload)."
}
catch {
    Write-Log "Sync failed: $($_.Exception.Message)"
    exit 1
}
finally {
    if ($publication -and $sshOptions) {
        $cleanup = Invoke-ShadowPublicationCommand $sshCommand.Source @($sshOptions + @($publication.cleanup)) 'nas_snapshot_cleanup' '' 15 1
        if ($cleanup.exitCode -ne 0) { Write-Log 'Snapshot staging cleanup deferred; the installed generation remains unchanged.' }
    }
    if ($archivePath) { Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $temporaryGeneration -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporarySnapshot,$temporaryLedger,$temporaryHealth,$temporaryHealthError -Force -ErrorAction SilentlyContinue
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
