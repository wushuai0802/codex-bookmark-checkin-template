function Remove-RunLockOwnedByProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$LockPath,
        [Parameter(Mandatory)][int]$ProcessId,
        [Parameter(Mandatory)][datetime]$ProcessStartedAt
    )

    if (-not (Test-Path -LiteralPath $LockPath -PathType Leaf)) { return $false }
    try {
        $owner = Get-Content -Raw -Encoding UTF8 -LiteralPath $LockPath | ConvertFrom-Json
        if ([int]$owner.pid -ne $ProcessId -or [string]::IsNullOrWhiteSpace([string]$owner.nonce)) { return $false }
        if (-not [string]::IsNullOrWhiteSpace([string]$owner.processStartedAt)) {
            $recordedStart = ([datetime]$owner.processStartedAt).ToUniversalTime()
            $expectedStart = $ProcessStartedAt.ToUniversalTime()
            if ([Math]::Abs(($recordedStart - $expectedStart).TotalSeconds) -gt 5) { return $false }
        }
        Remove-Item -LiteralPath $LockPath -Force
        return $true
    }
    catch {
        return $false
    }
}
