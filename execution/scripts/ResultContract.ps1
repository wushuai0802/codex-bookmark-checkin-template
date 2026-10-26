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
    if ($Result.notificationAvailabilityObserved -eq $true -and (
        [string]$Result.availability.condition -eq 'site_maintenance' -or
        ([string]$Result.availability.condition -eq 'upstream_unavailable' -and [string]$Result.availability.failureCode -in $CheckinSiteFaultCodes))) { return 'external' }
    if ([string]$Result.failureCode -eq 'submission_outcome_unknown' -or $Result.submissionAttempted -eq $true) { return 'verification' }
    if ([string]$Result.siteCondition -eq 'site_maintenance' -or [string]$Result.failureCode -eq 'site_maintenance') { return 'external' }
    if ([string]$Result.failureCode -in @('site_migration','bookmark_origin_changed')) { return 'external' }
    if ([string]$Result.retryCause -in $CheckinExternalRetryCauses) { return 'external' }
    if ([string]$Result.evidence.source -eq 'vibe_entitlement_status' -and [string]$Result.evidence.outcome -in @('entitlement_expired','entitlement_inactive','claim_not_enabled','claim_not_configured')) { return 'external' }
    return 'local'
}

# Pure readback contract: never click, navigate, or infer success from a loaded page.
function Get-NativeBrowserFailure([string]$BodyText) {
    if ($BodyText -match '欢迎回来|歡迎回來|分享率|控制面板|个人资料|個人資料|爆米花') { return '' }
    if ($BodyText -notmatch '无法访问此网站|無法連上這個網站|This site can.t be reached|Your connection is not private|您的连接不是私密连接|你的連線不是私人連線') { return '' }
    if ($BodyText -match '\b(?:NET::)?ERR_CERT_[A-Z_]+\b') { return 'tls_certificate_invalid' }
    if ($BodyText -match '\bERR_SSL_(?:PROTOCOL_ERROR|VERSION_OR_CIPHER_MISMATCH)\b') { return 'tls_handshake_failed' }
    if ($BodyText -match '\bERR_[A-Z_]{3,70}\b') { return 'network_error' }
    return ''
}

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

function Test-NativeOtpInputLabel([string]$Name, [string]$AutomationId) {
    return $Name -match '(?i)二级|二級|两步|兩步|2FA|TOTP|OTP|验证代码|驗證代碼|验证码|驗證碼|verification code|authenticator|one[ -]?time' -or
        $AutomationId -match '(?i)^(?:code|otp|totp|2fa|twofactor|two_factor|auth_code|verification_code)$'
}

function Test-NativeScopedOtpInput($Element) {
    # An unnamed input can belong to a small IYUU/secondary-verification
    # panel. Inspect only bounded ancestor structure, never ValuePattern,
    # entered values or the whole document/window.
    $ancestor = $Element
    for ($depth = 0; $depth -lt 4; $depth++) {
        try {
            $ancestor = [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($ancestor)
            if ($null -eq $ancestor -or $ancestor.Current.ControlType.ProgrammaticName -in @('ControlType.Document','ControlType.Window')) { break }
            if ($ancestor.Current.ControlType.ProgrammaticName -notin @('ControlType.Group','ControlType.Pane','ControlType.Custom','ControlType.DataItem')) { continue }
            $nearby = @($ancestor.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
            if ($nearby.Count -gt 20 -or @($nearby | Where-Object { $_.Current.ControlType.ProgrammaticName -ceq 'ControlType.Edit' }).Count -ne 1 -or
                @($nearby | Where-Object { $_.Equals($Element) }).Count -ne 1) { continue }
            $names = @(@($ancestor) + $nearby | Where-Object { $_.Current.ControlType.ProgrammaticName -cne 'ControlType.Edit' } |
                ForEach-Object { [string]$_.Current.Name } | Where-Object { $_.Length -le 512 })
            $context = $names -join ' '
            if ($context.Length -gt 1200) { continue }
            if ($context -match '(?i)搜索|搜尋|\bsearch\b') { return $false }
            if ($context -match '(?i)\b2FA\b|二级验证|二級驗證' -and
                $context -match '(?i)\bIYUU\b|忘记二级验证|忘記二級驗證|自助解绑|自助解綁') { return $true }
        } catch { return $false }
    }
    return $false
}

function Get-NativeSecurityState([string]$BodyText, [uri]$CurrentUri, [bool]$OtpInputPresent, [bool]$PasswordInputPresent, [int]$EditCount, [bool]$ScopedOtpInputPresent = $false) {
    $route = $null -ne $CurrentUri -and $CurrentUri.AbsolutePath -match '^/(?:take2fa|twofactor|2fa)\.php$'
    $remote = $BodyText -match '异地登录安全验证|異地登錄安全驗證'
    $recovery = $BodyText -match '忘记二级验证|忘記二級驗證'
    $codeText = $BodyText -match '二级验证代码|二級驗證碼'
    $prompt = $BodyText -match '(?i)(?:请输入|請輸入|请填写|請填寫|需要输入|需要輸入|要求输入|要求輸入).{0,24}(?:二级验证代码|二級驗證碼|(?:两步|兩步|二步|2FA|TOTP|OTP|动态|動態|一次性).{0,16}(?:代码|代碼|code))|(?:异地登录安全验证|異地登錄安全驗證).{0,30}(?:二级验证代码|二級驗證碼)'
    $rules = @(if($remote){'remote_login_text'};if($recovery){'secondary_recovery_link'};if($codeText){'secondary_code_text'};
        if($prompt){'explicit_secondary_prompt'};if($route){'verification_route'};if($ScopedOtpInputPresent){'scoped_secondary_input'})
    # Recovery/settings links do not establish an active challenge. A real
    # code prompt, a labelled secondary-code field, or an editable dedicated
    # verification page still blocks unattended execution. Ordinary check-in
    # image captchas are not classified as account 2FA.
    return [pscustomobject]@{
        securityVerification = [bool]($prompt -or ($codeText -and $OtpInputPresent) -or $ScopedOtpInputPresent -or ($route -and $EditCount -gt 0))
        nativeSecurityDiagnostic = [pscustomobject]@{verificationRoute=[bool]$route;otpInputPresent=$OtpInputPresent;
            scopedOtpInputPresent=$ScopedOtpInputPresent;passwordInputPresent=$PasswordInputPresent;matchedRules=$rules}
    }
}

function Test-NativeDailyControl([string]$Origin, [string]$Control) {
    $text = ($Control -replace '^[\[【]|[\]】]$', '').Trim()
    if ($text -match '^(?:今日|今天)?(?:已签到|已簽到|已经签到|已經簽到)$') { return $true }
    # Reviewed SaoBao header: this account's daily action becomes its reward.
    return $Origin -eq 'https://ptsbao.club' -and
        $text -match '^(?:签到已得|簽到已得)[0-9,.]+(?:,\s*补签卡:\s*\d+)?$'
}

function Test-NativeAudiencesDailyHeader($Snapshot, [string]$Origin) {
    if ($Origin -cne 'https://audiences.me' -or $null -eq $Snapshot -or
        $Snapshot.sameOrigin -ne $true -or $Snapshot.pageContentAvailable -ne $true -or
        $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute) { return $false }
    $body = [string]$Snapshot.bodyText
    # Audiences renders the authenticated account header as a reward counter
    # instead of a separate signed control. Require its account-only daily
    # reward marker plus the stable account statistics before accepting it.
    return $body -cmatch '(?:^|\s)已签到\s*\+\s*[0-9,.]+' -and
        $body -cmatch '爆米花' -and $body -cmatch 'H&R'
}

function Test-NativeUnsignedControl([string]$Origin, [string]$Control) {
    $text = ($Control -replace '^[\[【]|[\]】]$', '').Trim()
    return $CheckinNativePtUnsignedLabels.ContainsKey($Origin) -and
        $text -cin $CheckinNativePtUnsignedLabels[$Origin]
}

function Measure-NativeOurbitsAccountHeader([string]$Text, [int]$LogoutCount, [string[]]$Controls, [bool]$HasPassword = $false, [datetimeoffset]$Now = [datetimeoffset]::UtcNow) {
    # This input is one account Group, never document text. Do not return its
    # account names, balances, labels or identifiers with these structural facts.
    $stats = 0
    foreach ($label in @('上传|上傳', '下载|下載', '分享率', '魔力')) { if ($Text -match $label) { $stats++ } }
    $rewards = [regex]::Matches($Text, '签到已得').Count
    $unsigned = @($Controls | Where-Object { Test-NativeUnsignedControl 'https://ourbits.club' $_ }).Count
    $clear = -not $HasPassword -and $Text.Length -le 1200 -and
        $Text -notmatch '(?i)历史|歷史|累计|累計|昨日|昨天|上次|密码|密碼|password|验证|驗證|2FA|登录|登錄|登入|login|sign[ -]?in|ERR_[A-Z_]+|无法访问|無法連|Error|Just a moment|Cloudflare'
    $day = $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
    foreach ($date in [regex]::Matches($Text, '\d{4}-\d{2}-\d{2}')) { if ($date.Value -cne $day) { $clear = $false } }
    $account = $LogoutCount -eq 1 -and $stats -eq 4 -and $clear
    # Reuse Ourbits' mature self-profile reward rule, but additionally require
    # a unique reward in this very account Group and no live unsigned action.
    $daily = $account -and $rewards -eq 1 -and $unsigned -eq 0 -and
        $Text -match '(?:^|[\s(（])签到已得[0-9,.]+(?:$|[\s)）])'
    return [pscustomobject]@{
        accountHeaderVerified = [bool]$account
        ourbitsDailyHeaderVerified = [bool]$daily
        ourbitsHeaderLogoutCount = $LogoutCount
        ourbitsHeaderStatsCount = $stats
        ourbitsHeaderRewardCount = $rewards
        ourbitsHeaderUnsignedControlCount = $unsigned
        ourbitsHeaderContextClear = [bool]$clear
    }
}

function Test-NativeOurbitsDailyHeader($Snapshot, [string]$Origin) {
    if ($Origin -cne 'https://ourbits.club' -or $null -eq $Snapshot -or
        $Snapshot.sameOrigin -ne $true -or $Snapshot.authenticated -ne $true -or
        $Snapshot.pageContentAvailable -ne $true -or $Snapshot.siteBodyLoaded -ne $true -or
        $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute -or $Snapshot.browserFailureCode -or
        $Snapshot.signedControlCount -ne 0 -or $Snapshot.unsignedControlCount -ne 0 -or
        $Snapshot.successControl -or $Snapshot.unsignedControl -or
        $Snapshot.ourbitsDailyHeaderVerified -isnot [bool] -or $Snapshot.ourbitsDailyHeaderVerified -ne $true -or
        $Snapshot.ourbitsHeaderContextClear -isnot [bool] -or $Snapshot.ourbitsHeaderContextClear -ne $true) { return $false }
    foreach ($pair in @(@('ourbitsHeaderLogoutCount', 1), @('ourbitsHeaderStatsCount', 4),
            @('ourbitsHeaderRewardCount', 1), @('ourbitsHeaderUnsignedControlCount', 0))) {
        $value = $Snapshot.($pair[0])
        if (($value -isnot [int] -and $value -isnot [long]) -or $value -ne $pair[1]) { return $false }
    }
    try {
        $uri = [uri][string]$Snapshot.currentUrl
        return $uri.GetLeftPart([System.UriPartial]::Authority) -ceq $Origin -and -not $uri.UserInfo -and
            -not $uri.Query -and -not $uri.Fragment -and $uri.AbsolutePath -cin @('/index.php', '/attendance.php')
    } catch { return $false }
}

function Test-NativeAttendanceError($Snapshot, [string]$Origin) {
    if ($Origin -cne 'https://ptsbao.club' -or $null -eq $Snapshot -or
        $Snapshot.sameOrigin -ne $true -or $Snapshot.authenticated -ne $true -or
        $Snapshot.pageContentAvailable -ne $true -or $Snapshot.waf -or
        $Snapshot.securityVerification -or $Snapshot.loginRoute -or $Snapshot.success) { return $false }
    try {
        $uri = [uri][string]$Snapshot.currentUrl
        return $uri.AbsoluteUri -ceq ($Origin + '/attendance.php') -and
            [string]$Snapshot.bodyText -cmatch '(?:^|\s)Error(?:\s|$)'
    } catch { return $false }
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
    $audiencesHeader = Test-NativeAudiencesDailyHeader $Snapshot $headerOrigin
    $ourbitsHeader = Test-NativeOurbitsDailyHeader $Snapshot $headerOrigin
    $header = $reviewedHeader -and ($Snapshot.authenticated -eq $true -or $audiencesHeader) -and
        ($actual.AbsolutePath -in @('/', '/index.php') -or $ourbitsHeader) -and -not $actual.Query -and
        ((($audiencesHeader -or $ourbitsHeader) -and $Snapshot.signedControlCount -eq 0) -or
            $null -eq $Snapshot.signedControlCount -or $Snapshot.signedControlCount -eq 1) -and
        ($null -eq $Snapshot.unsignedControlCount -or $Snapshot.unsignedControlCount -eq 0) -and
        ($audiencesHeader -or $ourbitsHeader -or (Test-NativeDailyControl $headerOrigin ([string]$Snapshot.successControl)))
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

function Get-ConfirmedNativeUnsignedEvidence($Snapshot, [string]$TargetUrl, [datetimeoffset]$Now = [datetimeoffset]::UtcNow) {
    # Only an exact reviewed account-header control proves not-signed.
    # Absence of a success message alone never permits another submission.
    try {
        $expected = [uri]$TargetUrl
        $actual = [uri][string]$Snapshot.currentUrl
        $origin = $expected.GetLeftPart([System.UriPartial]::Authority)
        if ($expected.Scheme -cne 'https' -or $expected.UserInfo -or
            $expected.AbsoluteUri -cne ($origin + '/index.php') -or
            $actual.Scheme -cne 'https' -or $actual.UserInfo -or $actual.Port -ne $expected.Port -or
            ($actual.IdnHost.ToLowerInvariant() -replace '^www\.', '') -cne ($expected.IdnHost.ToLowerInvariant() -replace '^www\.', '') -or
            $actual.AbsolutePath -cne '/index.php' -or $actual.Query -or $actual.Fragment -or
            -not $CheckinNativePtUnsignedLabels.ContainsKey($origin)) { return $null }
    } catch { return $null }
    if ($origin -ceq 'https://ourbits.club' -and $null -ne $Snapshot.ourbitsHeaderRewardCount -and
        $Snapshot.ourbitsHeaderRewardCount -ne 0) { return $null }
    if ($null -eq $Snapshot -or $Snapshot.sameOrigin -ne $true -or $Snapshot.authenticated -ne $true -or $Snapshot.pageContentAvailable -ne $true -or
        $Snapshot.siteBodyLoaded -ne $true -or $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute -or
        $Snapshot.success -ne $false -or $Snapshot.successText -or $Snapshot.successControl -or
        $Snapshot.signedControlCount -ne 0 -or $Snapshot.unsignedControlCount -ne 1 -or
        -not (Test-NativeUnsignedControl $origin ([string]$Snapshot.unsignedControl))) { return $null }
    return [pscustomobject]@{
        source = 'page_text'
        authoritative = $true
        confirmedAt = $Now.ToUniversalTime().ToString('o')
        businessDate = $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
        pagePath = '/index.php'
        statusSignal = 'nexus_daily_header_unsigned'
    }
}

function Test-NativePageCompletion($Snapshot, [string]$Origin, $Evidence, [datetimeoffset]$Now = [datetimeoffset]::UtcNow) {
    if ($Evidence.authoritative -eq $true) {
        if ($Origin -ceq 'https://ourbits.club' -and $Evidence.statusSignal -ceq 'nexus_daily_header_signed' -and $Snapshot.signedControlCount -eq 0) {
            $at = [datetimeoffset]::MinValue
            return (Test-NativeOurbitsDailyHeader $Snapshot $Origin) -and
                [datetimeoffset]::TryParse([string]$Evidence.confirmedAt, [ref]$at) -and $at -le $Now -and $at -ge $Now.AddMinutes(-5) -and
                $Evidence.businessDate -ceq $Now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -and
                $at.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd') -ceq [string]$Evidence.businessDate -and
                $Evidence.pagePath -ceq ([uri][string]$Snapshot.currentUrl).AbsolutePath
        }
        return $true
    }
    $reviewedPt = @($CheckinNativePtHeaderOrigins | Where-Object { ($_ -replace '^https://www\.', 'https://') -eq ($Origin -replace '^https://www\.', 'https://') }).Count -gt 0
    # The new PT evidence contract must not replace unrelated mature site rules.
    return -not $reviewedPt -and $Snapshot.success -eq $true -and $Snapshot.sameOrigin -eq $true -and
        -not $Snapshot.waf -and -not $Snapshot.securityVerification -and -not $Snapshot.loginRoute
}
