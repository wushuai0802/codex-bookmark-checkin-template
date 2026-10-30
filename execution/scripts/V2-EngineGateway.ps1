# Route existing launchers through the V2 controller when V1 engine mode is
# selected. The controller's child re-enters only with a live matching lease.
function Invoke-V2EngineGateway {
    param([string]$Mode, [hashtable]$Parameters = @{})
    . (Join-Path $PSScriptRoot 'Gateway-Audit.ps1')
    $stage = 'integration'; $code = 'GATEWAY_CONFIG_INVALID'
    $scheduledProbe = $Mode -eq 'scheduled' -and -not $env:CHECKIN_V2_ENGINE_LEASE
    try {
    $integrationFile = Join-Path $root 'data\v2-integration.json'
    if (-not (Test-Path -LiteralPath $integrationFile)) { return $false }
    $integration = Get-Content -LiteralPath $integrationFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($integration.executionEngine -ne 'v1') { return $false }
    $stage = 'arguments'; $code = 'GATEWAY_ARGUMENT_REJECTED'
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
    $stage = 'dispatch'; $code = 'GATEWAY_UNAVAILABLE'
    if (-not (Test-Path -LiteralPath $cli) -or -not (Test-Path -LiteralPath $engineNode)) { throw 'V2 engine gateway unavailable' }
    if ($env:CHECKIN_V2_ENGINE_LEASE) {
        $stage = 'lease'; $code = 'GATEWAY_LEASE_REJECTED'
        & $engineNode $cli --validate-lease --legacy-root $root | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'V2 engine lease rejected' }
        return $false
    }
    foreach ($unsupported in @('ManualConfirmedOrigins','TemporarilyUnavailableOrigins')) {
        $stage = 'arguments'; $code = 'GATEWAY_ARGUMENT_REJECTED'
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
    $stage = 'dispatch'; $code = 'GATEWAY_CHILD_FAILED'
    $PSNativeCommandUseErrorActionPreference = $false
    $gatewayOutput = @(& $engineNode @forward 2>&1)
    $script:V2EngineExitCode = $LASTEXITCODE
    if ($script:V2EngineExitCode -ne 0) {
        foreach ($line in $gatewayOutput) {
            try {
                $diagnostic = ([string]$line) | ConvertFrom-Json
                if ($diagnostic.gatewayError) {
                    $code = Get-CheckinGatewayCode ([string]$diagnostic.gatewayError.code)
                    $stage = Get-CheckinGatewayStage ([string]$diagnostic.gatewayError.stage)
                }
            } catch { }
        }
        try { Write-CheckinGatewayEvent -Root $root -Stage $stage -Code $code -ExitCode $script:V2EngineExitCode }
        catch { Write-Warning 'Gateway audit could not be persisted' }
        Write-Host "V2 V1-engine gateway failed: $code"
        if ($scheduledProbe) { Register-CheckinGatewayOutcome $root $false $code }
    } else {
        $gatewayOutput | Out-Host
        $busy = $false
        foreach ($line in $gatewayOutput) {
            try { if ((([string]$line) | ConvertFrom-Json).reason -eq 'executor_busy') { $busy=$true } } catch { }
        }
        if ($scheduledProbe -and -not $busy) { Register-CheckinGatewayOutcome $root $true '' }
    }
    return $true
    } catch {
        try { Write-CheckinGatewayEvent -Root $root -Stage $stage -Code $code -ExitCode 1 }
        catch { Write-Warning 'Gateway audit could not be persisted' }
        if ($scheduledProbe) { Register-CheckinGatewayOutcome $root $false $code }
        throw
    }
}
