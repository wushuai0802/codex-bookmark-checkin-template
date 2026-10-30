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

function Add-CheckinGatewayNotice([string]$Root, $Notification, $Incident, [string]$Kind, [datetimeoffset]$At) {
    if ([string]$Incident.incidentId -cnotmatch '^[a-f0-9-]{36}$' -or $Kind -notin @('blocked','recovered')) { throw 'Invalid gateway notification identity' }
    $noticeCode = Get-CheckinGatewayCode ([string]$Incident.notifiedCode)
    $eventKey = "gateway:$($Incident.incidentId):$Kind"
    $taskId = if ($Notification.taskId) { [string]$Notification.taskId } else { 'bookmark_daily' }
    $name = '签到调度'
    $source = if ($Notification.source) { [string]$Notification.source } else { 'browser-codex' }
    $status = if ($Kind -eq 'blocked') { 'failed' } else { 'success' }
    $started = ([datetimeoffset]$Incident.notifiedStartedAt).ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd HH:mm:ss zzz')
    $summary = if ($Kind -eq 'blocked') {
        "签到调度连续失败：$noticeCode；阻塞开始：$started。"
    } else { "签到调度已恢复；此前错误：$noticeCode；阻塞开始：$started。" }
    $directory = Join-Path $Root 'data/notification-outbox'
    [void][IO.Directory]::CreateDirectory($directory)
    $file = Join-Path $directory ((Get-CheckinGatewayHash $eventKey) + '.json')
    if (Test-Path -LiteralPath $file) { return }
    $now = $At.ToUniversalTime().ToString('o')
    $item = [ordered]@{schemaVersion=1;eventKey=$eventKey;
        payloadHash=(Get-CheckinGatewayHash (@($eventKey,$taskId,$name,$source,$status,$summary) -join "`n"));
        taskId=$taskId;name=$name;source=$source;status=$status;summary=$summary;createdAt=$now;updatedAt=$now;
        nextAttemptAt=$now;attempts=0;delivered=$false;deliveredAt=$null;disposition=$null;lastError=$null}
    Write-CheckinGatewayJson $file $item
}

function Update-CheckinGatewayHealth {
    param([string]$Root,[bool]$Success,[string]$Code='GATEWAY_CONTROLLER_FAILED',
        [datetimeoffset]$At=[datetimeoffset]::UtcNow)
    $directory = Join-Path $Root 'data'
    [void][IO.Directory]::CreateDirectory($directory)
    $key = (Get-CheckinGatewayHash ([IO.Path]::GetFullPath($directory).ToLowerInvariant())).Substring(0,24)
    $mutex = [Threading.Mutex]::new($false,"Local\CheckinGatewayHealth_$key"); $held=$false
    try {
        try { $held=$mutex.WaitOne(5000) } catch [Threading.AbandonedMutexException] { $held=$true }
        if (-not $held) { throw 'Gateway health state is busy' }
        $file = Join-Path $directory 'gateway-health.json'
        $state = if (Test-Path -LiteralPath $file) { Get-Content -LiteralPath $file -Raw | ConvertFrom-Json } else { $null }
        $configFile = Join-Path $Root 'config/config.json'
        $notification = if (Test-Path -LiteralPath $configFile) { (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).notification } else { $null }
        $enabled = [string]$notification.mode -eq 'command'; $flush=$false
        if ($Success) {
            if ($state -and $state.streakCount -gt 0) {
                if ($state.notified -eq $true -and $enabled) {
                    Add-CheckinGatewayNotice $Root $notification $state 'recovered' $At
                    $flush=$true
                }
                $state.streakCount=0; $state.notified=$false
                Write-CheckinGatewayJson $file $state
            }
        } else {
            $codeValue = Get-CheckinGatewayCode $Code
            if (-not $state -or $state.streakCount -eq 0) {
                $state=[pscustomobject]@{schemaVersion=1;incidentId=[guid]::NewGuid().ToString();firstFailureAt=$At.ToUniversalTime().ToString('o');
                    streakCode=$codeValue;streakStartedAt=$At.ToUniversalTime().ToString('o');streakCount=0;
                    notified=$false;notifiedCode=$null;notifiedStartedAt=$null}
            }
            if ($state.streakCode -cne $codeValue) {
                $state.streakCode=$codeValue; $state.streakCount=0; $state.streakStartedAt=$At.ToUniversalTime().ToString('o')
            }
            $state.streakCount=[Math]::Min(100000,([int]$state.streakCount)+1)
            # Persist the incident ID before enqueueing so a crash cannot cause
            # a second event key for the same blockage on the next poll.
            Write-CheckinGatewayJson $file $state
            if ($enabled -and $state.streakCount -ge 2 -and $state.notified -ne $true) {
                $state.notifiedCode=$state.streakCode; $state.notifiedStartedAt=$state.streakStartedAt
                Add-CheckinGatewayNotice $Root $notification $state 'blocked' $At
                $state.notified=$true
                Write-CheckinGatewayJson $file $state
            }
            $flush=$enabled -and $state.notified -eq $true
        }
        return [pscustomobject]@{flush=$flush}
    } finally { if ($held) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

function Register-CheckinGatewayOutcome([string]$Root,[bool]$Success,[string]$Code) {
    try {
        $result=Update-CheckinGatewayHealth -Root $Root -Success $Success -Code $Code
        $worker=Join-Path $Root 'scripts/Invoke-CheckinNotificationOutbox.ps1'
        if ($result.flush -and (Test-Path -LiteralPath $worker)) {
            . (Join-Path $PSScriptRoot 'Invoke-BoundedCommand.ps1')
            $shell=Join-Path $PSHOME $(if ($PSEdition -eq 'Desktop') { 'powershell.exe' } else { 'pwsh.exe' })
            Invoke-BoundedCommand $shell @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$worker,'-MaxItems','20') 20 | Out-Null
        }
    } catch { Write-Warning 'Gateway health notification remains deferred' }
}
