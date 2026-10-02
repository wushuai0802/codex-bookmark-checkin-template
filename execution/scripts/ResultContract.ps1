. (Join-Path $PSScriptRoot 'CheckinContract.generated.ps1')

function Test-CheckinEvidenceTimestamp([object]$Value, [datetimeoffset]$Now) {
    $confirmedAt = [datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$Value, [ref]$confirmedAt)) { return $false }
    return $confirmedAt -le $Now.AddMinutes(5)
}

function Test-FeatureDisabledEvidence($Evidence) {
    $source = [string]$Evidence.source
    if ($source -eq 'cached_confirmation') { $source = [string]$Evidence.originalSource }
    $outcome = [string]$Evidence.outcome
    return $CheckinFeatureDisabledEvidence.ContainsKey($source) -and $outcome -in $CheckinFeatureDisabledEvidence[$source]
}

function Test-ConfirmedNotAvailableResult($Result, [datetimeoffset]$Now = [datetimeoffset]::Now) {
    if ($null -eq $Result -or [string]$Result.status -ne 'not_available') { return $false }
    $kind = [string]$Result.availabilityKind
    if ($kind -notin @('feature_disabled', 'task_disabled', 'temporary_unavailable')) { return $false }
    if ($null -eq $Result.evidence -or $Result.evidence.authoritative -ne $true -or
        -not (Test-CheckinEvidenceTimestamp $Result.evidence.confirmedAt $Now)) { return $false }
    if ($kind -eq 'task_disabled') {
        return ($Result.disabledByConfig -eq $true -or $Result.disabledByAccountConfig -eq $true) -and [string]$Result.evidence.source -eq 'configuration'
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

function Get-CheckinAttentionClass($Result) {
    if (Test-TerminalCheckinResult $Result) { return 'resolved' }
    if ([string]$Result.failureCode -eq 'submission_outcome_unknown' -or $Result.submissionAttempted -eq $true) { return 'verification' }
    if ([string]$Result.siteCondition -eq 'site_maintenance' -or [string]$Result.failureCode -eq 'site_maintenance') { return 'external' }
    if ([string]$Result.retryCause -in $CheckinExternalRetryCauses) { return 'external' }
    if ([string]$Result.evidence.source -eq 'vibe_entitlement_status' -and [string]$Result.evidence.outcome -in @('entitlement_expired','entitlement_inactive','claim_not_enabled','claim_not_configured')) { return 'external' }
    return 'local'
}

# Pure readback contract: never click, navigate, or infer success from a loaded page.
function Get-NativeSuccessText([string]$BodyText) {
    $match = [regex]::Match($BodyText, '(?i)(?:今日|今天|当日|當日).{0,12}(?:已签到|已簽到|已经签到|已經簽到)|已完成今日签到|already checked[ -]?in today|checked in today|签到成功|簽到成功|本次(?:签到|簽到).{0,18}(?:获得|獲得)')
    if ($match.Success) { return $match.Value }
    $short = [regex]::Match($BodyText, '已经签到|已經簽到|已签到|已簽到')
    if ($short.Success) {
        $start = [Math]::Max(0, $short.Index - 24)
        return $BodyText.Substring($start, [Math]::Min(72, $BodyText.Length - $start))
    }
    return ''
}

function Test-NativeDailyControl([string]$Origin, [string]$Control) {
    $text = ($Control -replace '^[\[【]|[\]】]$', '').Trim()
    if ($text -match '^(?:今日|今天)?(?:已签到|已簽到|已经签到|已經簽到)$') { return $true }
    # Reviewed SaoBao header: this account's daily action becomes its reward.
    return $Origin -eq 'https://ptsbao.club' -and
        $text -match '^(?:签到已得|簽到已得)[0-9,.]+(?:,\s*补签卡:\s*\d+)?$'
}

function Get-ConfirmedNativePageEvidence($Snapshot, [string]$TargetUrl, [bool]$Clicked = $false, [datetimeoffset]$Now = [datetimeoffset]::UtcNow, [bool]$FormalVisit = $false) {
    if ($null -eq $Snapshot -or $Snapshot.sameOrigin -ne $true -or
        $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute) { return $null }
    try {
        $expected = [uri]$TargetUrl
        $actual = [uri][string]$Snapshot.currentUrl
        if ($expected.Scheme -ne 'https' -or $actual.Scheme -ne 'https' -or $expected.UserInfo -or $actual.UserInfo -or
            $expected.Port -ne $actual.Port -or
            ($expected.IdnHost.ToLowerInvariant() -replace '^www\.', '') -ne ($actual.IdnHost.ToLowerInvariant() -replace '^www\.', '')) { return $null }
    } catch { return $null }
    $headerOrigin = $expected.GetLeftPart([System.UriPartial]::Authority)
    $reviewedHeader = @($CheckinNativePtHeaderOrigins | Where-Object { ($_ -replace '^https://www\.', 'https://') -eq ($headerOrigin -replace '^https://www\.', 'https://') }).Count -gt 0
    $header = $reviewedHeader -and $Snapshot.authenticated -eq $true -and
        $actual.AbsolutePath -in @('/', '/index.php') -and -not $actual.Query -and
        (Test-NativeDailyControl $headerOrigin ([string]$Snapshot.successControl))
    if (-not $header -and $actual.AbsolutePath -notmatch '^/(?:attendance|check[-_]?in|showup)(?:\.php)?/?$') { return $null }
    $body = if ($Snapshot.successText) { [string]$Snapshot.successText } else { [string]$Snapshot.bodyText }
    $daily = $body -match '(?:今日|今天|当日|當日).{0,12}(?:已签到|已簽到|已经签到|已經簽到)|已完成今日签到|already checked[ -]?in today|checked in today'
    $action = ($Clicked -or $FormalVisit) -and $body -match '签到成功|簽到成功|本次(?:签到|簽到).{0,18}(?:获得|獲得)'
    $shortDailyEndpoint = $FormalVisit -and $reviewedHeader -and
        $actual.AbsolutePath -match '^/(?:attendance|check[-_]?in|showup)(?:\.php)?/?$' -and
        $body -match '已经签到|已經簽到|已签到|已簽到' -and
        $body -notmatch '(?:昨天|昨日|上次|历史|歷史).{0,24}(?:已签到|已簽到|已经签到|已經簽到)'
    if ($shortDailyEndpoint) {
        $day=$Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
        foreach($date in [regex]::Matches($body,'\d{4}-\d{2}-\d{2}')) { if($date.Value -ne $day){$shortDailyEndpoint=$false} }
    }
    if (-not $header -and -not $daily -and -not $action -and -not $shortDailyEndpoint) { return $null }
    return [pscustomobject]@{
        source = 'page_text'
        authoritative = $true
        confirmedAt = $Now.ToUniversalTime().ToString('o')
        businessDate = $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
        pagePath = $actual.AbsolutePath
        statusSignal = if ($header) { 'nexus_daily_header_signed' } else { 'same_day_page_text' }
    }
}

function Test-NativePageCompletion($Snapshot, [string]$Origin, $Evidence) {
    if ($Evidence.authoritative -eq $true) { return $true }
    $reviewedPt = @($CheckinNativePtHeaderOrigins | Where-Object { ($_ -replace '^https://www\.', 'https://') -eq ($Origin -replace '^https://www\.', 'https://') }).Count -gt 0
    # The new PT evidence contract must not replace unrelated mature site rules.
    return -not $reviewedPt -and $Snapshot.success -eq $true -and $Snapshot.sameOrigin -eq $true -and
        -not $Snapshot.waf -and -not $Snapshot.securityVerification -and -not $Snapshot.loginRoute
}
