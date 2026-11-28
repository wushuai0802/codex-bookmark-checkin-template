[CmdletBinding()]
param(
    [string]$OpsRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$mutex = [System.Threading.Mutex]::new($false, 'Local\FabricV2DryWorkerOnce')
$acquired = $false
try {
    try {
        $acquired = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $acquired = $true
    }
    if (-not $acquired) { exit 0 }

    $configPath = Join-Path $OpsRoot 'config\config.json'
    $secretPath = Join-Path $OpsRoot 'secrets\dry-worker\worker.dpapi'
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$config.v2ProjectRoot)) {
        throw 'Dry worker configuration missing v2ProjectRoot'
    }

    $secure = Get-Content -Raw -Encoding UTF8 -LiteralPath $secretPath | ConvertTo-SecureString
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = $null
    try {
        $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }

    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $workerScript = Join-Path ([string]$config.v2ProjectRoot) 'scripts\worker-once.mjs'
    if (-not (Test-Path -LiteralPath $workerScript -PathType Leaf)) {
        throw 'Dry worker entrypoint missing'
    }
    $workerConfig = Join-Path $OpsRoot 'config\worker.local.json'
    $start = [System.Diagnostics.ProcessStartInfo]::new($node)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add($workerScript)
    $start.ArgumentList.Add($workerConfig)

    $process = [System.Diagnostics.Process]::Start($start)
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    try {
        $process.StandardInput.WriteLine($plain)
        $process.StandardInput.Close()
    } catch [System.IO.IOException] {
        # Child exited before consuming stdin; WaitForExit below reports the exit code.
    } finally {
        $plain = $null
    }

    if (-not $process.WaitForExit(30000)) {
        try { $process.Kill($true) } catch {}
        try { $process.WaitForExit(5000) | Out-Null } catch {}
        throw 'Dry worker timed out without invoking a site adapter'
    }
    $text = $output.GetAwaiter().GetResult()
    $null = $errors.GetAwaiter().GetResult()
    if ($text) { Write-Output $text.Trim() }
    exit $process.ExitCode
} finally {
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
