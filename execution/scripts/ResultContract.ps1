function Test-CheckinEvidenceTimestamp([object]$Value, [datetimeoffset]$Now) {
    $confirmedAt = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Value, [ref]$confirmedAt)) { return $false }
    return $confirmedAt -le $Now.AddMinutes(5)
}

function Test-FeatureDisabledEvidence($Evidence) {
    $source = [string]$Evidence.source
    if ($source -eq 'cached_confirmation') { $source = [string]$Evidence.originalSource }
    $outcome = [string]$Evidence.outcome
    switch ($source) {
        'bmapi_checkin_status' { return $outcome -eq 'enabled_false' }
        'new_api_checkin_status' { return $outcome -eq 'message_not_enabled' }
        'new_api_checkin_action' { return $outcome -eq 'message_not_enabled' }
        default { return $false }
    }
}

function Test-ConfirmedNotAvailableResult($Result, [datetimeoffset]$Now = [datetimeoffset]::Now) {
    if ($null -eq $Result -or [string]$Result.status -ne 'not_available') { return $false }
    $kind = [string]$Result.availabilityKind
    if ($kind -notin @('feature_disabled', 'task_disabled', 'temporary_unavailable')) { return $false }
    if ($null -eq $Result.evidence -or $Result.evidence.authoritative -ne $true -or
        -not (Test-CheckinEvidenceTimestamp $Result.evidence.confirmedAt $Now)) { return $false }
    if ($kind -eq 'task_disabled') {
        return $Result.disabledByConfig -eq $true -and [string]$Result.evidence.source -eq 'configuration'
    }
    if ($kind -eq 'temporary_unavailable') {
        return $Result.temporarilyUnavailable -eq $true -and [string]$Result.evidence.source -eq 'operator_confirmation'
    }
    return $Result.disabledByConfig -ne $true -and $Result.temporarilyUnavailable -ne $true -and
        (Test-FeatureDisabledEvidence $Result.evidence)
}

function Test-TerminalCheckinResult($Result) {
    if ([string]$Result.status -in @('signed', 'already_signed')) { return $true }
    return Test-ConfirmedNotAvailableResult $Result
}
