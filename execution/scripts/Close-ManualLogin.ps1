[CmdletBinding()]
param()

$root = Split-Path -Parent $PSScriptRoot
$signalPath = Join-Path $root 'tmp\close-manual-session.signal'
[System.IO.File]::WriteAllText($signalPath, (Get-Date).ToString('o'), [System.Text.UTF8Encoding]::new($false))
Write-Output '已请求机器人专用 Chrome 保存会话并正常关闭。'
