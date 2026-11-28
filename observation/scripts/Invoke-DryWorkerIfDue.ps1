[CmdletBinding()]
param(
    [string]$OpsRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$configPath = Join-Path $OpsRoot 'config\worker.local.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { exit 0 }

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
if ($config.mode -ne 'dry_run' -or $config.enabled -eq $false) { exit 0 }

$marker = Join-Path $OpsRoot 'outputs\worker-last-attempt.json'
$previous = if (Test-Path -LiteralPath $marker -PathType Leaf) {
    try { Get-Content -Raw -Encoding UTF8 -LiteralPath $marker | ConvertFrom-Json } catch { $null }
} else {
    $null
}
if (-not $Force -and $previous -and $previous.at) {
    try {
        $elapsedMinutes = ([datetimeoffset]::UtcNow - [datetimeoffset]$previous.at).TotalMinutes
        if ($elapsedMinutes -ge 0 -and $elapsedMinutes -lt 15) { return }
    } catch {}
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\FabricV2DryWorkerDispatch')
$acquired = $false
try {
    try {
        $acquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) { exit 0 }

    $shell = (Get-Command pwsh.exe -ErrorAction Stop).Source
    $launcher = Join-Path $OpsRoot 'scripts\Run-HiddenPowerShell.vbs'
    $script = Join-Path $OpsRoot 'scripts\Run-DryWorker.ps1'
    $arguments = "//B //NoLogo `"$launcher`" `"$shell`" `"$script`" `"$OpsRoot`""
    $process = Start-Process -FilePath "$env:WINDIR\System32\wscript.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(45000)) {
        try { $process.Kill($true) } catch {}
        try { $process.WaitForExit(5000) | Out-Null } catch {}
        throw 'Dry worker launcher timeout'
    }

    $status = [ordered]@{
        at        = [datetime]::UtcNow.ToString('o')
        exitCode  = $process.ExitCode
        mode      = 'dry_run'
        v1Invoked = $false
    }
    $markerDir = Split-Path -Parent $marker
    if ($markerDir -and -not (Test-Path -LiteralPath $markerDir)) {
        New-Item -ItemType Directory -Path $markerDir -Force | Out-Null
    }
    $tempMarker = "$marker.$([guid]::NewGuid().ToString('N')).tmp"
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    try {
        [System.IO.File]::WriteAllText($tempMarker, ($status | ConvertTo-Json), $utf8NoBom)
        Move-Item -LiteralPath $tempMarker -Destination $marker -Force
    } finally {
        if (Test-Path -LiteralPath $tempMarker) {
            Remove-Item -LiteralPath $tempMarker -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Output ($status | ConvertTo-Json -Compress)
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
