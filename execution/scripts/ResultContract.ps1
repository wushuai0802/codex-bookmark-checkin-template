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

# Pure readback contract: never click, navigate, or infer success from a loaded page.
function Get-ConfirmedNativePageEvidence($Snapshot, [string]$TargetUrl, [bool]$Clicked = $false, [datetimeoffset]$Now = [datetimeoffset]::UtcNow) {
    if ($null -eq $Snapshot -or $Snapshot.success -ne $true -or $Snapshot.sameOrigin -ne $true -or
        $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute) { return $null }
    try {
        $expected = [uri]$TargetUrl
        $actual = [uri][string]$Snapshot.currentUrl
        if ($expected.Scheme -ne 'https' -or $actual.Scheme -ne 'https' -or $expected.UserInfo -or $actual.UserInfo -or
            $expected.Port -ne $actual.Port -or
            ($expected.IdnHost.ToLowerInvariant() -replace '^www\.', '') -ne ($actual.IdnHost.ToLowerInvariant() -replace '^www\.', '') -or
            $actual.AbsolutePath -notmatch '^/(?:attendance|check[-_]?in|showup)(?:\.php)?/?$') { return $null }
    } catch { return $null }
    $body = [string]$Snapshot.bodyText
    $daily = $body -match '(?:今日|今天|当日|當日).{0,12}(?:已签到|已簽到|已经签到|已經簽到)|已完成今日签到|already checked[ -]?in today|checked in today'
    $action = $Clicked -and $body -match '签到成功|簽到成功|本次(?:签到|簽到).{0,18}(?:获得|獲得)'
    if (-not $daily -and -not $action) { return $null }
    return [pscustomobject]@{
        source = 'page_text'
        authoritative = $true
        confirmedAt = $Now.ToUniversalTime().ToString('o')
        businessDate = $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
        pagePath = $actual.AbsolutePath
        statusSignal = 'same_day_page_text'
    }
}
