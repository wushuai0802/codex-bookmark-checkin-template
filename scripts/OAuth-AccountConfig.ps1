function Get-OAuthMapValue([object]$Map, [string]$Key) {
    if ($null -eq $Map) { return $null }
    $property = $Map.PSObject.Properties[$Key]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Resolve-OAuthProfilePath([string]$Root, [string]$ConfiguredPath) {
    if ([string]::IsNullOrWhiteSpace($ConfiguredPath)) { return $null }
    if ([System.IO.Path]::IsPathRooted($ConfiguredPath)) {
        return [System.IO.Path]::GetFullPath($ConfiguredPath)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $Root $ConfiguredPath))
}

function Assert-OAuthProfileInData([string]$Root, [string]$ProfilePath, [string]$Owner) {
    $dataRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'data'))
    $dataPrefix = $dataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $ProfilePath -or -not $ProfilePath.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "OAuth 账号 $Owner 的浏览器目录必须位于 data 内。"
    }
}

function Resolve-OAuthAccountConfiguration([object]$Config, [string]$Root, [string]$AccountKey) {
    if ([string]::IsNullOrWhiteSpace($AccountKey) -or $AccountKey.Length -gt 80 -or $AccountKey -match '[\r\n]') {
        throw 'OAuth accountKey 无效。'
    }
    $globalProfile = Resolve-OAuthProfilePath $Root ([string]$Config.automationUserDataDir)
    Assert-OAuthProfileInData $Root $globalProfile 'automationUserDataDir'
    $profileOwners = @{}
    $profileOwners[$globalProfile.ToLowerInvariant()] = 'automationUserDataDir'
    $primaryProfiles = @{}
    foreach ($property in @($Config.oauthAccountIdentities.PSObject.Properties)) {
        $identity = $property.Value
        $rawProfile = [string]$identity.automationUserDataDir
        if ([string]::IsNullOrWhiteSpace($rawProfile)) { continue }
        $profile = Resolve-OAuthProfilePath $Root $rawProfile
        $owner = if ($identity.accountKey) { [string]$identity.accountKey } else { [string]$property.Name }
        Assert-OAuthProfileInData $Root $profile $owner
        $profileKey = $profile.ToLowerInvariant()
        if ($profileOwners.ContainsKey($profileKey)) {
            throw "OAuth 账号浏览器目录必须唯一：$owner 与 $($profileOwners[$profileKey]) 重复。"
        }
        $profileOwners[$profileKey] = $owner
        $primaryProfiles[[string]$property.Name] = $profile
    }
    foreach ($account in @($Config.supplementalOAuthAccounts)) {
        $rawProfile = [string]$account.automationUserDataDir
        if ([string]::IsNullOrWhiteSpace($rawProfile)) { continue }
        $profile = Resolve-OAuthProfilePath $Root $rawProfile
        $owner = if ($account.accountKey) { [string]$account.accountKey } else { 'supplementalOAuthAccounts' }
        Assert-OAuthProfileInData $Root $profile $owner
        $profileKey = $profile.ToLowerInvariant()
        if ($profileOwners.ContainsKey($profileKey)) {
            throw "OAuth 账号浏览器目录必须唯一：$owner 与 $($profileOwners[$profileKey]) 重复。"
        }
        $profileOwners[$profileKey] = $owner
    }

    $matches = @()
    foreach ($property in @($Config.oauthAccountIdentities.PSObject.Properties)) {
        $identity = $property.Value
        if ([string]$identity.accountKey -ne $AccountKey) { continue }
        $origin = ([uri][string]$property.Name).GetLeftPart([System.UriPartial]::Authority)
        $matches += [pscustomobject]@{
            AccountKey = $AccountKey
            AccountId = [string]$identity.accountId
            AccountLabel = if ($identity.accountLabel) { [string]$identity.accountLabel } else { [string]$identity.accountId }
            Origin = $origin
            Provider = if ($identity.provider) { [string]$identity.provider } else { [string](Get-OAuthMapValue $Config.automaticOAuthProviders $origin) }
            UpstreamProvider = if ($identity.upstreamProvider) { [string]$identity.upstreamProvider } else { [string](Get-OAuthMapValue $Config.oauthUpstreamProviders $origin) }
            LoginUrl = if ($identity.loginUrl) { [string]$identity.loginUrl } elseif (Get-OAuthMapValue $Config.oauthLoginUrls $origin) { [string](Get-OAuthMapValue $Config.oauthLoginUrls $origin) } else { "$origin/login" }
            AutomationUserDataDir = if ($primaryProfiles.ContainsKey([string]$property.Name)) { [string]$primaryProfiles[[string]$property.Name] } else { $globalProfile }
            Supplemental = $false
        }
    }
    foreach ($account in @($Config.supplementalOAuthAccounts)) {
        if ([string]$account.accountKey -ne $AccountKey) { continue }
        $origin = ([uri][string]$account.origin).GetLeftPart([System.UriPartial]::Authority)
        $rawProfile = [string]$account.automationUserDataDir
        $profile = Resolve-OAuthProfilePath $Root $rawProfile
        $matches += [pscustomobject]@{
            AccountKey = $AccountKey
            AccountId = [string]$account.accountId
            AccountLabel = if ($account.accountLabel) { [string]$account.accountLabel } else { [string]$account.accountId }
            Origin = $origin
            Provider = [string]$account.provider
            UpstreamProvider = [string]$account.upstreamProvider
            LoginUrl = if ($account.loginUrl) { [string]$account.loginUrl } else { "$origin/login" }
            AutomationUserDataDir = $profile
            Supplemental = $true
        }
    }
    if ($matches.Count -ne 1) { throw "OAuth accountKey 必须唯一匹配一个已配置账号：$AccountKey" }
    $binding = $matches[0]
    foreach ($field in @('AccountId', 'Provider', 'UpstreamProvider', 'LoginUrl', 'AutomationUserDataDir')) {
        if ([string]::IsNullOrWhiteSpace([string]$binding.$field)) { throw "OAuth 账号 $AccountKey 缺少 $field 配置。" }
    }
    $originUri = [uri]$binding.Origin
    $loginUri = [uri]$binding.LoginUrl
    if ($originUri.Scheme -ne 'https' -or $originUri.UserInfo -or $loginUri.Scheme -ne 'https' -or $loginUri.UserInfo `
        -or $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $binding.Origin) {
        throw "OAuth 账号 $AccountKey 的站点地址无效。"
    }
    Assert-OAuthProfileInData $Root ([string]$binding.AutomationUserDataDir) $AccountKey
    return $binding
}
