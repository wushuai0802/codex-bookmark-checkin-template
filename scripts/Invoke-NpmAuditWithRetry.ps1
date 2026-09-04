[CmdletBinding()]
param(
    [ValidateRange(1, 5)]
    [int]$MaxAttempts = 3,
    [int[]]$RetryDelaySeconds = @(15, 30, 60)
)

$ErrorActionPreference = 'Stop'
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) "checkin-npm-audit-$PID-$([guid]::NewGuid().ToString('N')).json"
$lastOutput = ''

function Test-TransientAuditFailure([string]$Output) {
    return $Output -match '(?i)(\bHTTP\s*(?:503|429)\b|\b(?:503|429)\s+(?:service unavailable|too many requests)\b|service unavailable|too many requests|eai_again|enetwork|enetunreach|econnrefused|econnreset|etimedout|timed out|network timeout|fetch failed|socket hang up|network request failed)'
}

try {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        & npm audit --omit=dev --json --fetch-timeout=30000 --fetch-retries=0 *> $temporary
        $exitCode = [int]$LASTEXITCODE
        $lastOutput = if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Get-Content -LiteralPath $temporary -Raw -ErrorAction SilentlyContinue
        }
        else { '' }

        if ($exitCode -eq 0) {
            if ($lastOutput) { Write-Output $lastOutput.TrimEnd() }
            exit 0
        }

        if (-not (Test-TransientAuditFailure $lastOutput)) {
            if ($lastOutput) { Write-Output $lastOutput.TrimEnd() }
            exit $exitCode
        }

        if ($attempt -lt $MaxAttempts) {
            $delayIndex = [Math]::Min($attempt - 1, $RetryDelaySeconds.Count - 1)
            $delay = [Math]::Max(1, [int]$RetryDelaySeconds[$delayIndex])
            Write-Warning "npm audit temporary service failure on attempt $attempt/$MaxAttempts; retrying in $delay seconds."
            Start-Sleep -Seconds $delay
        }
    }

    if ($lastOutput) { Write-Output $lastOutput.TrimEnd() }
    Write-Error "npm audit remained unavailable after $MaxAttempts attempts."
    exit 1
}
finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
}
