[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$node = Resolve-CheckinNode $config
$statePath = Join-Path $root 'tmp\manual-session.json'

if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
    if (Get-Process -Id $state.pid -ErrorAction SilentlyContinue) {
        Write-Output "手动登录窗口已经运行，PID=$($state.pid)。"
        exit 0
    }
    Remove-Item -LiteralPath $statePath -Force
}

Start-Process -FilePath $node -ArgumentList @((Join-Path $root 'src\manual-session.mjs')) -WorkingDirectory $root -WindowStyle Hidden
Write-Output '正在打开机器人专用 Chrome 登录窗口。'
