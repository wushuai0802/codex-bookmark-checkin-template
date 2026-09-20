[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$ConfigPath,
    [switch]$AllProfiles
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$effectiveConfigPath = if ($ConfigPath) { [System.IO.Path]::GetFullPath($ConfigPath) } else { Join-Path $root 'config\config.json' }
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $effectiveConfigPath | ConvertFrom-Json
$profileRoot = [System.IO.Path]::GetFullPath([string]$config.automationUserDataDir).TrimEnd('\')
$allowedParent = [System.IO.Path]::GetFullPath((Join-Path $root 'data')).TrimEnd('\')

if (-not $profileRoot.StartsWith("$allowedParent\", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw '安全检查失败：只允许清理项目 data 下的机器人 Chrome。'
}

function Assert-NoReparsePointInPath([string]$Path, [string]$Boundary) {
    $current = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
    $boundaryPath = [System.IO.Path]::GetFullPath($Boundary).TrimEnd('\')
    while ($current.StartsWith($boundaryPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "安全检查失败：路径包含联接点或符号链接：$current"
            }
        }
        if ($current.Equals($boundaryPath, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = Split-Path -Parent $current
        if (-not $parent -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent.TrimEnd('\')
    }
}

function Assert-NoReparsePointTree([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
        $current = $pending.Pop()
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "安全检查失败：清理目标包含联接点或符号链接：$current"
        }
        if (-not $item.PSIsContainer) { continue }
        foreach ($child in @(Get-ChildItem -LiteralPath $current -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "安全检查失败：清理目标包含联接点或符号链接：$($child.FullName)"
            }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
}

Assert-NoReparsePointInPath $profileRoot $allowedParent

$running = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    $_.CommandLine -like "*$profileRoot*"
})
if ($running.Count -gt 0) { throw '机器人 Chrome 正在运行，拒绝清理缓存。' }

$relativeTargets = @(
    'OptGuideOnDeviceModel',
    'optimization_guide_model_store',
    'BrowserMetrics',
    'GrShaderCache',
    'ShaderCache',
    'GPUCache',
    'DawnCache',
    'DawnGraphiteCache',
    'Default\Cache',
    'Default\Code Cache',
    'Default\GPUCache',
    'Default\GrShaderCache',
    'Default\DawnCache',
    'Default\DawnGraphiteCache'
)
$protectedSegments = @(
    'Cookies', 'Network', 'Local Storage', 'Session Storage', 'IndexedDB',
    'Service Worker', 'Login Data'
)

function Get-DirectoryBytes([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [int64]0 }
    return [int64]((Get-ChildItem -LiteralPath $Path -File -Recurse -Force -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum)
}

$items = @()

# 需要清理的配置目录集合。默认只处理主自动化配置；-AllProfiles 会同时覆盖
# data\accounts、data\sites、data\sessions 下的每个独立 Chrome 配置。
$profileRoots = [System.Collections.Generic.List[string]]::new()
$profileRoots.Add($profileRoot)
if ($AllProfiles) {
    foreach ($group in @('accounts', 'sites', 'sessions')) {
        $groupRoot = Join-Path $allowedParent $group
        if (-not (Test-Path -LiteralPath $groupRoot)) { continue }
        foreach ($entry in @(Get-ChildItem -LiteralPath $groupRoot -Directory -Force -ErrorAction SilentlyContinue)) {
            $candidate = [System.IO.Path]::GetFullPath((Join-Path $entry.FullName 'chrome-user-data')).TrimEnd('\')
            if (-not (Test-Path -LiteralPath (Join-Path $candidate 'Local State'))) { continue }
            if (-not $candidate.StartsWith("$allowedParent\", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            if ($profileRoots -notcontains $candidate) { $profileRoots.Add($candidate) }
        }
    }
}

foreach ($currentProfileRoot in $profileRoots) {
    Assert-NoReparsePointInPath $currentProfileRoot $allowedParent
    $profileRunning = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
        $_.CommandLine -like "*$currentProfileRoot*"
    })
    if ($profileRunning.Count -gt 0) {
        throw "机器人 Chrome 正在运行，拒绝清理缓存：$currentProfileRoot"
    }
    foreach ($relative in $relativeTargets) {
        if ($protectedSegments | Where-Object { $relative -like "*$_*" }) {
            throw "清理白名单包含受保护路径：$relative"
        }
        $target = [System.IO.Path]::GetFullPath((Join-Path $currentProfileRoot $relative))
        if (-not $target.StartsWith("$currentProfileRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "清理目标越界：$relative"
        }
        Assert-NoReparsePointTree $target
        $bytes = Get-DirectoryBytes $target
        if ($bytes -le 0) { continue }
        $items += [pscustomobject]@{
            profileRoot  = $currentProfileRoot
            relativePath = $relative
            bytes        = $bytes
        }
        if ($Apply) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
}

[pscustomobject]@{
    mode = if ($Apply) { 'applied' } else { 'dry_run' }
    profileRoot = $profileRoot
    profileRootCount = $profileRoots.Count
    profileRoots = @($profileRoots)
    itemCount = $items.Count
    totalBytes = [int64](($items | Measure-Object -Property bytes -Sum).Sum)
    items = $items
} | ConvertTo-Json -Depth 5
