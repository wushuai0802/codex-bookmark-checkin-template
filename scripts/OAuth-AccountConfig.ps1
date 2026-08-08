function Get-OAuthMapValue([object]$Map, [string]$Key) {
    if ($null -eq $Map) { return $null }
    $property = $Map.PSObject.Properties[$Key]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Resolve-OAuthAccountConfiguration([object]$Config, [string]$Root, [string]$AccountKey) {
    if ([string]::IsNullOrWhiteSpace($AccountKey) -or $AccountKey.Length -gt 80 -or $AccountKey -match '[\r\n]') {
        throw 'OAuth accountKey 无效。'
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
            Provider = [string](Get-OAuthMapValue $Config.automaticOAuthProviders $origin)
            UpstreamProvider = [string](Get-OAuthMapValue $Config.oauthUpstreamProviders $origin)
            LoginUrl = if (Get-OAuthMapValue $Config.oauthLoginUrls $origin) { [string](Get-OAuthMapValue $Config.oauthLoginUrls $origin) } else { "$origin/login" }
            AutomationUserDataDir = [System.IO.Path]::GetFullPath([string]$Config.automationUserDataDir)
            Supplemental = $false
        }
    }
    foreach ($account in @($Config.supplementalOAuthAccounts)) {
        if ([string]$account.accountKey -ne $AccountKey) { continue }
        $origin = ([uri][string]$account.origin).GetLeftPart([System.UriPartial]::Authority)
        $rawProfile = [string]$account.automationUserDataDir
        $profile = if ([System.IO.Path]::IsPathRooted($rawProfile)) { [System.IO.Path]::GetFullPath($rawProfile) } else { [System.IO.Path]::GetFullPath((Join-Path $Root $rawProfile)) }
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
    $dataRoot = [System.IO.Path]::GetFullPath((Join-Path $Root 'data'))
    $dataPrefix = $dataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $binding.AutomationUserDataDir.StartsWith($dataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "OAuth 账号 $AccountKey 的浏览器目录必须位于 data 内。"
    }
    return $binding
}
