param([ValidateSet('preflight', 'wrapper', 'scheduler')][string]$Mode, [string]$Origins = '')

$ErrorActionPreference = 'Stop'
function Get-Date {
    param([string]$Format)
    $date = ([datetimeoffset]::Parse($env:CHECKIN_CHAIN_NOW)).LocalDateTime
    if ($Format) { return $date.ToString($Format) }
    return $date
}
function Invoke-WebRequest { throw 'Offline chain forbids network requests' }
function Invoke-RestMethod { throw 'Offline chain forbids network requests' }

# Replace only OS process dispatch. Both executable branches still run the
# unmodified entry scripts/index, synchronously, so no background child can
# survive the test. Notification scripts in this temporary root are inert.
function Start-Process {
    param([string]$FilePath, [object[]]$ArgumentList, [switch]$NoNewWindow,
        [switch]$PassThru, [string]$WindowStyle)
    $call = [pscustomobject]@{file = [IO.Path]::GetFileName($FilePath); args = @($ArgumentList)}
    [IO.File]::AppendAllText((Join-Path $env:CHECKIN_CHAIN_ROOT 'tmp/process-calls.jsonl'), ($call | ConvertTo-Json -Compress) + "`n")
    if ($FilePath -eq $env:CHECKIN_CHAIN_NODE) {
        & $FilePath @ArgumentList | Out-Host
        $code = $LASTEXITCODE
    } elseif ([IO.Path]::GetFileNameWithoutExtension($FilePath) -in @('pwsh', 'powershell')) {
        $fileIndex = [array]::IndexOf($ArgumentList, '-File')
        if ($fileIndex -lt 0 -or [IO.Path]::GetFileName(([string]$ArgumentList[$fileIndex + 1]).Trim('"')) -ne 'Run-Checkin.ps1') {
            throw 'Unexpected scheduler process'
        }
        $originIndex = [array]::IndexOf($ArgumentList, '-Origins')
        $forward = if ($originIndex -ge 0) { @('-Origins', [string]$ArgumentList[$originIndex + 1]) } else { @() }
        & $FilePath -NoProfile -NonInteractive -File (Join-Path $env:CHECKIN_CHAIN_ROOT 'tmp/chain-runner.ps1') -Mode wrapper @forward | Out-Host
        $code = $LASTEXITCODE
    } else { throw 'Unexpected offline process' }
    $process = [pscustomobject]@{Id = $PID; StartTime = (Get-Date); ExitCode = $code; HasExited = $true}
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $true }
    $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    return $process
}

switch ($Mode) {
    preflight {
        & (Join-Path $env:CHECKIN_CHAIN_ROOT 'scripts/Prepare-NativeWafSession.ps1') -Origins ($Origins -split ',')
        exit 0
    }
    wrapper {
        $selected = if ($Origins) { @{Origins = $Origins} } else { @{} }
        & (Join-Path $env:CHECKIN_CHAIN_ROOT 'scripts/Run-Checkin.ps1') -Attempts 1 -SuppressReport @selected
        exit $LASTEXITCODE
    }
    scheduler {
        & (Join-Path $env:CHECKIN_CHAIN_ROOT 'scripts/Start-UserScheduler.ps1') -Once
        exit $LASTEXITCODE
    }
}
