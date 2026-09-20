[CmdletBinding()]
param(
    [string]$AnswersPath,
    [switch]$SkipNpmInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $AnswersPath) { $AnswersPath = Join-Path $root 'setup\answers.json' }
$node = (Get-Command node -ErrorAction Stop).Source
$npm = (Get-Command npm -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $AnswersPath)) {
    throw "缺少问卷答案：$AnswersPath。请先复制 setup\answers.example.json 并填写非敏感选项。"
}

Push-Location $root
try {
    if (-not $SkipNpmInstall) {
        & $npm ci --ignore-scripts=false
        if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败。' }
    }
    & $node (Join-Path $root 'src\setup-config.mjs') --answers $AnswersPath
    if ($LASTEXITCODE -ne 0) { throw '生成本机配置失败。' }
    & (Join-Path $PSScriptRoot 'Run-Checkin.ps1') -DryRun -SuppressReport
    if ($LASTEXITCODE -ne 0) { throw '书签只读试跑失败。' }
}
finally {
    Pop-Location
}
