# Route existing launchers through the V2 controller when V1 engine mode is
# selected. The controller's child re-enters only with a live matching lease.
function Invoke-V2EngineGateway {
    param([string]$Mode, [hashtable]$Parameters = @{})
    $integrationFile = Join-Path $root 'data\v2-integration.json'
    if (-not (Test-Path -LiteralPath $integrationFile)) { return $false }
    $integration = Get-Content -LiteralPath $integrationFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($integration.executionEngine -ne 'v1') { return $false }
    # Only a quiet dry run may use an isolated test configuration outside the
    # controller. An executing alternate configuration must not bypass the lease.
    if ($Parameters.ContainsKey('ConfigPath') -and $Parameters.ConfigPath) {
        $alternateConfig = [System.IO.Path]::GetFullPath([string]$Parameters.ConfigPath) -ne [System.IO.Path]::GetFullPath((Join-Path $root 'config\config.json'))
        if ($alternateConfig) {
            if ($Parameters.DryRun -and $Parameters.SuppressReport) { return $false }
            throw 'Alternate configuration cannot execute outside the V2 controller'
        }
    }
    $cli = Join-Path ([string]$integration.v2ProjectRoot) 'scripts\run-v1-engine.mjs'
    $engineNode = [string]$integration.nodeExecutable
    if (-not (Test-Path -LiteralPath $cli) -or -not (Test-Path -LiteralPath $engineNode)) { throw 'V2 engine gateway unavailable' }
    if ($env:CHECKIN_V2_ENGINE_LEASE) {
        & $engineNode $cli --validate-lease --legacy-root $root | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'V2 engine lease rejected' }
        return $false
    }
    foreach ($unsupported in @('ManualConfirmedOrigins','TemporarilyUnavailableOrigins')) {
        if ($Parameters.ContainsKey($unsupported) -and $Parameters[$unsupported]) { throw "Unsupported unified-engine argument: $unsupported" }
    }
    $forward = @($cli)
    if ($Mode -eq 'scheduled') { $forward += '--scheduled' }
    elseif ($Parameters.DryRun) { $forward += '--dry-run' }
    else { $forward += '--execute' }
    foreach ($key in @($Parameters.AccountKeys)) { if ($key) { $forward += @('--account-key', [string]$key) } }
    foreach ($origin in @($Parameters.Origins)) { if ($origin) { $forward += @('--origin', [string]$origin) } }
    # Existing scheduled notification delivery stays in the original scheduler.
    # Ad-hoc gateway calls are quiet unless the caller explicitly requests it.
    & $engineNode @forward | Out-Host
    $script:V2EngineExitCode = $LASTEXITCODE
    return $true
}
