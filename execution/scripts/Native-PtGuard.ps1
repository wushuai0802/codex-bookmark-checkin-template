# Per-helper state. It is deliberately separate from Chrome's authenticated data.
function Invoke-NativePtGate([string]$Phase, [string]$Action = '', $Result = $null) {
    $state = $script:NativePtGuard
    $arguments = @((Join-Path $state.root 'scripts/Native-PtGate.mjs'), '--origin', $state.origin, '--url', $state.url,
        '--profile', $state.profile, '--main-profile', ([string]$state.mainProfile).ToLowerInvariant(), '--phase', $Phase,
        '--attempt', $state.attemptId)
    if ($Action) { $arguments += @('--action', $Action) }
    if ($Phase -eq 'finish') {
        $json = ConvertTo-Json -InputObject $Result.evidence -Compress -Depth 8
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        $arguments += @('--status', [string]$Result.status, '--evidence64', $encoded)
    }
    $value = & $state.node @arguments
    if (-not $value) { throw 'Native PT guard returned no decision' }
    return ($value | ConvertFrom-Json)
}

function Initialize-NativePtGuard {
    param([string]$Root,[string]$Origin,[string]$Url,[string]$ProfilePath,[switch]$MainProfile,[switch]$ReadOnly)
    . (Join-Path $Root 'scripts/Resolve-Runtime.ps1')
    $configuration = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Root 'config/config.json') | ConvertFrom-Json
    $script:NativePtGuard = @{root=$Root;origin=$Origin;url=$Url;profile=$ProfilePath;mainProfile=[bool]$MainProfile;
        readOnly=[bool]$ReadOnly;node=(Resolve-CheckinNode $configuration);attemptId=([guid]::NewGuid().ToString());attempted=$false;managed=$false;navigationRisk=$false}
    if ($ReadOnly) { return $null }
    $gate = Invoke-NativePtGate 'inspect'
    $script:NativePtGuard.managed = [bool]$gate.managed
    $script:NativePtGuard.navigationRisk = [bool]$gate.navigationRisk
    if (-not $gate.allow) { return $gate.decision }
    return $null
}

function Test-NativePtNavigationRisk {
    return $script:NativePtGuard -and -not $script:NativePtGuard.readOnly -and $script:NativePtGuard.navigationRisk
}

function Start-NativePtWrite([ValidateSet('navigation','click')][string]$Action) {
    if (-not $script:NativePtGuard -or $script:NativePtGuard.readOnly) { throw 'Native write guard is not initialized for execution' }
    $gate = Invoke-NativePtGate 'begin' $Action
    if (-not $gate.allow) {
        $errorObject = [InvalidOperationException]::new('Native PT submission stopped')
        $errorObject.Data['NativePtDecision'] = $gate.decision
        throw $errorObject
    }
    $script:NativePtGuard.attempted = $true
}

function Get-NativePtFailure($ErrorRecord) {
    $decision = $ErrorRecord.Exception.Data['NativePtDecision']
    if ($null -ne $decision -and -not $script:NativePtGuard.attempted) { return $decision }
    $attempted = $script:NativePtGuard -and $script:NativePtGuard.attempted
    return [pscustomobject]@{status=if($attempted){'needs_attention'}else{'unconfirmed'};
        failureCode=if($attempted){'submission_outcome_unknown'}else{'accessibility_unavailable'};
        submissionAttempted=[bool]$attempted;retryable=if($attempted){$false}else{$null};
        reason=if($attempted){'原生签到可能已提交，先只读核验，禁止自动重放'}else{'原生 Chrome 可访问性检查未能完成'}}
}

function Complete-NativePtResult {
    [CmdletBinding()]
    param([Parameter(ValueFromPipeline=$true)]$Result)
    process {
        $state = $script:NativePtGuard
        $attempted = ($state -and $state.attempted) -or [bool]$Result.submissionAttempted -or [bool]$Result.clicked -or [bool]$Result.checkinClicked
        if ($attempted) {
            $Result | Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $true -Force
            $confirmed = [string]$Result.status -in @('signed','already_signed')
            if ($state.managed -and $confirmed) {
                try {
                    $at = [datetimeoffset]$Result.evidence.confirmedAt
                    $now = [datetimeoffset]::UtcNow
                    $day = $now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
                    $confirmed = $Result.evidence.authoritative -eq $true -and $at -le $now.AddSeconds(60) -and
                        $at.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -eq $day -and [string]$Result.evidence.businessDate -eq $day
                } catch { $confirmed = $false }
            }
            if (-not $confirmed) {
                $Result | Add-Member -NotePropertyName status -NotePropertyValue 'needs_attention' -Force
                $Result | Add-Member -NotePropertyName failureCode -NotePropertyValue 'submission_outcome_unknown' -Force
                $Result | Add-Member -NotePropertyName retryable -NotePropertyValue $false -Force
                $Result | Add-Member -NotePropertyName reason -NotePropertyValue '原生签到可能已提交，先只读核验，禁止自动重放' -Force
            }
            if ($state.managed -and $state.attempted) {
                try { $saved = Invoke-NativePtGate 'finish' '' $Result } catch { $saved = $null }
                # A failed save leaves the durable pre-action intent pending.
                if ($saved.profileBinding) { $Result | Add-Member -NotePropertyName profileBinding -NotePropertyValue $saved.profileBinding -Force }
            }
        } else { $Result | Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $false -Force }
        return $Result
    }
}
