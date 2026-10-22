[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Root,
    [Parameter(Mandatory=$true)][string]$Origin,
    [Parameter(Mandatory=$true)][string]$ProfileBinding,
    [string]$AccountKey = 'site-default',
    [string]$AdapterId = '',
    [ValidateSet('Prepare','Get')][string]$Mode = 'Get'
)

$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'
$DebugPreference = 'SilentlyContinue'
$script:ProviderReason = 'session_unavailable'
$result = $null
$session = $null
$payload = $null
$payloadText = $null
$protected = $null
$lockHandle = $null

function Stop-Provider([string]$Reason) {
    $script:ProviderReason = $Reason
    throw [InvalidOperationException]::new('Bitwarden provider unavailable')
}

function Get-CanonicalVaultServer([string]$Value) {
    if (-not $Value -or $Value -cne $Value.Trim() -or $Value -match '[?#\\]') { return $null }
    $uri = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or -not $uri.Host -or $uri.UserInfo -or $uri.AbsolutePath -cne '/') { return $null }
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Get-ProviderSiteContract([string]$SiteOrigin) {
    switch -CaseSensitive ($SiteOrigin) {
        'https://piggo.me' { return @{itemName='piggo.me';adapterId='piggo-nexus-stepup-v1'} }
        'https://www.hddolby.com' { return @{itemName='www.hddolby.com';adapterId='hddolby-nexus-stepup-v1'} }
        'https://hhanclub.net' { return @{itemName='hhanclub.net';adapterId='hhclub-nexus-login-v1'} }
    }
    return $null
}

function Test-ProviderAuthorization($Payload, $Expected) {
    if ($Payload.schemaVersion -eq 1) {
        return $Expected.origin -ceq 'https://piggo.me' -and [string]$Payload.origin -ceq $Expected.origin -and
            [string]$Payload.itemName -ceq $Expected.itemName -and [string]$Payload.itemId -ceq $Expected.itemId -and
            [string]$Payload.profileBinding -ceq $Expected.profileBinding -and $Expected.accountKey -ceq 'site-default' -and
            $Expected.adapterId -ceq 'piggo-nexus-stepup-v1'
    }
    if ($Payload.schemaVersion -ne 2 -or $Payload.authorizations -isnot [array] -or
        $Payload.authorizations.Count -lt 1 -or $Payload.authorizations.Count -gt 3) { return $false }
    $seen = @{}; $authorizationMatchCount = 0
    $names = @('origin','accountKey','profileBinding','itemId','itemName','adapterId')
    foreach ($authorization in $Payload.authorizations) {
        if ($authorization -isnot [pscustomobject] -or @($authorization.PSObject.Properties).Count -ne $names.Count) { return $false }
        foreach ($name in $names) {
            if ($name -cnotin @($authorization.PSObject.Properties.Name) -or $authorization.$name -isnot [string]) { return $false }
        }
        $contract = Get-ProviderSiteContract $authorization.origin
        if ($null -eq $contract -or $authorization.accountKey -cne 'site-default' -or
            $authorization.profileBinding -cnotmatch '\A[a-f0-9]{64}\z' -or
            $authorization.itemId -cnotmatch '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z' -or
            $authorization.itemName -cne $contract.itemName -or $authorization.adapterId -cne $contract.adapterId -or
            $seen.ContainsKey($authorization.origin)) { return $false }
        $seen[$authorization.origin] = $true
        $same = $true
        foreach ($name in $names) { if ($authorization.$name -cne $Expected.$name) { $same = $false } }
        if ($same) { $authorizationMatchCount++ }
    }
    return $authorizationMatchCount -eq 1
}

function Test-ProviderPath([string]$Directory, [string]$Value) {
    if (-not $Value -or $Value -match '[\x00-\x1f]' -or $Value -notmatch '^[A-Za-z]:[\\/]') { return $false }
    $target = [IO.Path]::GetFullPath($Value)
    $base = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    # Reject junctions/symlinks at every existing component, including ancestors.
    $part = $target
    while ($part) {
        if (Test-Path -LiteralPath $part) {
            $attributes = (Get-Item -Force -LiteralPath $part).Attributes
            if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
        }
        $parent = [IO.Path]::GetDirectoryName($part)
        if ($parent -eq $part) { break }
        $part = $parent
    }
    return $true
}

function ConvertTo-ProviderArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
    $builder = [Text.StringBuilder]::new()
    [void]$builder.Append([char]34)
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$builder.Append((('\' * ($slashes * 2 + 1)) -join ''))
            [void]$builder.Append([char]34)
            $slashes = 0
            continue
        }
        if ($slashes -gt 0) { [void]$builder.Append((('\' * $slashes) -join '')) }
        [void]$builder.Append($character)
        $slashes = 0
    }
    if ($slashes -gt 0) { [void]$builder.Append((('\' * ($slashes * 2)) -join '')) }
    [void]$builder.Append([char]34)
    return $builder.ToString()
}

function Invoke-ProviderCli([string[]]$Arguments, [int]$TimeoutSeconds, [string]$FailureReason) {
    $process = $null
    $output = $null
    $errors = $null
    try {
        $start = [Diagnostics.ProcessStartInfo]::new()
        $start.FileName = $script:ProviderNode
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.WorkingDirectory = $script:ProviderRoot
        $start.RedirectStandardOutput = $true
        $start.RedirectStandardError = $true
        $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        foreach ($key in @($start.EnvironmentVariables.Keys)) {
            if ([string]$key -match '^(?:BW_|PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$|NODE_OPTIONS$|NODE_PATH$)') {
                $start.EnvironmentVariables.Remove([string]$key)
            }
        }
        # Only this CLI child receives the decrypted session; never Chrome or Node's parent.
        $start.EnvironmentVariables['BW_SESSION'] = $session
        $start.EnvironmentVariables['BITWARDENCLI_APPDATA_DIR'] = $script:ProviderAppData
        $start.EnvironmentVariables['BW_NOINTERACTION'] = 'true'
        $allArguments = @($script:ProviderCli) + $Arguments
        if ($null -ne $start.PSObject.Properties['ArgumentList']) {
            foreach ($argument in $allArguments) { [void]$start.ArgumentList.Add([string]$argument) }
        } else {
            $start.Arguments = (@($allArguments | ForEach-Object { ConvertTo-ProviderArgument ([string]$_) })) -join ' '
        }
        $process = [Diagnostics.Process]::new()
        $process.StartInfo = $start
        if (-not $process.Start()) { Stop-Provider $FailureReason }
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { try { $process.Kill() } catch {} }
            [void]$process.WaitForExit(2000)
            Stop-Provider $FailureReason
        }
        if (-not $output.Wait(2000) -or -not $errors.Wait(2000) -or $process.ExitCode -ne 0) { Stop-Provider $FailureReason }
        $text = $output.GetAwaiter().GetResult()
        # Stderr is captured but is never returned, logged or attached to an exception.
        if ($text.Length -gt 65536) { Stop-Provider $FailureReason }
        return $text
    } catch {
        if ($script:ProviderReason -eq 'session_unavailable') { $script:ProviderReason = $FailureReason }
        throw [InvalidOperationException]::new('Bitwarden CLI unavailable')
    } finally {
        if ($null -ne $process) {
            if ($null -ne $process.StartInfo) { $process.StartInfo.EnvironmentVariables.Remove('BW_SESSION') }
            $process.Dispose()
        }
        $output = $null
        $errors = $null
        $text = $null
    }
}

function Confirm-ProviderStatus {
    $statusText = Invoke-ProviderCli @('status','--nointeraction') 15 'cli_status_failed'
    try { $status = $statusText | ConvertFrom-Json } catch { Stop-Provider 'cli_status_invalid' }
    finally { $statusText = $null }
    if (-not $status -or $status -is [array] -or -not $status.PSObject.Properties['status']) { Stop-Provider 'cli_status_invalid' }
    if ((Get-CanonicalVaultServer ([string]$status.serverUrl)) -cne $script:ProviderServer) { Stop-Provider 'server_mismatch' }
    if ([string]$status.status -ceq 'locked') { Stop-Provider 'vault_locked' }
    if ([string]$status.status -ceq 'unauthenticated') { Stop-Provider 'vault_unauthenticated' }
    if ([string]$status.status -cne 'unlocked') { Stop-Provider 'vault_state_invalid' }
    if ([string]$status.userId -cne $script:ProviderVaultUserId) { Stop-Provider 'session_invalid' }
    $status = $null
}

try {
    foreach ($key in @([Environment]::GetEnvironmentVariables('Process').Keys)) {
        if ([string]$key -match '^(?:BW_|PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$)') {
            [Environment]::SetEnvironmentVariable([string]$key, $null, 'Process')
        }
    }
    $contract = Get-ProviderSiteContract $Origin
    if ($Root -notmatch '^[A-Za-z]:[\\/]' -or $null -eq $contract -or $ProfileBinding -cnotmatch '^[a-f0-9]{64}$' -or
        $AccountKey -cne 'site-default') {
        Stop-Provider 'invalid_configuration'
    }
    if (-not $AdapterId -and $Origin -ceq 'https://piggo.me') { $AdapterId = $contract.adapterId }
    if ($Origin -cne 'https://piggo.me' -and (-not $PSBoundParameters.ContainsKey('AccountKey') -or
        -not $PSBoundParameters.ContainsKey('AdapterId'))) { Stop-Provider 'profile_mismatch' }
    if ($AdapterId -cne $contract.adapterId) { Stop-Provider 'profile_mismatch' }
    $Root = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
    if (-not (Test-ProviderPath $Root (Join-Path $Root 'scripts')) -or
        -not $PSScriptRoot.Equals((Join-Path $Root 'scripts'), [StringComparison]::OrdinalIgnoreCase)) { Stop-Provider 'invalid_configuration' }
    $ancestor = $Root
    while ($ancestor) {
        if (Test-Path -LiteralPath (Join-Path $ancestor '.git')) { Stop-Provider 'invalid_configuration' }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    $configPath = Join-Path $Root 'config\config.json'
    if (-not (Test-ProviderPath $Root $configPath) -or -not (Test-Path -LiteralPath $configPath -PathType Leaf) -or
        (Get-Item -LiteralPath $configPath).Length -gt 1048576) { Stop-Provider 'invalid_configuration' }
    $config = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
    $rule = $config.bitwardenTotp
    $route = $rule.routes.PSObject.Properties[$Origin].Value
    if ($rule.enabled -isnot [bool] -or $rule.enabled -ne $true -or
        $route.enabled -isnot [bool] -or $route.enabled -ne $true) { Stop-Provider 'disabled' }
    $legacy = $Origin -ceq 'https://piggo.me'
    $routeAccount = if ($null -ne $route.accountKey) { [string]$route.accountKey } elseif ($legacy) { 'site-default' } else { '' }
    $routeAdapter = if ($null -ne $route.adapterId) { [string]$route.adapterId } elseif ($legacy) { $contract.adapterId } else { '' }
    if ([string]$route.profileBinding -cne $ProfileBinding -or $routeAccount -cne $AccountKey -or
        $routeAdapter -cne $AdapterId) { Stop-Provider 'profile_mismatch' }
    $server = Get-CanonicalVaultServer ([string]$rule.serverUrl)
    $protectedRoot = Join-Path $Root 'data\bitwarden'
    $toolRoot = Join-Path $Root 'tools\bitwarden-cli'
    $uuidPattern = '\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z'
    if (-not $server -or $server -ceq $Origin -or [string]$route.itemName -cne $contract.itemName -or
        [string]$route.itemId -cnotmatch $uuidPattern -or
        ($null -ne $rule.periodSeconds -and (($rule.periodSeconds -isnot [int] -and $rule.periodSeconds -isnot [long]) -or $rule.periodSeconds -ne 30)) -or
        -not (Test-ProviderPath $toolRoot ([string]$rule.cliEntryPoint)) -or [string]$rule.cliEntryPoint -notmatch '\.js$' -or
        -not (Test-ProviderPath $protectedRoot ([string]$rule.appDataDir)) -or
        -not (Test-ProviderPath $protectedRoot ([string]$rule.sessionFile)) -or [string]$rule.sessionFile -notmatch '\.(?:dpapi|json)$') {
        Stop-Provider 'invalid_configuration'
    }
    if (-not (Test-Path -LiteralPath $rule.cliEntryPoint -PathType Leaf)) { Stop-Provider 'entrypoint_unavailable' }
    if (-not (Test-Path -LiteralPath $rule.appDataDir -PathType Container)) { Stop-Provider 'runtime_unavailable' }
    if (-not (Test-Path -LiteralPath $rule.sessionFile -PathType Leaf)) { Stop-Provider 'session_missing' }
    if ((Get-Item -LiteralPath $rule.sessionFile).Length -gt 65536) { Stop-Provider 'session_invalid' }
    $envelope = [IO.File]::ReadAllText($rule.sessionFile) | ConvertFrom-Json
    if (($envelope.schemaVersion -isnot [int] -and $envelope.schemaVersion -isnot [long]) -or
        $envelope.schemaVersion -notin @(1,2) -or [string]$envelope.protection -cne 'CurrentUserDPAPI' -or
        [string]$envelope.protectedPayload -cnotmatch '\A[0-9a-fA-F]{80,60000}\z') { Stop-Provider 'session_invalid' }
    try {
        if ($PSVersionTable.PSVersion.Major -lt 6) {
            # A Node caller launched by pwsh can inherit PS7's module path.
            # Load this shell's own DPAPI cmdlets rather than that incompatible module.
            Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
        }
        $protected = ConvertTo-SecureString -String ([string]$envelope.protectedPayload)
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($protected)
        try { $payloadText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        # PS 7.5+ otherwise converts a legitimate +00:00 timestamp to a Local
        # DateTime before validation. Preserve its original UTC representation.
        # Windows PowerShell 5 already leaves JSON timestamps as strings.
        $payloadJsonOptions = @{}
        if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $payloadJsonOptions.DateKind = 'String' }
        $payload = $payloadText | ConvertFrom-Json @payloadJsonOptions
    } catch { Stop-Provider 'session_unavailable' }
    finally { $payloadText = $null }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (($payload.schemaVersion -isnot [int] -and $payload.schemaVersion -isnot [long]) -or
        $payload.schemaVersion -notin @(1,2) -or [string]$payload.serverUrl -cne $server -or
        [string]$payload.vaultUserId -cnotmatch $uuidPattern -or
        [string]$payload.windowsSid -cne $currentSid -or
        [string]$payload.session -cnotmatch '\A[A-Za-z0-9+/]{40,8192}={0,2}\z') { Stop-Provider 'session_invalid' }
    $expectedAuthorization = @{origin=$Origin;accountKey=$AccountKey;profileBinding=$ProfileBinding;
        itemId=[string]$route.itemId;itemName=[string]$route.itemName;adapterId=$AdapterId}
    if (-not (Test-ProviderAuthorization $payload $expectedAuthorization)) { Stop-Provider 'session_invalid' }
    $payloadSchema = $payload.schemaVersion
    $created = [DateTimeOffset]::MinValue
    $now = [DateTimeOffset]::UtcNow
    $validCreated = $false
    if ($payload.createdAtUtc -is [DateTimeOffset]) {
        $created = $payload.createdAtUtc
        $validCreated = $created.Offset -eq [TimeSpan]::Zero
    } elseif ($payload.createdAtUtc -is [datetime]) {
        $validCreated = $payload.createdAtUtc.Kind -eq [DateTimeKind]::Utc
        $created = [DateTimeOffset]$payload.createdAtUtc
    } else {
        $utcIso = '\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?(?:Z|\+00:00)\z'
        $validCreated = $payload.createdAtUtc -is [string] -and $payload.createdAtUtc -cmatch $utcIso -and
            [DateTimeOffset]::TryParse([string]$payload.createdAtUtc, [Globalization.CultureInfo]::InvariantCulture,
            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$created) -and $created.Offset -eq [TimeSpan]::Zero
    }
    if (-not $validCreated -or $created -gt $now -or $created.Year -lt 2000) {
        Stop-Provider 'session_invalid'
    }
    # No artificial expiry. CLI unlock/status detects revocation or invalidation.
    $session = [string]$payload.session
    $script:ProviderVaultUserId = [string]$payload.vaultUserId
    $payload.session = $null
    $payload = $null
    $protected.Dispose()
    $protected = $null
    . (Join-Path $Root 'scripts\Resolve-Runtime.ps1')
    $script:ProviderNode = Resolve-CheckinNode $config
    if ([IO.Path]::GetFileName($script:ProviderNode) -notmatch '^node(?:\.exe)?$') { Stop-Provider 'runtime_unavailable' }
    $script:ProviderRoot = $Root
    $script:ProviderCli = [IO.Path]::GetFullPath([string]$rule.cliEntryPoint)
    $script:ProviderAppData = [IO.Path]::GetFullPath([string]$rule.appDataDir)
    $script:ProviderServer = $server
    $lockPath = Join-Path $protectedRoot 'provider.lock'
    if (-not (Test-ProviderPath $protectedRoot $lockPath)) { Stop-Provider 'invalid_configuration' }
    try { $lockHandle = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { Stop-Provider 'provider_busy' }
    Confirm-ProviderStatus
    if ($Mode -ceq 'Prepare') {
        $now = [DateTimeOffset]::UtcNow
        $syncPath = Join-Path $protectedRoot 'sync-state.json'
        if (-not (Test-ProviderPath $protectedRoot $syncPath)) { Stop-Provider 'invalid_configuration' }
        $today = $now.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
        $syncedToday = $false
        if ((Test-Path -LiteralPath $syncPath -PathType Leaf) -and (Get-Item -LiteralPath $syncPath).Length -le 2048) {
            try {
                $marker = [IO.File]::ReadAllText($syncPath) | ConvertFrom-Json
                $synced = [DateTimeOffset]$marker.syncedAtUtc
                $sameClient = $marker.schemaVersion -eq 2 -and
                    [string]::Equals([string]$marker.appDataDir,$script:ProviderAppData,[StringComparison]::OrdinalIgnoreCase)
                $legacyMarker = $payloadSchema -eq 1 -and $Origin -ceq 'https://piggo.me' -and $marker.schemaVersion -eq 1 -and
                    [string]$marker.origin -ceq $Origin -and [string]$marker.itemName -ceq 'piggo.me' -and
                    [string]$marker.itemId -ceq [string]$route.itemId -and [string]$marker.profileBinding -ceq $ProfileBinding
                $syncedToday = ($sameClient -or $legacyMarker) -and [string]$marker.serverUrl -ceq $server -and
                    [string]$marker.vaultUserId -ceq $script:ProviderVaultUserId -and $synced -le $now -and
                    $synced.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd') -ceq $today
            } catch { $syncedToday = $false }
        }
        if (-not $syncedToday) {
            $syncOutput = Invoke-ProviderCli @('sync','--nointeraction') 45 'vault_sync_failed'
            $syncOutput = $null
            Confirm-ProviderStatus
            $markerText = @{schemaVersion=2;serverUrl=$server;vaultUserId=$script:ProviderVaultUserId;
                appDataDir=$script:ProviderAppData;syncedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')} | ConvertTo-Json -Compress
            $temporary = Join-Path $protectedRoot ('sync-state.' + [guid]::NewGuid().ToString('N') + '.tmp')
            try {
                [IO.File]::WriteAllText($temporary, $markerText, [Text.UTF8Encoding]::new($false))
                Move-Item -LiteralPath $temporary -Destination $syncPath -Force
            } finally { if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force } }
        }
        $result = @{ready=$true;reason='prepared'}
    } else {
        $before = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $validUntil = ([Math]::Floor($before / 30000) + 1) * 30000
        if ($validUntil - $before -le 6000) { Stop-Provider 'totp_near_rotation' }
        $code = (Invoke-ProviderCli @('get','totp',([string]$route.itemId),'--raw','--nointeraction') 15 'totp_read_failed').Trim()
        if ($code -cnotmatch '\A[0-9]{6}\z') { Stop-Provider 'totp_invalid' }
        $after = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        if ($after -lt $before) { Stop-Provider 'clock_unstable' }
        if (([Math]::Floor($after / 30000) + 1) * 30000 -ne $validUntil -or $validUntil - $after -le 6000) {
            Stop-Provider 'totp_near_rotation'
        }
        $result = @{ready=$true;reason='totp_ready';code=$code;validUntilMs=[long]$validUntil}
        $code = $null
    }
} catch {
    $result = @{ready=$false;reason=$script:ProviderReason}
} finally {
    $session = $null
    $payload = $null
    $payloadText = $null
    $code = $null
    $envelope = $null
    if ($null -ne $protected) { $protected.Dispose() }
    if ($null -ne $lockHandle) { $lockHandle.Dispose() }
}
# The Get result is consumed only by the Node helper's captured stdout. Never
# call this directly in an interactive terminal to display a current TOTP.
$result | ConvertTo-Json -Compress -Depth 3
if ($result.PSObject.Properties['code'] -or $result.ContainsKey('code')) { $result.code = $null }
