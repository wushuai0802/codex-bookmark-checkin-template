# Best-effort, allowlisted telemetry only. Never include native output or inputs.
function Write-SyncPhaseTiming([string]$Prefix, [string]$Name, [int]$Attempt,
    [long]$ElapsedMs, [object]$Result, [string]$RecordFile = '', [scriptblock]$Log) {
    try {
        $names = if ($Prefix -ceq 'Status sync phase') {
            @('export', 'status_preflight', 'status_upload', 'status_install', 'cleanup', 'dashboard_status_sync')
        } elseif ($Prefix -ceq 'Shadow phase') {
            @('nas_snapshot_preflight', 'nas_snapshot_upload', 'nas_snapshot_extract', 'nas_commit', 'nas_snapshot_cleanup')
        } else { return }
        if ($names -cnotcontains $Name -or $Attempt -lt 1 -or $ElapsedMs -lt 0) { return }
        $exitCode = if ($null -ne $Result) { [int]$Result.exitCode } else { -1 }
        $timedOut = $null -ne $Result -and $Result.timedOut -is [bool] -and $Result.timedOut
        $cause = if ($exitCode -eq 0) { 'none' } else { 'remote_command_failed' }
        if ($exitCode -ne 0 -and [string]$Result.failure -cmatch 'cause=(connection_timeout|connection_interrupted|authentication_failed|host_key_verification_failed|name_resolution_failed|remote_storage_full|ssh_transport_failed|remote_command_failed|executable_missing|input_missing)\)') {
            $cause = $Matches[1]
        }
        $line = "${Prefix}: name=$Name attempt=$Attempt ms=$ElapsedMs exit=$exitCode timedOut=$timedOut cause=$cause"
        if ($RecordFile) {
            try { [IO.File]::AppendAllText($RecordFile, $line + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)) } catch { }
        }
        if ($Log) { try { & $Log $line | Out-Host } catch { } }
    }
    catch { }
}

function Receive-SyncPhaseTiming([string]$RecordFile, [scriptblock]$Log) {
    try {
        if (-not $RecordFile -or -not [IO.File]::Exists($RecordFile)) { return }
        # Ignore incomplete writes or anything outside the child's fixed schema.
        $pattern = '^Status sync phase: name=(export|status_preflight|status_upload|status_install|cleanup) attempt=[1-9][0-9]* ms=[0-9]+ exit=-?[0-9]+ timedOut=(True|False) cause=(none|connection_timeout|connection_interrupted|authentication_failed|host_key_verification_failed|name_resolution_failed|remote_storage_full|ssh_transport_failed|remote_command_failed|executable_missing|input_missing)\z'
        foreach ($line in [IO.File]::ReadLines($RecordFile, [Text.Encoding]::UTF8)) {
            if ($line -cmatch $pattern) { try { & $Log $line | Out-Host } catch { } }
        }
    }
    catch { }
}
