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
    if ($Phase -eq 'readback') {
        $json = ConvertTo-Json -InputObject $Result -Compress -Depth 8
        $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
        $arguments += @('--receipt64', $encoded)
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
    $gate = Invoke-NativePtGate $(if ($ReadOnly) { 'bind' } else { 'inspect' })
    $script:NativePtGuard.managed = [bool]$gate.managed
    $script:NativePtGuard.navigationRisk = [bool]$gate.navigationRisk
    $script:NativePtGuard.unsignedConfirmedAt = [string]$gate.unsignedConfirmedAt
    if ([string]$gate.profileBinding -cmatch '^[a-f0-9]{64}$') { $script:NativePtGuard.profileBinding = [string]$gate.profileBinding }
    if ([string]$gate.accountKey -cmatch '^[A-Za-z0-9._-]{1,80}$') { $script:NativePtGuard.accountKey = [string]$gate.accountKey }
    if (-not $gate.allow) { return $gate.decision }
    return $null
}

function Test-NativeUnverifiedTextAllowsForm($Snapshot) {
    # Generic success words can belong to instructions or a historical table.
    # Only a current bound unsigned proof may keep the reviewed form runnable;
    # authoritative completion is checked before this branch by both readers.
    $state=$script:NativePtGuard
    if (-not $state -or -not $state.managed -or $state.readOnly -or
        $state.origin -cnotin @('https://ourbits.club','https://audiences.me') -or
        -not $Snapshot.sameOrigin -or -not $Snapshot.pageContentAvailable -or -not $Snapshot.siteBodyLoaded -or
        $Snapshot.waf -or $Snapshot.securityVerification -or $Snapshot.loginRoute -or $Snapshot.signedControlCount -gt 0) { return $false }
    $at=[datetimeoffset]::MinValue
    if (-not [datetimeoffset]::TryParse([string]$state.unsignedConfirmedAt,[ref]$at)) { return $false }
    $age=([datetimeoffset]::UtcNow-$at).TotalSeconds
    if ($age -lt 0 -or $age -gt 300) { return $false }
    try {
        $url=[uri][string]$Snapshot.currentUrl
        return $url.Scheme -ceq 'https' -and -not $url.UserInfo -and -not $url.Query -and -not $url.Fragment -and
            $url.GetLeftPart([System.UriPartial]::Authority) -ceq $state.origin -and $url.AbsolutePath -ceq '/attendance.php'
    } catch { return $false }
}

function Register-NativePtReadback($Result) {
    if (-not $script:NativePtGuard -or -not $script:NativePtGuard.managed) { throw 'Native PT readback guard is not initialized' }
    $source = if ($null -ne $Result.readbackReceipt) { $Result.readbackReceipt } else { $Result }
    $snapshot = $source.inspection
    $audiences = [bool]$snapshot.audiencesDailyHeaderVerified
    if ($snapshot.bodyText -and (Get-Command Test-NativeAudiencesDailyHeader -ErrorAction SilentlyContinue)) {
        $audiences = Test-NativeAudiencesDailyHeader $snapshot $script:NativePtGuard.origin
    }
    # Project the child's verified identity and the reviewed daily control.
    # Body text, account text and arbitrary snapshot fields never leave here.
    $receipt = [pscustomobject]@{
        origin = [string]$source.origin
        url = [string]$source.url
        accountKey = [string]$source.accountKey
        profileBinding = [string]$source.profileBinding
        status = [string]$source.status
        observedAt = if ($source.observedAt) { Convert-NativeReceiptTimestamp $source.observedAt } else { Convert-NativeReceiptTimestamp $source.evidence.confirmedAt }
        businessDate = if ($source.businessDate) { [string]$source.businessDate } else { [string]$source.evidence.businessDate }
        submissionAttempted = $source.submissionAttempted
        clicked = $source.clicked
        checkinClicked = $source.checkinClicked
        checkinClickAttempted = $source.checkinClickAttempted
        operationMode = [string]$source.operationMode
        readSafety = [string]$source.readSafety
        evidence = [pscustomobject]@{
            source = [string]$source.evidence.source
            authoritative = $source.evidence.authoritative
            confirmedAt = Convert-NativeReceiptTimestamp $source.evidence.confirmedAt
            businessDate = [string]$source.evidence.businessDate
            pagePath = [string]$source.evidence.pagePath
            statusSignal = [string]$source.evidence.statusSignal
            evidenceScope = [string]$source.evidence.evidenceScope
        }
        inspection = [pscustomobject]@{
            currentUrl = [string]$snapshot.currentUrl
            sameOrigin = $snapshot.sameOrigin
            pageContentAvailable = $snapshot.pageContentAvailable
            siteBodyLoaded = $snapshot.siteBodyLoaded
            authenticated = $snapshot.authenticated
            waf = $snapshot.waf
            securityVerification = $snapshot.securityVerification
            loginRoute = $snapshot.loginRoute
            signedControlCount = $snapshot.signedControlCount
            unsignedControlCount = $snapshot.unsignedControlCount
            successControl = [string]$snapshot.successControl
            unsignedControl = [string]$snapshot.unsignedControl
            success = $snapshot.success
            successText = [bool]$snapshot.successText
            audiencesDailyHeaderVerified = [bool]$audiences
        }
    }
    if ($script:NativePtGuard.origin -ceq 'https://ourbits.club') {
        foreach ($name in @('ourbitsDailyHeaderVerified', 'ourbitsHeaderLogoutCount', 'ourbitsHeaderStatsCount',
                'ourbitsHeaderRewardCount', 'ourbitsHeaderUnsignedControlCount', 'ourbitsHeaderContextClear')) {
            # Preserve the child's types. Strings must not become boolean or
            # numeric attestations merely because they crossed PowerShell.
            $receipt.inspection | Add-Member -NotePropertyName $name -NotePropertyValue $snapshot.$name
        }
    }
    return (Invoke-NativePtGate 'readback' '' $receipt)
}

function Convert-NativeReceiptTimestamp($Value) {
    # ConvertFrom-Json in PowerShell 7 decodes ISO dates to DateTime. A plain
    # string cast loses its timezone at the Node boundary and rejects a fresh
    # proof as stale. Preserve the original instant in both supported shells.
    if ($Value -is [datetimeoffset]) { return $Value.ToUniversalTime().ToString('o') }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime().ToString('o') }
    return [string]$Value
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
        $bindingConflict = $state.managed -and (
            ($Result.profileBinding -and $state.profileBinding -and [string]$Result.profileBinding -cne [string]$state.profileBinding) -or
            ($Result.accountKey -and $state.accountKey -and [string]$Result.accountKey -cne [string]$state.accountKey)
        )
        if ($bindingConflict) {
            $Result | Add-Member -NotePropertyName status -NotePropertyValue $(if ($attempted) { 'needs_attention' } else { 'unconfirmed' }) -Force
            $Result | Add-Member -NotePropertyName failureCode -NotePropertyValue $(if ($attempted) { 'submission_outcome_unknown' } else { 'native_readback_unavailable' }) -Force
            $Result | Add-Member -NotePropertyName evidence -NotePropertyValue $null -Force
        }
        if ($state.profileBinding) { $Result | Add-Member -NotePropertyName profileBinding -NotePropertyValue $state.profileBinding -Force }
        if ($state.accountKey) { $Result | Add-Member -NotePropertyName accountKey -NotePropertyValue $state.accountKey -Force }
        if ($state.managed -and $state.readOnly -and $state.url -ceq ($state.origin + '/index.php')) {
            $Result | Add-Member -NotePropertyName operationMode -NotePropertyValue 'safe_history_page' -Force
            $Result | Add-Member -NotePropertyName readSafety -NotePropertyValue 'reviewed_passive' -Force
            if ($Result.evidence) { $Result.evidence | Add-Member -NotePropertyName evidenceScope -NotePropertyValue 'site_account_day' -Force }
        }
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
                if ([string]$Result.failureCode -ceq 'two_factor_required') {
                    $Result | Add-Member -NotePropertyName underlyingFailureCode -NotePropertyValue 'two_factor_required' -Force
                }
                $Result | Add-Member -NotePropertyName status -NotePropertyValue 'needs_attention' -Force
                $Result | Add-Member -NotePropertyName failureCode -NotePropertyValue 'submission_outcome_unknown' -Force
                $Result | Add-Member -NotePropertyName retryable -NotePropertyValue $false -Force
                $Result | Add-Member -NotePropertyName reason -NotePropertyValue '原生签到可能已提交，先只读核验，禁止自动重放' -Force
            }
            if ($state.managed -and $state.attempted) {
                try { $saved = Invoke-NativePtGate 'finish' '' $Result } catch { $saved = $null }
                # A failed save leaves the durable pre-action intent pending.
                if ($confirmed -and ($null -eq $saved -or $saved.confirmed -ne $true -or $saved.allow -ne $true -or
                    [string]$saved.confirmationState -cne 'confirmed')) {
                    $Result | Add-Member -NotePropertyName status -NotePropertyValue 'needs_attention' -Force
                    $Result | Add-Member -NotePropertyName failureCode -NotePropertyValue 'submission_outcome_unknown' -Force
                    $Result | Add-Member -NotePropertyName retryable -NotePropertyValue $false -Force
                    $Result | Add-Member -NotePropertyName confirmationState -NotePropertyValue 'not_persisted' -Force
                    $Result | Add-Member -NotePropertyName reason -NotePropertyValue '签到动作可能已提交，但当日确认未持久化；保留原意图，先只读核验' -Force
                    $Result | Add-Member -NotePropertyName evidence -NotePropertyValue $null -Force
                }
            }
        } else { $Result | Add-Member -NotePropertyName submissionAttempted -NotePropertyValue $false -Force }
        return $Result
    }
}
