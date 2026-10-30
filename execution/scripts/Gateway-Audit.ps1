# Gateway diagnostics deliberately contain no exception text, arguments or paths.
function Get-CheckinGatewayCode([string]$Value) {
    $allowed = @('PT_CLEANUP_PENDING','PT_PREFLIGHT','GATEWAY_CONFIG_INVALID','GATEWAY_UNAVAILABLE',
        'GATEWAY_LEASE_REJECTED','GATEWAY_ARGUMENT_REJECTED','GATEWAY_CHILD_FAILED','GATEWAY_CONTROLLER_FAILED')
    if ($Value -cin $allowed) { return $Value }
    return 'GATEWAY_CONTROLLER_FAILED'
}

function Get-CheckinGatewayStage([string]$Value) {
    if ($Value -cin @('integration','arguments','lease','dispatch','controller','pt_cleanup')) { return $Value }
    return 'controller'
}

function Get-CheckinGatewayHash([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Write-CheckinGatewayJson([string]$Path, $Value) {
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Write-CheckinGatewayEvent {
    param([string]$Root,[string]$Stage,[string]$Code,[int]$ExitCode,
        [datetimeoffset]$At = [datetimeoffset]::UtcNow,[ValidateRange(1,2048)][int]$MaxEntries = 256)
    $directory = Join-Path $Root 'data'
    [void][IO.Directory]::CreateDirectory($directory)
    $key = (Get-CheckinGatewayHash ([IO.Path]::GetFullPath($directory).ToLowerInvariant())).Substring(0,24)
    $mutex = [Threading.Mutex]::new($false,"Local\CheckinGatewayAudit_$key")
    $held = $false
    try {
        try { $held = $mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $held = $true }
        if (-not $held) { throw 'Gateway audit is busy' }
        $file = Join-Path $directory 'gateway-events.jsonl'
        $lines = @()
        if (Test-Path -LiteralPath $file) { $lines = @([IO.File]::ReadAllLines($file)) }
        if ($lines.Count -ge $MaxEntries) {
            $oldest = "$file.3"
            if (Test-Path -LiteralPath $oldest) { Remove-Item -LiteralPath $oldest -Force }
            foreach ($index in @(2,1)) {
                if (Test-Path -LiteralPath "$file.$index") { Move-Item -LiteralPath "$file.$index" -Destination "$file.$($index+1)" -Force }
            }
            Move-Item -LiteralPath $file -Destination "$file.1" -Force
            $lines = @()
        }
        $record = [ordered]@{schemaVersion=1;time=$At.ToUniversalTime().ToString('o');
            stage=(Get-CheckinGatewayStage $Stage);errorCode=(Get-CheckinGatewayCode $Code);exitCode=$ExitCode}
        $temporary = "$file.$PID.tmp"
        try {
            [IO.File]::WriteAllLines($temporary,[string[]]@($lines + ($record | ConvertTo-Json -Compress)),[Text.UTF8Encoding]::new($false))
            Move-Item -LiteralPath $temporary -Destination $file -Force
        } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}
