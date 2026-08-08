[CmdletBinding()]
param([int]$RetentionHours = 48)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tmpRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'tmp')).TrimEnd('\')
$tmpPrefix = "$tmpRoot\"
$cutoff = (Get-Date).ToUniversalTime().AddHours(-[Math]::Max(1, [Math]::Min(720, $RetentionHours)))
$removed = 0
foreach ($item in @(Get-ChildItem -LiteralPath $tmpRoot -Force -ErrorAction SilentlyContinue)) {
    if ($item.Name -eq '.gitkeep' -or $item.LastWriteTimeUtc -ge $cutoff) { continue }
    $resolved = [System.IO.Path]::GetFullPath($item.FullName)
    if (-not $resolved.StartsWith($tmpPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw '临时清理目标越界。' }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "拒绝清理重解析点：$resolved" }
    if ($item.PSIsContainer -and @(Get-ChildItem -LiteralPath $resolved -Force -Recurse | Where-Object {
        ($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
    }).Count -gt 0) { throw "拒绝清理包含重解析点的目录：$resolved" }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    $removed += 1
}
[pscustomobject]@{ removed = $removed; cutoff = $cutoff.ToString('o') } | ConvertTo-Json -Compress
