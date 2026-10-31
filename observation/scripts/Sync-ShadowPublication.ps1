# A publication uses a unique transaction directory. A leftover from an older
# upload can never turn a successfully installed generation into a sync error.
function New-ShadowPublicationPlan([string]$NasStagingDir, [string]$NasDataDir, [string]$TransactionId,
    [ValidateSet('full', 'delta')][string]$Mode = 'full', [string]$LedgerSha256 = '') {
    if ($TransactionId -cnotmatch '^[a-f0-9]{32}\z' -or
        $NasDataDir -cnotmatch '^/volume3/docker/[A-Za-z0-9_-]+/nas-data\z') { throw 'invalid shadow publication target' }
    $project = $NasDataDir.Substring(0, $NasDataDir.Length - '/nas-data'.Length)
    if ($NasStagingDir -cne "$project/.shadow-sync-stage") { throw 'shadow staging must stay in the same NAS project' }
    if (($LedgerSha256 -and $LedgerSha256 -cnotmatch '^[a-f0-9]{64}\z') -or
        ($Mode -eq 'delta' -and -not $LedgerSha256)) { throw 'invalid shadow ledger digest' }
    $stage = "$NasStagingDir-$TransactionId"
    $archive = "$stage/payload.tar.gz"
    $names = @('shadow-ledger.jsonl', 'shadow-beta-snapshot.json', 'dashboard-generation.json')
    $gc = "for candidate in '$project'/.shadow-sync-stage-*; do test -d `$candidate || continue; name=`$(basename `$candidate); case `$name in .shadow-sync-stage-????????????????????????????????) if test -n `$(find `$candidate -maxdepth 0 -mmin +1440 -print); then rm -rf -- `$candidate; fi;; esac; done"
    $checks = "set -eu; test -d '$project' && test ! -L '$project' && test -w '$project' && test -d '$NasDataDir' && test ! -L '$NasDataDir' && $gc && test ! -e '$stage' && install -d -m 0700 '$stage'"
    # Only fixed metadata is returned; neither the ledger path nor its contents
    # are sent back. A failed metadata read is safe to handle as a full upload.
    $probe = "if test ! -e '$NasDataDir/shadow-ledger.jsonl' && test ! -L '$NasDataDir/shadow-ledger.jsonl'; then printf '%s\n' 'shadow-ledger-v1 missing'; elif test -f '$NasDataDir/shadow-ledger.jsonl' && test ! -L '$NasDataDir/shadow-ledger.jsonl' && bytes=`$(wc -c < '$NasDataDir/shadow-ledger.jsonl') && digest=`$(sha256sum < '$NasDataDir/shadow-ledger.jsonl'); then printf 'shadow-ledger-v1 %s %s\n' ""`$bytes"" ""`${digest%% *}""; else printf '%s\n' 'shadow-ledger-v1 read_failed'; fi"
    $checks += " && { $probe; }"
    $ledgerMember = if ($Mode -eq 'delta') { 'shadow-ledger.delta' } else { 'shadow-ledger.jsonl' }
    $extract = "set -eu; test ! -L '$stage'; tar -tzf '$archive' | LC_ALL=C sort > '$stage/archive-list'; printf '%s\n' dashboard-generation.json shadow-beta-snapshot.json $ledgerMember > '$stage/expected-list'; cmp '$stage/archive-list' '$stage/expected-list'; tar -xzf '$archive' -C '$stage'"
    $ledgerResult = "$stage/shadow-ledger.jsonl"
    if ($Mode -eq 'delta') {
        $ledgerResult += '.tmp'
        $extract += "; test -f '$NasDataDir/shadow-ledger.jsonl' && test ! -L '$NasDataDir/shadow-ledger.jsonl'; test -f '$stage/shadow-ledger.delta' && test ! -L '$stage/shadow-ledger.delta'; cp '$NasDataDir/shadow-ledger.jsonl' '$ledgerResult'; cat '$stage/shadow-ledger.delta' >> '$ledgerResult'"
    }
    if ($LedgerSha256) {
        $extract += "; test -f '$ledgerResult' && test ! -L '$ledgerResult'; digest=`$(sha256sum < '$ledgerResult'); if test ""`${digest%% *}"" != '$LedgerSha256'; then printf '%s\n' shadow_ledger_hash_mismatch >&2; exit 65; fi"
    }
    if ($Mode -eq 'delta') { $extract += "; mv '$ledgerResult' '$stage/shadow-ledger.jsonl'" }
    $commands = @("set -eu", "test -d '$stage' && test ! -L '$stage' && test ! -L '$NasDataDir'")
    foreach ($name in $names) {
        $commands += "test -f '$stage/$name' && test ! -L '$stage/$name' && sudo -n install -o 1000 -g 1000 -m 0644 '$stage/$name' '$NasDataDir/$name.$TransactionId.tmp'"
    }
    # Retrying a successful commit must not replace the previous generation
    # with the new one. Sources stay in stage until the separate cleanup phase.
    $commands += "if test -f '$NasDataDir/dashboard-generation.json' && ! cmp -s '$stage/dashboard-generation.json' '$NasDataDir/dashboard-generation.json'; then sudo -n cp '$NasDataDir/dashboard-generation.json' '$NasDataDir/dashboard-generation.previous.json'; fi"
    foreach ($name in $names) { $commands += "sudo -n mv '$NasDataDir/$name.$TransactionId.tmp' '$NasDataDir/$name'" }
    $cleanup = @("set -eu", "test ! -L '$stage'")
    foreach ($name in @($names + @('shadow-ledger.delta', 'shadow-ledger.jsonl.tmp', 'payload.tar.gz', 'archive-list', 'expected-list'))) { $cleanup += "rm -f -- '$stage/$name'" }
    foreach ($name in $names) { $cleanup += "sudo -n rm -f -- '$NasDataDir/$name.$TransactionId.tmp'" }
    $cleanup += "if test -d '$stage'; then rmdir -- '$stage'; fi"
    return [pscustomobject]@{
        stage = $stage; archive = $archive; preflight = $checks
        upload = "cat > '$archive'"; extract = $extract
        commit = $commands -join '; '; cleanup = $cleanup -join '; '
    }
}

function Get-ShadowUploadTimeoutSeconds([long]$Bytes, [ValidateSet('full', 'delta')][string]$Mode = 'full') {
    if ($Bytes -lt 0) { throw 'invalid shadow archive size' }
    # Include SSH setup and allow a slow overlay-network upload. The archive
    # grows with the audit ledger; keep an explicit upper bound for stalls.
    $maximum = if ($Mode -eq 'full') { 300 } else { 180 }
    return [int][Math]::Min($maximum, [Math]::Max(90, 30 + [Math]::Ceiling($Bytes / 16384.0)))
}

function Invoke-ShadowPublicationCommand([string]$Executable, [string[]]$Arguments, [string]$Phase,
    [string]$InputFile = '', [int]$TimeoutSeconds = 45, [int]$MaxAttempts = 2, [scriptblock]$Invoke,
    [scriptblock]$BeforeAttempt) {
    for ($attempt = 1; $attempt -le [Math]::Max(1, [Math]::Min(2, $MaxAttempts)); $attempt++) {
        if ($BeforeAttempt) { & $BeforeAttempt }
        $result = if ($Invoke) { & $Invoke $Executable $Arguments $Phase $InputFile $TimeoutSeconds }
            else { Invoke-BoundedSyncProcess $Executable $Arguments $Phase $InputFile $TimeoutSeconds }
        if ($result.exitCode -eq 0 -or $attempt -ge $MaxAttempts -or
            $result.failure -notmatch 'cause=(connection_timeout|connection_interrupted|ssh_transport_failed)\)') { return $result }
        Start-Sleep -Milliseconds 500
    }
}

function Get-ShadowLedgerTransfer([string]$LedgerPath, [object]$Remote) {
    $stream = [IO.File]::OpenRead($LedgerPath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $length = $stream.Length
        $digest = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        $transfer = [pscustomobject]@{ mode = 'full'; offset = [long]0; bytes = $length; sha256 = $digest; reason = 'remote_read_failed' }
        if (-not $Remote -or $Remote.exitCode -ne 0) { return $transfer }
        $metadata = ([string]$Remote.output).Trim()
        if ($metadata -ceq 'shadow-ledger-v1 missing') { $transfer.reason = 'remote_missing'; return $transfer }
        if ($metadata -cnotmatch '^shadow-ledger-v1\s+([0-9]+) ([a-f0-9]{64})$') { return $transfer }
        $remoteLength = [long]0
        $remoteDigest = $Matches[2]
        if (-not [long]::TryParse($Matches[1], [ref]$remoteLength)) { return $transfer }
        if ($remoteLength -gt $length) { $transfer.reason = 'remote_longer'; return $transfer }
        [void]$stream.Seek(0, [IO.SeekOrigin]::Begin)
        $sha.Initialize()
        $buffer = New-Object byte[] 65536
        $remaining = $remoteLength
        while ($remaining -gt 0) {
            $count = $stream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $remaining))
            if ($count -eq 0) { throw 'local shadow ledger changed during prefix verification' }
            [void]$sha.TransformBlock($buffer, 0, $count, $buffer, 0)
            $remaining -= $count
        }
        [void]$sha.TransformFinalBlock($buffer, 0, 0)
        $prefixDigest = ([BitConverter]::ToString($sha.Hash)).Replace('-', '').ToLowerInvariant()
        if ($prefixDigest -ne $remoteDigest) { $transfer.reason = 'prefix_mismatch'; return $transfer }
        $transfer.mode = 'delta'; $transfer.offset = $remoteLength
        $transfer.bytes = $length - $remoteLength; $transfer.reason = 'none'
        return $transfer
    }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function New-ShadowUploadArchive([string]$TarExecutable, [string]$SyncRoot, [string]$ArchivePath, [object]$Transfer) {
    $member = 'shadow-ledger.jsonl'
    if ($Transfer.mode -eq 'delta') {
        $member = 'shadow-ledger.delta'
        $delta = Join-Path $SyncRoot $member
        $temporary = "$delta.tmp"
        $inputStream = $null; $outputStream = $null
        try {
            $inputStream = [IO.File]::OpenRead((Join-Path $SyncRoot 'shadow-ledger.jsonl'))
            $outputStream = [IO.File]::Create($temporary)
            [void]$inputStream.Seek($Transfer.offset, [IO.SeekOrigin]::Begin)
            $inputStream.CopyTo($outputStream)
        }
        finally {
            if ($inputStream) { $inputStream.Dispose() }
            if ($outputStream) { $outputStream.Dispose() }
        }
        Move-Item -LiteralPath $temporary -Destination $delta -Force
    }
    & $TarExecutable '-czf' $ArchivePath '-C' $SyncRoot 'shadow-beta-snapshot.json' $member 'dashboard-generation.json'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) { throw 'local snapshot archive failed' }
}

function Invoke-ShadowPublication([string]$TarExecutable, [string]$SshExecutable, [string[]]$SshOptions,
    [string]$NasStagingDir, [string]$NasDataDir, [string]$SyncRoot,
    [string]$TransactionId = ([guid]::NewGuid().ToString('N'))) {
    $publication = New-ShadowPublicationPlan $NasStagingDir $NasDataDir $TransactionId
    $archivePath = Join-Path $SyncRoot 'nas-upload.tar.gz'
    try {
        $preflight = Invoke-ShadowPublicationCommand $SshExecutable @($SshOptions + @($publication.preflight)) 'nas_snapshot_preflight' '' 20 1
        if ($preflight.exitCode -ne 0) { throw $preflight.failure }
        $ledgerPath = Join-Path $SyncRoot 'shadow-ledger.jsonl'
        $transfer = Get-ShadowLedgerTransfer $ledgerPath $preflight
        for ($pass = 0; $pass -lt 2; $pass++) {
            $publication = New-ShadowPublicationPlan $NasStagingDir $NasDataDir $TransactionId $transfer.mode $transfer.sha256
            New-ShadowUploadArchive $TarExecutable $SyncRoot $archivePath $transfer
            $archiveBytes = (Get-Item -LiteralPath $archivePath).Length
            $uploadTimeout = Get-ShadowUploadTimeoutSeconds $archiveBytes $transfer.mode
            $upload = Invoke-ShadowPublicationCommand $SshExecutable @($SshOptions + @($publication.upload)) 'nas_snapshot_upload' $archivePath $uploadTimeout 2 -BeforeAttempt {
                Write-Log "Shadow upload: mode=$($transfer.mode) bytes=$archiveBytes fallback=$($transfer.reason)" | Out-Host
            }
            if ($upload.exitCode -ne 0) { throw $upload.failure }
            $extract = Invoke-ShadowPublicationCommand $SshExecutable @($SshOptions + @($publication.extract)) 'nas_snapshot_extract' '' 30 2
            if ($extract.exitCode -eq 0) { break }
            if ($transfer.mode -ne 'delta') { throw $extract.failure }
            # No installed file has changed. Overwrite only this transaction's
            # archive and rebuild stage once using the complete local ledger.
            $transfer = Get-ShadowLedgerTransfer $ledgerPath $null
            $transfer.reason = 'delta_validation_failed'
        }
        $commit = Invoke-ShadowPublicationCommand $SshExecutable @($SshOptions + @($publication.commit)) 'nas_commit' '' 30 2
        if ($commit.exitCode -ne 0) { throw $commit.failure }
        Write-Log 'NAS files replaced atomically.'
    }
    finally {
        $cleanup = Invoke-ShadowPublicationCommand $SshExecutable @($SshOptions + @($publication.cleanup)) 'nas_snapshot_cleanup' '' 15 1
        if ($cleanup.exitCode -ne 0) { Write-Log 'Snapshot staging cleanup deferred; the installed generation remains unchanged.' }
        foreach ($name in @('nas-upload.tar.gz', 'shadow-ledger.delta', 'shadow-ledger.delta.tmp')) {
            Remove-Item -LiteralPath (Join-Path $SyncRoot $name) -Force -ErrorAction SilentlyContinue
        }
    }
}
