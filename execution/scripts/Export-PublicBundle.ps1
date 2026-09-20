[CmdletBinding()]
param([string]$OutputPath)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$git = (Get-Command git -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath (Join-Path $root '.git'))) { throw '当前目录尚未初始化为 Git 仓库。' }
& (Join-Path $PSScriptRoot 'Scan-PublicSafety.ps1') | Out-Host
if (-not $?) { throw '敏感信息扫描未通过，拒绝导出。' }
$dirty = @(& $git -C $root status --porcelain --untracked-files=no)
if ($dirty.Count -gt 0) { throw '存在尚未提交的已跟踪改动，提交并复查后再导出。' }
if (-not $OutputPath) { $OutputPath = Join-Path $root 'outputs\codex-bookmark-checkin-template.zip' }
$resolvedParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $OutputPath))
New-Item -ItemType Directory -Path $resolvedParent -Force | Out-Null
& $git -C $root archive --format=zip --output=$OutputPath HEAD
if ($LASTEXITCODE -ne 0) { throw 'Git 安全分享包导出失败。' }
Write-Output "安全分享包已生成：$OutputPath"
