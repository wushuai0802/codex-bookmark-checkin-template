# A publication uses a unique transaction directory. A leftover from an older
# upload can never turn a successfully installed generation into a sync error.
function New-ShadowPublicationPlan([string]$NasStagingDir, [string]$NasDataDir, [string]$TransactionId) {
    if ($TransactionId -notmatch '^[a-f0-9]{32}$' -or
        $NasDataDir -notmatch '^/volume3/docker/[A-Za-z0-9_-]+/nas-data$') { throw 'invalid shadow publication target' }
    $project = $NasDataDir.Substring(0, $NasDataDir.Length - '/nas-data'.Length)
    if ($NasStagingDir -ne "$project/.shadow-sync-stage") { throw 'shadow staging must stay in the same NAS project' }
    $stage = "$NasStagingDir-$TransactionId"
    $archive = "$stage/payload.tar.gz"
    $names = @('shadow-ledger.jsonl', 'shadow-beta-snapshot.json', 'dashboard-generation.json')
    $checks = "test -d '$project' && test ! -L '$project' && test -d '$NasDataDir' && test ! -L '$NasDataDir' && test ! -e '$stage' && install -d -m 0700 '$stage'"
    $extract = "set -eu; test ! -L '$stage'; tar -tzf '$archive' | LC_ALL=C sort > '$stage/archive-list'; printf '%s\n' dashboard-generation.json shadow-beta-snapshot.json shadow-ledger.jsonl > '$stage/expected-list'; cmp '$stage/archive-list' '$stage/expected-list'; tar -xzf '$archive' -C '$stage'"
    $commands = @("set -eu", "test -d '$stage' && test ! -L '$stage' && test ! -L '$NasDataDir'")
    foreach ($name in $names) {
        $commands += "test -f '$stage/$name' && test ! -L '$stage/$name' && sudo -n install -o 1000 -g 1000 -m 0644 '$stage/$name' '$NasDataDir/$name.$TransactionId.tmp'"
    }
    # Retrying a successful commit must not replace the previous generation
    # with the new one. Sources stay in stage until the separate cleanup phase.
    $commands += "if test -f '$NasDataDir/dashboard-generation.json' && ! cmp -s '$stage/dashboard-generation.json' '$NasDataDir/dashboard-generation.json'; then sudo -n cp '$NasDataDir/dashboard-generation.json' '$NasDataDir/dashboard-generation.previous.json'; fi"
    foreach ($name in $names) { $commands += "sudo -n mv '$NasDataDir/$name.$TransactionId.tmp' '$NasDataDir/$name'" }
    $cleanup = @("set -eu", "test ! -L '$stage'")
    foreach ($name in @($names + @('payload.tar.gz', 'archive-list', 'expected-list'))) { $cleanup += "rm -f -- '$stage/$name'" }
    foreach ($name in $names) { $cleanup += "sudo -n rm -f -- '$NasDataDir/$name.$TransactionId.tmp'" }
    $cleanup += "if test -d '$stage'; then rmdir -- '$stage'; fi"
    return [pscustomobject]@{
        stage = $stage; archive = $archive; preflight = $checks
        upload = "cat > '$archive'"; extract = $extract
        commit = $commands -join '; '; cleanup = $cleanup -join '; '
    }
}

function Invoke-ShadowPublicationCommand([string]$Executable, [string[]]$Arguments, [string]$Phase,
    [string]$InputFile = '', [int]$TimeoutSeconds = 45, [int]$MaxAttempts = 2, [scriptblock]$Invoke) {
    for ($attempt = 1; $attempt -le [Math]::Max(1, [Math]::Min(2, $MaxAttempts)); $attempt++) {
        $result = if ($Invoke) { & $Invoke $Executable $Arguments $Phase $InputFile $TimeoutSeconds }
            else { Invoke-BoundedSyncProcess $Executable $Arguments $Phase $InputFile $TimeoutSeconds }
        if ($result.exitCode -eq 0 -or $attempt -ge $MaxAttempts -or
            $result.failure -notmatch 'cause=(connection_timeout|connection_interrupted|ssh_transport_failed)\)') { return $result }
        Start-Sleep -Milliseconds 500
    }
}
