[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$Provider,
    [string]$LoginUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$node = Resolve-CheckinNode $config
$originUri = [uri]$Origin
if ($originUri.Scheme -ne 'https' -or -not $originUri.Host -or $originUri.UserInfo) {
    throw '原生 OAuth 恢复来源无效。'
}
if ([string]::IsNullOrWhiteSpace($Provider) -or $Provider.Length -gt 40 -or $Provider -match '[\r\n]') {
    throw '原生 OAuth 提供商无效。'
}
$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
$rule = $config.oauthReloginCheckinRules.PSObject.Properties[$originValue].Value
if ($null -eq $rule -or $rule.nativeBrowser -ne $true) {
    throw '目标站点没有启用原生浏览器 OAuth 恢复。'
}
$targetUrl = if ($LoginUrl) { [uri]$LoginUrl } else { [uri]::new($originUri, '/login') }
if ($targetUrl.Scheme -ne 'https' -or $targetUrl.UserInfo -or
    $targetUrl.GetLeftPart([System.UriPartial]::Authority) -ne $originValue) {
    throw '原生 OAuth 登录地址不属于目标站点。'
}

$profilePath = [string]$config.automationUserDataDir
function Get-AutomationChromeProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
}
if ((Get-AutomationChromeProcesses).Count -gt 0) {
    throw '机器人专用 Chrome 正被占用，无法执行原生 OAuth 恢复。'
}

function Close-AutomationChrome {
    $targets = @(Get-AutomationChromeProcesses)
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    $deadline = (Get-Date).AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AutomationChromeProcesses)
    } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) {
        $remainingIds = @($remaining.ProcessId)
        $remainingRoots = @($remaining | Where-Object { $remainingIds -notcontains $_.ParentProcessId })
        foreach ($processInfo in $remainingRoots) {
            Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }
}

$debugPort = Get-Random -Minimum 12000 -Maximum 32000
$nodeExitCode = 1
try {
    $openParameters = @{
        Offscreen = $true
        RemoteDebuggingPort = $debugPort
        Urls = @($targetUrl.AbsoluteUri)
    }
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') @openParameters | Out-Null
    Start-Sleep -Seconds 4
    $output = & $node (Join-Path $root 'src\native-oauth-login.mjs') $debugPort $originValue $Provider
    $nodeExitCode = $LASTEXITCODE
    if ($output) { Write-Output $output }
}
finally {
    Close-AutomationChrome
}

exit $nodeExitCode
