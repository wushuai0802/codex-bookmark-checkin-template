[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipSavedLoginSync,
    [string]$UserDataDirOverride
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$sourceRoot = [System.IO.Path]::GetFullPath([string]$config.sourceUserDataDir)
$targetRoot = if ($UserDataDirOverride) { [System.IO.Path]::GetFullPath($UserDataDirOverride) } else { [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir) }
$expectedParent = [System.IO.Path]::GetFullPath((Join-Path $root 'data'))
$expectedPrefix = $expectedParent.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not $targetRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "安全检查失败：目标会话目录必须位于 $expectedParent"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot 'Local State'))) {
    throw "未找到 Chrome Local State：$sourceRoot"
}
if (Test-Path -LiteralPath $targetRoot) {
    if (-not $Force) { throw '独立登录会话已存在。使用 -Force 时会先保留时间戳备份。' }
    $resolved = (Resolve-Path -LiteralPath $targetRoot).Path
    if (-not $resolved.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw '拒绝移动工作区之外的目录。'
    }
    Move-Item -LiteralPath $targetRoot -Destination "$targetRoot.backup-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
}

New-Item -ItemType Directory -Path (Join-Path $targetRoot 'Default') -Force | Out-Null
# Local State contains Chrome's OS-protected encryption metadata.  It stays in
# ignored local data and lets selectively copied saved-login rows remain usable.
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Local State') -Destination (Join-Path $targetRoot 'Local State') -Force

$chrome = [string]$config.chromeExecutable
if (-not (Test-Path -LiteralPath $chrome)) { throw "未找到 Chrome：$chrome" }
$process = Start-Process -FilePath $chrome -ArgumentList @(
    "--user-data-dir=$targetRoot", '--profile-directory=Default', '--headless=new',
    '--no-first-run', '--no-default-browser-check',
    '--disable-features=OptimizationGuideOnDeviceModel', 'about:blank'
) -WindowStyle Hidden -PassThru
try {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and -not (Test-Path -LiteralPath (Join-Path $targetRoot 'Default\Login Data'))) {
        Start-Sleep -Milliseconds 500
    }
}
finally {
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$targetRoot*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
if (-not (Test-Path -LiteralPath (Join-Path $targetRoot 'Default\Login Data'))) {
    throw 'Chrome 未能初始化独立配置。'
}

if (-not $UserDataDirOverride -and -not $SkipSavedLoginSync -and $config.syncBookmarkSavedLogins -ne $false) {
    & (Join-Path $PSScriptRoot 'Sync-ChromeSavedLogins.ps1')
}

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
foreach ($securePath in @((Join-Path $root 'data'), (Join-Path $root 'logs'))) {
    New-Item -ItemType Directory -Path $securePath -Force | Out-Null
    & icacls.exe $securePath /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "无法收紧目录权限：$securePath" }
}

Write-Output "独立登录会话已创建：$targetRoot"
Write-Output '未复制完整 Cookie 或浏览历史。需要 OAuth/人机验证时，请用 Open-ManualLogin.ps1 完成首次可见登录。'
