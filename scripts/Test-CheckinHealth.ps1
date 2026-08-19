[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
trap {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'health_check_error'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('healthCheckExecution')
        error = $_.Exception.Message
        checks = [ordered]@{ healthCheckExecution = $false }
    } | ConvertTo-Json -Depth 5
    exit 3
}

$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'ResultIdentity.ps1')
. (Join-Path $PSScriptRoot 'HealthReportClassification.ps1')
$configPath = Join-Path $root 'config\config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    [ordered]@{
        schemaVersion = 1
        healthy = $false
        reason = 'not_initialized'
        checkedAt = (Get-Date).ToString('o')
        failedChecks = @('configPresent')
        checks = [ordered]@{ configPresent = $false }
    } | ConvertTo-Json -Depth 5
    exit 2
}
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$latestPath = Join-Path $root 'logs\latest.json'
$statePath = Join-Path $root 'data\site-state.json'
$currentPlanPath = Join-Path $root 'data\last-valid-bookmark-plan.json'
$notificationQuarantinePath = Join-Path $root 'data\notification-outbox\quarantine'
$notificationQuarantinedCount = @(Get-ChildItem -LiteralPath $notificationQuarantinePath -Filter '*.invalid.json' -File -ErrorAction SilentlyContinue).Count
$notificationOutboxPath = Join-Path $root 'data\notification-outbox'
$notificationPendingItems = @(Get-ChildItem -LiteralPath $notificationOutboxPath -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
    try { Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName | ConvertFrom-Json } catch { [pscustomobject]@{ delivered = $false } }
} | Where-Object { $_.delivered -ne $true })
$notificationPendingCount = $notificationPendingItems.Count
$taskName = if ($config.schedulerTaskName) { [string]$config.schedulerTaskName } else { 'CodexBookmarkDailyCheckin' }
$runKeyName = if ($config.schedulerRunKeyName) { [string]$config.schedulerRunKeyName } else { 'CodexBookmarkDailyCheckin' }
$scheduledTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$runValue = try {
    $runProperties = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction Stop
    [string]$runProperties.$runKeyName
} catch { $null }
$startupShortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) "$runKeyName.lnk"
$startupEntryPresent = [bool]$runValue -or (Test-Path -LiteralPath $startupShortcutPath -PathType Leaf)
$schedulerScript = Join-Path $PSScriptRoot 'Start-UserScheduler.ps1'
$watchdogScript = Join-Path $PSScriptRoot 'Ensure-UserScheduler.ps1'
$supervisorScript = Join-Path $PSScriptRoot 'UserSchedulerSupervisor.vbs'
$schedulerCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$schedulerScript*"
}).Count
$watchdogCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('pwsh.exe', 'powershell.exe') -and $_.CommandLine -like "*-File*$watchdogScript*"
}).Count
$supervisorCount = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'wscript.exe' -and $_.CommandLine -like "*$supervisorScript*"
}).Count
$latest = if (Test-Path -LiteralPath $latestPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $latestPath | ConvertFrom-Json } else { $null }
$schedulerStatePath = Join-Path $root 'data\scheduler-state.json'
$schedulerState = if (Test-Path -LiteralPath $schedulerStatePath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $schedulerStatePath | ConvertFrom-Json } catch { $null } } else { $null }
$heartbeatPath = Join-Path $root 'data\scheduler-heartbeat.json'
$heartbeat = if (Test-Path -LiteralPath $heartbeatPath) { Get-Content -Raw -Encoding UTF8 -LiteralPath $heartbeatPath | ConvertFrom-Json } else { $null }
$heartbeatMaxAgeMinutes = if ($heartbeat -and [string]$heartbeat.phase -eq 'running_checkin') { ([int]$config.taskTimeoutMinutes) + 10 } else { 5 }
$heartbeatFresh = $heartbeat -and ((Get-Date) - [datetime]$heartbeat.updatedAt) -lt [timespan]::FromMinutes($heartbeatMaxAgeMinutes)
$watchdogHeartbeatPath = Join-Path $root 'data\scheduler-watchdog-heartbeat.json'
$supervisorHeartbeatPath = Join-Path $root 'data\scheduler-supervisor-heartbeat.json'
$watchdogHeartbeat = if (Test-Path -LiteralPath $watchdogHeartbeatPath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $watchdogHeartbeatPath | ConvertFrom-Json } catch { $null } } else { $null }
$supervisorHeartbeat = if (Test-Path -LiteralPath $supervisorHeartbeatPath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $supervisorHeartbeatPath | ConvertFrom-Json } catch { $null } } else { $null }
$watchdogHeartbeatFresh = $watchdogHeartbeat -and ((Get-Date) - [datetime]$watchdogHeartbeat.updatedAt) -lt [timespan]::FromMinutes(5)
$supervisorHeartbeatFresh = $supervisorHeartbeat -and ((Get-Date) - [datetime]$supervisorHeartbeat.updatedAt) -lt [timespan]::FromMinutes(5)
$siteState = if (Test-Path -LiteralPath $statePath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json } catch { $null } } else { $null }
$currentPlan = if (Test-Path -LiteralPath $currentPlanPath) { try { Get-Content -Raw -Encoding UTF8 -LiteralPath $currentPlanPath | ConvertFrom-Json } catch { $null } } else { $null }
$problemCount = if ($latest) { @($latest.results | Where-Object { $_.status -notin @('signed', 'already_signed', 'not_available') }).Count } else { $null }
$minimumTargets = [Math]::Max(1, [int]$config.minimumBookmarkTargetCount)
$latestRunToday = $latest -and [string]$latest.runId -like "$(Get-Date -Format 'yyyyMMdd')-*"
$plannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { 0 }
$processedTotal = if ($latest -and $null -ne $latest.processedTotal) { [int]$latest.processedTotal } else { 0 }
$supplementalAccounts = @(@($config.supplementalOAuthAccounts) | Where-Object { $null -ne $_ })
$currentBookmarkPlannedTotal = if ($currentPlan -and $null -ne $currentPlan.targetCount) { [int]$currentPlan.targetCount } elseif ($currentPlan) { @($currentPlan.targets).Count } else { $null }
$currentPlannedTotal = if ($null -ne $currentBookmarkPlannedTotal) { $currentBookmarkPlannedTotal + $supplementalAccounts.Count } else { $null }

function Get-PlanTargetIdentity([object]$Target, [bool]$ApplyConfiguredAccountIdentity) {
    $origin = try { ([uri][string]$Target.origin).GetLeftPart([System.UriPartial]::Authority).TrimEnd('/') } catch { $null }
    if (-not $origin) { return $null }
    $accountKey = [string]$Target.accountKey
    if (-not $accountKey -and $ApplyConfiguredAccountIdentity -and $null -ne $config.oauthAccountIdentities) {
        $identityProperty = $config.oauthAccountIdentities.PSObject.Properties[$origin]
        if ($null -ne $identityProperty) { $accountKey = [string]$identityProperty.Value.accountKey }
    }
    return Get-CanonicalResultIdentity ([pscustomobject]@{ origin = $origin; accountKey = $accountKey })
}

$currentPlanIdentities = if ($currentPlan) { @(
    @($currentPlan.targets) | ForEach-Object { Get-PlanTargetIdentity $_ $true }
    $supplementalAccounts | ForEach-Object { Get-PlanTargetIdentity $_ $false }
) | Where-Object { $_ } | Sort-Object -Unique } else { @() }
$latestPlanTargets = if ($latest -and $latest.bookmarkSummary) { @($latest.bookmarkSummary.targets) } else { @() }
$latestPlanIdentities = @($latestPlanTargets | ForEach-Object { Get-PlanTargetIdentity $_ $false } | Where-Object { $_ } | Sort-Object -Unique)
$latestResultIdentityValues = if ($latest) { @($latest.results | ForEach-Object { Get-CanonicalResultIdentity $_ }) } else { @() }
$latestResultIdentities = @($latestResultIdentityValues | Sort-Object -Unique)
$currentPlanIdentityReady = $null -ne $currentPlannedTotal -and $currentPlanIdentities.Count -eq $currentPlannedTotal
$latestPlanIdentityReady = $latest -and $latestPlanIdentities.Count -eq $plannedTotal
$latestResultIdentityReady = $latest `
    -and $latestResultIdentityValues.Count -eq $plannedTotal `
    -and $latestResultIdentities.Count -eq $latestResultIdentityValues.Count
$latestMatchesCurrentPlan = $currentPlanIdentityReady `
    -and $latestPlanIdentityReady `
    -and $latestResultIdentityReady `
    -and $currentPlannedTotal -eq $plannedTotal `
    -and @(Compare-Object -ReferenceObject $currentPlanIdentities -DifferenceObject $latestPlanIdentities).Count -eq 0 `
    -and @(Compare-Object -ReferenceObject $currentPlanIdentities -DifferenceObject $latestResultIdentities).Count -eq 0
$latestResultValid = $latestRunToday `
    -and [string]$latest.runState -eq 'final' `
    -and $latest.isComplete -eq $true `
    -and $plannedTotal -ge $minimumTargets `
    -and $processedTotal -ge $plannedTotal `
    -and @($latest.results).Count -ge $plannedTotal
$reportStatus = Get-CheckinReportStatus -LatestResultValid $latestResultValid -ProblemCount ([int]$problemCount)
$notificationReady = $config.notification.mode -in @($null, '', 'none') -or (
    $config.notification.mode -eq 'command' -and
    ((Test-Path -LiteralPath ([string]$config.notification.executable)) -or (Get-Command ([string]$config.notification.executable) -ErrorAction SilentlyContinue))
)
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$dataPrefix = $dataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
function Get-OAuthProfileHealth([string]$RawPath, [string]$AccountKey, [string]$Kind) {
    $raw = [string]$RawPath
    $resolved = if ($raw) {
        if ([System.IO.Path]::IsPathRooted($raw)) { [System.IO.Path]::GetFullPath($raw) }
        else { [System.IO.Path]::GetFullPath((Join-Path $root $raw)) }
    } else { $null }
    $valid = $resolved -and $resolved.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    return [pscustomobject]@{
        accountKey = $AccountKey
        kind = $Kind
        path = $resolved
        valid = [bool]$valid
        present = $valid -and (Test-Path -LiteralPath (Join-Path $resolved 'Local State'))
    }
}
$globalProfile = Get-OAuthProfileHealth ([string]$config.automationUserDataDir) 'automationUserDataDir' 'global'
$primaryIdentityProfiles = @($config.oauthAccountIdentities.PSObject.Properties | ForEach-Object {
    $identity = $_.Value
    if (-not [string]::IsNullOrWhiteSpace([string]$identity.automationUserDataDir)) {
        Get-OAuthProfileHealth ([string]$identity.automationUserDataDir) ([string]$identity.accountKey) 'primary'
    }
})
$supplementalProfiles = @($supplementalAccounts | ForEach-Object {
    Get-OAuthProfileHealth ([string]$_.automationUserDataDir) ([string]$_.accountKey) 'supplemental'
})
$isolatedOAuthSiteProfiles = @($config.isolatedOAuthSiteProfiles.PSObject.Properties | ForEach-Object {
    $profile = Get-OAuthProfileHealth ([string]$_.Value) ([string]$_.Name) 'isolated_site'
    $profile | Add-Member -NotePropertyName origin -NotePropertyValue ([string]$_.Name) -PassThru
})
$oauthSessionProfiles = @(if ($null -ne $config.oauthSessionProfiles) {
    $config.oauthSessionProfiles.PSObject.Properties | ForEach-Object {
        Get-OAuthProfileHealth ([string]$_.Value) ([string]$_.Name) 'oauth_session'
    }
})
$oauthSessionBindings = @(if ($null -ne $config.oauthSiteSessionBindings) {
    $config.oauthSiteSessionBindings.PSObject.Properties | ForEach-Object {
        $origin = try { ([uri][string]$_.Name).GetLeftPart([System.UriPartial]::Authority) } catch { $null }
        $sessionKey = [string]$_.Value
        [pscustomobject]@{
            origin = $origin
            sessionKey = $sessionKey
            validOrigin = [bool]($origin -and ([string]$_.Name).TrimEnd('/') -eq $origin)
            configured = @($oauthSessionProfiles | Where-Object { $_.accountKey -eq $sessionKey }).Count -eq 1
        }
    }
})
$oauthSessionProfilesReady = @($oauthSessionProfiles | Where-Object { -not $_.valid -or -not $_.present }).Count -eq 0
$oauthSessionBindingsReady = @($oauthSessionBindings | Where-Object { -not $_.validOrigin -or -not $_.configured }).Count -eq 0
$rawAllowedOAuthProviders = if (@($config.oauthAllowedProviders).Count -gt 0) { @($config.oauthAllowedProviders) }
else { @('LinuxDO', 'GitHub', 'Google') }
$allowedOAuthProviders = @(
    $rawAllowedOAuthProviders | ForEach-Object { ([string]$_).Trim() }
    | Where-Object { $_ }
    | Sort-Object -Unique
)
function Get-OAuthHealthMapValue([object]$Map, [string]$Key) {
    if ($null -eq $Map) { return $null }
    $property = $Map.PSObject.Properties[$Key]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function New-OAuthBindingHealth([string]$Origin, [object]$Account, [string]$Kind) {
    $originValue = try { ([uri]$Origin).GetLeftPart([System.UriPartial]::Authority) } catch { $null }
    $provider = if ($Kind -eq 'primary' -and $Account.provider) { [string]$Account.provider } elseif ($Kind -eq 'primary') { [string](Get-OAuthHealthMapValue $config.automaticOAuthProviders $originValue) } else { [string]$Account.provider }
    $upstreamProvider = if ($Kind -eq 'primary' -and $Account.upstreamProvider) { [string]$Account.upstreamProvider } elseif ($Kind -eq 'primary') { [string](Get-OAuthHealthMapValue $config.oauthUpstreamProviders $originValue) } else { [string]$Account.upstreamProvider }
    $loginUrl = if ($Kind -eq 'primary' -and $Account.loginUrl) { [string]$Account.loginUrl } elseif ($Kind -eq 'primary' -and (Get-OAuthHealthMapValue $config.oauthLoginUrls $originValue)) { [string](Get-OAuthHealthMapValue $config.oauthLoginUrls $originValue) } elseif ($Kind -eq 'primary') { "$originValue/login" } else { [string]$Account.loginUrl }
    $loginValid = $false
    try {
        $loginUri = [uri]$loginUrl
        $loginValid = $originValue -and $loginUri.Scheme -eq 'https' -and -not $loginUri.UserInfo `
            -and $loginUri.GetLeftPart([System.UriPartial]::Authority) -eq $originValue
    } catch { $loginValid = $false }
    $consistent = $true
    if ($Kind -eq 'primary') {
        $mappedProvider = [string](Get-OAuthHealthMapValue $config.automaticOAuthProviders $originValue)
        $mappedUpstream = [string](Get-OAuthHealthMapValue $config.oauthUpstreamProviders $originValue)
        $mappedLogin = [string](Get-OAuthHealthMapValue $config.oauthLoginUrls $originValue)
        $mappedAccountId = [string](Get-OAuthHealthMapValue $config.oauthExpectedAccountIds $originValue)
        if ($Account.provider -and $mappedProvider -and [string]$Account.provider -ne $mappedProvider) { $consistent = $false }
        if ($Account.upstreamProvider -and $mappedUpstream -and [string]$Account.upstreamProvider -ne $mappedUpstream) { $consistent = $false }
        if ($Account.loginUrl -and $mappedLogin -and ([uri][string]$Account.loginUrl).AbsoluteUri -ne ([uri]$mappedLogin).AbsoluteUri) { $consistent = $false }
        if ($Account.accountId -and $mappedAccountId -and [string]$Account.accountId -ne $mappedAccountId) { $consistent = $false }
    }
    $selfContained = $Kind -ne 'primary' -or (
        -not [string]::IsNullOrWhiteSpace([string]$Account.provider) -and
        -not [string]::IsNullOrWhiteSpace([string]$Account.upstreamProvider) -and
        -not [string]::IsNullOrWhiteSpace([string]$Account.loginUrl)
    )
    $providerAllowed = $allowedOAuthProviders -contains $provider
    $upstreamAllowed = $allowedOAuthProviders -contains $upstreamProvider
    $ready = $originValue -and $loginValid -and $providerAllowed -and $upstreamAllowed `
        -and -not [string]::IsNullOrWhiteSpace([string]$Account.accountKey) `
        -and -not [string]::IsNullOrWhiteSpace([string]$Account.accountId) `
        -and $consistent
    return [pscustomobject]@{
        origin = $originValue
        accountKey = [string]$Account.accountKey
        accountId = [string]$Account.accountId
        kind = $Kind
        provider = $provider
        upstreamProvider = $upstreamProvider
        loginUrl = $loginUrl
        providerAllowed = [bool]$providerAllowed
        upstreamProviderAllowed = [bool]$upstreamAllowed
        loginUrlValid = [bool]$loginValid
        consistent = [bool]$consistent
        selfContained = [bool]$selfContained
        ready = [bool]$ready
    }
}
$primaryOAuthBindings = @($config.oauthAccountIdentities.PSObject.Properties | ForEach-Object {
    New-OAuthBindingHealth ([string]$_.Name) $_.Value 'primary'
})
$supplementalOAuthBindings = @($supplementalAccounts | ForEach-Object {
    New-OAuthBindingHealth ([string]$_.origin) $_ 'supplemental'
})
$oauthAccountBindings = @($primaryOAuthBindings) + @($supplementalOAuthBindings)
$oauthAccountBindingKeysUnique = @($oauthAccountBindings | Group-Object accountKey | Where-Object { -not $_.Name -or $_.Count -gt 1 }).Count -eq 0
$oauthAccountIdTuplesUnique = @($oauthAccountBindings | Group-Object { "$($_.origin)#id=$($_.accountId)" } | Where-Object { $_.Count -gt 1 }).Count -eq 0
$oauthBindingReady = @($oauthAccountBindings | Where-Object { -not $_.ready }).Count -eq 0
$oauthBindingConsistent = @($oauthAccountBindings | Where-Object { -not $_.consistent }).Count -eq 0
$oauthBindingSelfContained = $config.requireInlineOAuthIdentityTuple -ne $true -or @($primaryOAuthBindings | Where-Object { -not $_.selfContained }).Count -eq 0
function ConvertTo-OAuthProviderHealthKey([string]$Value) {
    return ([string]$Value).Trim().ToLowerInvariant() -replace '[^a-z0-9]', ''
}
$oauthRecoveryAccountBindings = @(if ($null -ne $config.oauthRecoveryAccountBindings) {
    $config.oauthRecoveryAccountBindings.PSObject.Properties | ForEach-Object {
        $rawOrigin = ([string]$_.Name).Trim()
        $originUri = $null
        $origin = try {
            $originUri = [uri]$rawOrigin
            $originUri.GetLeftPart([System.UriPartial]::Authority)
        } catch { $null }
        $validOrigin = [bool](
            $origin -and
            $originUri.IsAbsoluteUri -and
            $originUri.Scheme -eq 'https' -and
            -not $originUri.UserInfo -and
            $rawOrigin -eq $origin
        )
        $accountKey = ([string]$_.Value).Trim()
        $accountKeyValid = -not [string]::IsNullOrWhiteSpace($accountKey) `
            -and $accountKey.Length -le 80 `
            -and $accountKey -notmatch '[\r\n]'
        $accountMatches = @($oauthAccountBindings | Where-Object { $_.accountKey -eq $accountKey })
        $targetProvider = if ($origin) { [string](Get-OAuthHealthMapValue $config.automaticOAuthProviders $origin) } else { '' }
        $accountProvider = if ($accountMatches.Count -eq 1) { [string]$accountMatches[0].provider } else { '' }
        $providerMatches = -not [string]::IsNullOrWhiteSpace($targetProvider) `
            -and -not [string]::IsNullOrWhiteSpace($accountProvider) `
            -and (ConvertTo-OAuthProviderHealthKey $targetProvider) -eq (ConvertTo-OAuthProviderHealthKey $accountProvider)
        [pscustomobject]@{
            origin = $origin
            configuredOrigin = $rawOrigin
            accountKey = $accountKey
            targetProvider = $targetProvider
            accountProvider = $accountProvider
            validOrigin = [bool]$validOrigin
            accountKeyValid = [bool]$accountKeyValid
            accountMatchCount = $accountMatches.Count
            accountConfiguredUniquely = [bool]($accountKeyValid -and $accountMatches.Count -eq 1)
            providerMatches = [bool]$providerMatches
            ready = [bool]($validOrigin -and $accountKeyValid -and $accountMatches.Count -eq 1 -and $providerMatches)
        }
    }
})
$oauthRecoveryOriginsValid = @($oauthRecoveryAccountBindings | Where-Object { -not $_.validOrigin }).Count -eq 0
$oauthRecoveryAccountsResolvable = @($oauthRecoveryAccountBindings | Where-Object { -not $_.accountConfiguredUniquely }).Count -eq 0
$oauthRecoveryProvidersConsistent = @($oauthRecoveryAccountBindings | Where-Object { -not $_.providerMatches }).Count -eq 0
$oauthRecoveryBindingsReady = @($oauthRecoveryAccountBindings | Where-Object { -not $_.ready }).Count -eq 0
$oauthAccountProfiles = @($primaryIdentityProfiles) + @($supplementalProfiles)
$reservedOAuthProfiles = @($globalProfile) + @($oauthAccountProfiles) + @($isolatedOAuthSiteProfiles) + @($oauthSessionProfiles)
$duplicateOAuthProfileGroups = @($reservedOAuthProfiles | Where-Object { $_.valid } | Group-Object { $_.path.ToLowerInvariant() } | Where-Object { $_.Count -gt 1 })
$configuredOAuthProfilePathKeys = @($reservedOAuthProfiles | Where-Object { $_.valid } | ForEach-Object { $_.path.ToLowerInvariant() } | Sort-Object -Unique)
$accountsRoot = Join-Path $root 'data\accounts'
$orphanOAuthProfiles = @(Get-ChildItem -LiteralPath $accountsRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $_.FullName 'chrome-user-data'))
    (Test-Path -LiteralPath (Join-Path $candidate 'Local State')) -and $configuredOAuthProfilePathKeys -notcontains $candidate.ToLowerInvariant()
} | ForEach-Object { $_.Name })
$sitesRoot = Join-Path $root 'data\sites'
$orphanIsolatedOAuthSiteProfiles = @(Get-ChildItem -LiteralPath $sitesRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $_.FullName 'chrome-user-data'))
    (Test-Path -LiteralPath (Join-Path $candidate 'Local State')) -and $configuredOAuthProfilePathKeys -notcontains $candidate.ToLowerInvariant()
} | ForEach-Object { $_.Name })
$scheduleValid = [string]$config.schedule -match '^([01]\d|2[0-3]):[0-5]\d$'
$claimFresh = $true
if ($schedulerState -and [string]$schedulerState.phase -eq 'running') {
    $claimFresh = $false
    try {
        $claimMaxAge = ([int]$config.taskTimeoutMinutes) + 15
        $claimFresh = (Get-Date) - [datetime]$schedulerState.lastAttemptStartedAt -lt [timespan]::FromMinutes($claimMaxAge)
    } catch { $claimFresh = $false }
}
$rootAcl = Get-Acl -LiteralPath $root
$allowedSids = @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
$wideWriteRules = @($rootAcl.Access | Where-Object {
    if ($_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
    $sid = try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
    $writeMask = [System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Modify -bor [System.Security.AccessControl.FileSystemRights]::FullControl
    return $sid -notin $allowedSids -and (($_.FileSystemRights -band $writeMask) -ne 0)
})
$runtimeAclPrivate = $rootAcl.AreAccessRulesProtected -and $wideWriteRules.Count -eq 0
$staleTempCount = @(Get-ChildItem -LiteralPath (Join-Path $root 'tmp') -Force -ErrorAction SilentlyContinue | Where-Object {
    $_.Name -ne '.gitkeep' -and $_.LastWriteTimeUtc -lt (Get-Date).ToUniversalTime().AddHours(-48)
}).Count
$scheduledTaskActionValid = if ($scheduledTask) {
    @($scheduledTask.Actions | Where-Object {
        [string]$_.Execute -match '(?i)(?:pwsh|powershell)(?:\.exe)?$' -and [string]$_.Arguments -like "*$schedulerScript*"
    }).Count -eq 1
} else { $false }
$scheduledTaskReady = $scheduledTask -and [string]$scheduledTask.State -ne 'Disabled' -and $scheduledTaskActionValid
$checks = [ordered]@{
    configPresent = $true
    bookmarksReadable = Test-Path -LiteralPath ([string]$config.bookmarksPath)
    chromeExecutablePresent = Test-Path -LiteralPath ([string]$config.chromeExecutable)
    automationProfilePresent = [bool]$globalProfile.present
    oauthIdentityProfilesPresent = @($primaryIdentityProfiles | Where-Object { -not $_.present }).Count -eq 0
    supplementalProfilesPresent = @($supplementalProfiles | Where-Object { -not $_.present }).Count -eq 0
    isolatedOAuthSiteProfilesPresent = @($isolatedOAuthSiteProfiles | Where-Object { -not $_.present }).Count -eq 0
    oauthSessionProfilesPresent = [bool]$oauthSessionProfilesReady
    oauthSessionBindingsReady = [bool]$oauthSessionBindingsReady
    oauthAccountProfilesUnique = $duplicateOAuthProfileGroups.Count -eq 0
    oauthAccountBindingsReady = [bool]$oauthBindingReady
    oauthAccountBindingsConsistent = [bool]$oauthBindingConsistent
    oauthIdentityTuplesUnique = [bool]($oauthAccountBindingKeysUnique -and $oauthAccountIdTuplesUnique)
    oauthIdentityTuplesSelfContained = [bool]$oauthBindingSelfContained
    oauthRecoveryOriginsValid = [bool]$oauthRecoveryOriginsValid
    oauthRecoveryAccountsResolvable = [bool]$oauthRecoveryAccountsResolvable
    oauthRecoveryProvidersConsistent = [bool]$oauthRecoveryProvidersConsistent
    oauthRecoveryBindingsReady = [bool]$oauthRecoveryBindingsReady
    notificationReady = [bool]$notificationReady
    notificationOutboxClean = $notificationQuarantinedCount -eq 0 -and $notificationPendingCount -eq 0
    scheduleValid = [bool]$scheduleValid
    schedulerReady = if ($scheduledTask) { [bool]$scheduledTaskReady } else { $startupEntryPresent }
    schedulerUnique = if ($scheduledTask) { $true } else { $schedulerCount -eq 1 -and $watchdogCount -eq 1 -and $supervisorCount -eq 1 }
    schedulerHeartbeatFresh = [bool]$heartbeatFresh
    watchdogHeartbeatFresh = if ($scheduledTask) { $true } else { [bool]$watchdogHeartbeatFresh }
    supervisorHeartbeatFresh = if ($scheduledTask) { $true } else { [bool]$supervisorHeartbeatFresh }
    schedulerClaimFresh = [bool]$claimFresh
    runtimeAclPrivate = [bool]$runtimeAclPrivate
    noOrphanOAuthProfiles = $orphanOAuthProfiles.Count -eq 0
    noOrphanSupplementalProfiles = $orphanOAuthProfiles.Count -eq 0
    noOrphanIsolatedOAuthSiteProfiles = $orphanIsolatedOAuthSiteProfiles.Count -eq 0
    stalePrivateTempClean = $staleTempCount -eq 0
    latestResultPresent = [bool]$latest
    latestResultValid = [bool]$latestResultValid
    latestMatchesCurrentPlan = [bool]$latestMatchesCurrentPlan
    latestResultConfirmed = [bool]$latestResultValid
    latestResultComplete = [bool]$latestResultValid
    siteStatePresent = $null -ne $siteState
}
$failedChecks = @($checks.GetEnumerator() | Where-Object { -not [bool]$_.Value } | ForEach-Object { [string]$_.Key })
$healthy = $failedChecks.Count -eq 0
$result = [ordered]@{
    schemaVersion = 1
    healthy = $healthy
    reason = if (-not $healthy) { 'checks_failed' } elseif ($reportStatus -eq 'complete_with_attention') { 'ok_with_attention' } else { 'ok' }
    checkedAt = (Get-Date).ToString('o')
    failedChecks = $failedChecks
    schedule = [string]$config.schedule
    schedulerMode = if ($scheduledTask) { 'windows_task' } elseif ($startupEntryPresent) { 'user_scheduler' } else { 'none' }
    schedulerRunKeyPresent = [bool]$runValue
    schedulerStartupShortcutPresent = Test-Path -LiteralPath $startupShortcutPath -PathType Leaf
    schedulerProcessCount = $schedulerCount
    watchdogProcessCount = $watchdogCount
    supervisorProcessCount = $supervisorCount
    schedulerHeartbeat = $heartbeat
    latestRunId = if ($latest) { [string]$latest.runId } else { $null }
    reportStatus = $reportStatus
    latestSiteCount = if ($latest) { @($latest.results).Count } else { $null }
    currentPlannedTotal = $currentPlannedTotal
    latestPlannedTotal = if ($latest -and $null -ne $latest.plannedTotal) { [int]$latest.plannedTotal } else { $null }
    currentPlanMatchesLatest = [bool]$latestMatchesCurrentPlan
    currentPlanIdentityCount = $currentPlanIdentities.Count
    latestPlanIdentityCount = $latestPlanIdentities.Count
    latestResultIdentityCount = $latestResultIdentities.Count
    latestProblemCount = $problemCount
    schedulerAttemptsToday = if ($schedulerState) { [int]$schedulerState.attemptsToday } else { 0 }
    schedulerNextEligibleAt = if ($schedulerState -and $schedulerState.nextEligibleAt) { try { ([datetime]$schedulerState.nextEligibleAt).ToString('o') } catch { [string]$schedulerState.nextEligibleAt } } else { $null }
    schedulerReportComplete = if ($schedulerState) { [bool]$schedulerState.reportComplete } else { $false }
    notificationQuarantinedCount = $notificationQuarantinedCount
    notificationPendingCount = $notificationPendingCount
    orphanOAuthProfiles = $orphanOAuthProfiles
    orphanSupplementalProfiles = $orphanOAuthProfiles
    orphanIsolatedOAuthSiteProfiles = $orphanIsolatedOAuthSiteProfiles
    stalePrivateTempCount = $staleTempCount
    trackedSiteCount = if ($siteState -and $siteState.sites) { @($siteState.sites.PSObject.Properties).Count } else { 0 }
    oauthIdentityProfiles = $primaryIdentityProfiles
    supplementalProfiles = $supplementalProfiles
    isolatedOAuthSiteProfiles = $isolatedOAuthSiteProfiles
    oauthSessionProfiles = $oauthSessionProfiles
    oauthSessionBindings = $oauthSessionBindings
    oauthAccountBindings = $oauthAccountBindings
    oauthRecoveryAccountBindings = $oauthRecoveryAccountBindings
    checks = $checks
}
$result | ConvertTo-Json -Depth 6
if (-not $healthy) { exit 2 }
