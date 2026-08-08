[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$AccountKey)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'OAuth-AccountConfig.ps1')
$binding = Resolve-OAuthAccountConfiguration $config $root $AccountKey
& (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
    -Urls @($binding.LoginUrl) `
    -UserDataDirOverride $binding.AutomationUserDataDir `
    -EnablePasswordManager
Write-Output "已打开账号 $($binding.AccountLabel) 的独立窗口；目标 ID=$($binding.AccountId)，站点登录方式=$($binding.Provider)，上游登录方式=$($binding.UpstreamProvider)。"
