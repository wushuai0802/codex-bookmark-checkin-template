function Reset-NativeChromeDebugPort([string]$ProfilePath) {
    $path = Join-Path ([System.IO.Path]::GetFullPath($ProfilePath)) 'DevToolsActivePort'
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $path
}

function Wait-NativeChromeDebugPort([string]$ProfilePath, [int]$TimeoutSeconds = 20) {
    $path = Join-Path ([System.IO.Path]::GetFullPath($ProfilePath)) 'DevToolsActivePort'
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, [Math]::Min(60, $TimeoutSeconds)))
    do {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            $line = @(Get-Content -LiteralPath $path -ErrorAction SilentlyContinue | Select-Object -First 1)[0]
            $port = 0
            if ([int]::TryParse([string]$line, [ref]$port) -and $port -gt 0 -and $port -le 65535) { return $port }
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw '原生 Chrome 未在限定时间内写入动态调试端口。'
}
