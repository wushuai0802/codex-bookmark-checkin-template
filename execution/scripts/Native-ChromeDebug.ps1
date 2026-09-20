function Reset-NativeChromeDebugPort([string]$ProfilePath) {
    $path = Join-Path ([System.IO.Path]::GetFullPath($ProfilePath)) 'DevToolsActivePort'
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    return $path
}

function Get-NativeChromeDebugPort {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        $port = [int]$listener.LocalEndpoint.Port
        if ($port -le 0 -or $port -gt 65535) { throw '无法选择本机回环调试端口。' }
        return $port
    }
    finally {
        $listener.Stop()
    }
}

function Test-NativeChromeDebugEndpoint([int]$Port) {
    $response = $null
    $reader = $null
    try {
        $request = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port/json/version")
        $request.Proxy = $null
        $request.Timeout = 1000
        $response = $request.GetResponse()
        $reader = [System.IO.StreamReader]::new($response.GetResponseStream())
        $version = $reader.ReadToEnd() | ConvertFrom-Json
        $webSocket = [uri][string]$version.webSocketDebuggerUrl
        return $webSocket.Scheme -eq 'ws' -and $webSocket.Port -eq $Port
    }
    catch {
        return $false
    }
    finally {
        if ($reader) { $reader.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function Wait-NativeChromeDebugPort([string]$ProfilePath, [int]$ExpectedPort, [int]$TimeoutSeconds = 20) {
    if ($ExpectedPort -le 0 -or $ExpectedPort -gt 65535) { throw '原生 Chrome 调试端口必须是非零有效端口。' }
    $resolvedProfile = [System.IO.Path]::GetFullPath($ProfilePath)
    $expectedPortArgument = "--remote-debugging-port=$ExpectedPort"
    $deadline = (Get-Date).AddSeconds([Math]::Max(5, [Math]::Min(60, $TimeoutSeconds)))
    do {
        # Chrome only writes DevToolsActivePort when started with port 0.  For
        # a fixed non-zero port, bind the endpoint to the exact profile-owned
        # Chrome process before trusting the loopback DevTools response.
        $matchingChrome = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -like "*$resolvedProfile*" -and $_.CommandLine -like "*$expectedPortArgument*"
        })
        if ($matchingChrome.Count -gt 0 -and (Test-NativeChromeDebugEndpoint $ExpectedPort)) { return $ExpectedPort }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    throw '原生 Chrome 未在限定时间内启用已验证的本机回环调试端口。'
}
