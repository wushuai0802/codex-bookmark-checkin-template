[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [string]$LoginUrl,
    [string]$UserDataDirOverride
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
. (Join-Path $PSScriptRoot 'Native-ChromeDebug.ps1')
$node = Resolve-CheckinNode $config
$originUri = [uri]$Origin
if ($originUri.Scheme -ne 'https' -or -not $originUri.Host) { throw '原生登录恢复来源无效。' }
$targetUrl = if ($LoginUrl) { [uri]$LoginUrl } else { [uri]::new($originUri, '/login') }
if ($targetUrl.GetLeftPart([System.UriPartial]::Authority) -ne $originUri.GetLeftPart([System.UriPartial]::Authority)) {
    throw '原生登录恢复地址不属于目标站点。'
}

$allowedDataRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$allowedDataPrefix = $allowedDataRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$profilePath = [System.IO.Path]::GetFullPath($(if ($UserDataDirOverride) { $UserDataDirOverride } else { [string]$config.automationUserDataDir }))
if (-not $profilePath.StartsWith($allowedDataPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "机器人 Chrome 目录必须位于 $allowedDataRoot"
}
$existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profilePath*" })
if ($existing.Count -gt 0) { throw '机器人专用 Chrome 正被占用，无法恢复登录。' }

$originValue = $originUri.GetLeftPart([System.UriPartial]::Authority)
try {
    # Chrome stores synced/account passwords in "Login Data For Account".
    # Keeping --disable-sync on this native recovery window prevents that store
    # from participating in autofill even though the encrypted row is present.
    # EnablePasswordManager only removes that launch restriction; the helper
    # still never reads or prints the saved username/password.
    [void](Reset-NativeChromeDebugPort $profilePath)
    $debugPort = Get-NativeChromeDebugPort
    & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') -Offscreen -EnablePasswordManager -RemoteDebuggingPort $debugPort -Urls @($targetUrl.AbsoluteUri) -UserDataDirOverride $profilePath
    $debugPort = Wait-NativeChromeDebugPort $profilePath $debugPort 25
    $loginSucceeded = $false
    for ($loginAttempt = 1; $loginAttempt -le 3 -and -not $loginSucceeded; $loginAttempt++) {
        & $node (Join-Path $root 'src\native-login.mjs') $debugPort $originValue
        $loginSucceeded = $LASTEXITCODE -eq 0
        if (-not $loginSucceeded -and $loginAttempt -lt 3) {
            # The account password store can take a few seconds to become
            # available after a cold native Chrome launch.  Reuse the same
            # window instead of relaunching it or resyncing the database.
            Start-Sleep -Seconds 8
        }
    }
    if (-not $loginSucceeded) { throw '原生 Chrome 未能自动恢复登录。' }
}
finally {
    $targets = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    })
    $targetIds = @($targets.ProcessId)
    $roots = @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })
    foreach ($processInfo in $roots) {
        $process = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
        if ($process) { [void]$process.CloseMainWindow() }
    }
    Start-Sleep -Seconds 3
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$profilePath*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
