[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$configPath = Join-Path $root 'config\config.json'
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$schedulerLogPath = Join-Path $root 'logs\scheduler.log'
$watchdogHeartbeatPath = Join-Path $root 'data\scheduler-watchdog-heartbeat.json'
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $schedulerLogPath)) | Out-Null
[System.IO.Directory]::CreateDirectory((Split-Path -Parent $watchdogHeartbeatPath)) | Out-Null
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$shell = if ($config.powershellExecutable) { [string]$config.powershellExecutable } else {
    (Get-Command pwsh,powershell -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $shell) { throw '未找到 PowerShell 可执行文件。' }
$mutexCreated = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\CodexBookmarkDailyCheckinWatchdog', [ref]$mutexCreated)
if (-not $mutexCreated) { exit 0 }

function Write-AtomicTextFile([string]$destination, [string]$content) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    $nonce = [guid]::NewGuid().ToString('N')
    $temporary = "$destination.$PID.$nonce.tmp"
    $backup = "$destination.$PID.$nonce.bak"
    try {
        [System.IO.File]::WriteAllText($temporary, $content, [System.Text.UTF8Encoding]::new($false))
        for ($attempt = 0; $attempt -lt 8; $attempt += 1) {
            try {
                if ([System.IO.File]::Exists($destination)) {
                    [System.IO.File]::Replace($temporary, $destination, $backup, $true)
                } else {
                    [System.IO.File]::Move($temporary, $destination)
                }
                return
            }
            catch {
                if ($attempt -ge 7) { throw }
                Start-Sleep -Milliseconds ([int](50 * [math]::Pow(2, $attempt)))
            }
        }
    }
    finally {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    }
}

function Write-Heartbeat {
    Write-AtomicTextFile $watchdogHeartbeatPath ([ordered]@{ processId = $PID; updatedAt = (Get-Date).ToString('o') } | ConvertTo-Json)
}

try {
    while ($true) {
        try {
            Write-Heartbeat
            $processes = @(Get-CimInstance Win32_Process | Where-Object {
                $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$schedulerScript*"
            })
            $fresh = $false
            if (Test-Path -LiteralPath $heartbeatPath) {
                try {
                    $heartbeat = Get-Content -Raw -Encoding UTF8 $heartbeatPath | ConvertFrom-Json
                    $maxMinutes = 5
                    if ([string]$heartbeat.phase -eq 'running_checkin') {
                        $taskTimeoutMinutes = if ($null -ne $config.taskTimeoutMinutes) { [int]$config.taskTimeoutMinutes } else { 25 }
                        $maxMinutes = $taskTimeoutMinutes + 10
                    }
                    $fresh = (Get-Date) - [datetime]$heartbeat.updatedAt -lt [timespan]::FromMinutes($maxMinutes)
                } catch { $fresh = $false }
            }
            if ($processes.Count -eq 0 -or -not $fresh) {
                $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                $launched = Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',"`"$schedulerScript`"") -WindowStyle Hidden -PassThru
                $started = $false
                for ($attempt = 0; $attempt -lt 10; $attempt++) {
                    Start-Sleep -Milliseconds 500
                    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $($launched.Id)" -ErrorAction SilentlyContinue
                    if ($null -ne $candidate) { $started = $true; break }
                }
                if ($started) {
                    Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 看门狗已启动调度器（PID=$($launched.Id)）。" -Encoding UTF8
                } else {
                    Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 看门狗启动调度器失败（启动 PID=$($launched.Id)）。" -Encoding UTF8
                }
            }
        }
        catch {
            $message = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
            try { Add-Content -LiteralPath $schedulerLogPath -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') 看门狗异常：$message" -Encoding UTF8 } catch { }
        }
        Start-Sleep -Seconds 60
    }
} finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
