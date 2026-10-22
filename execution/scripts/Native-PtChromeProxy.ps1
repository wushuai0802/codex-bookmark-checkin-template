. (Join-Path $PSScriptRoot 'CheckinContract.generated.ps1')

function Throw-NativePtChromeProxyError([string]$Code, [string]$Reason) {
    $exception = [InvalidOperationException]::new($Reason)
    $exception.Data['NativePtProxyFailureCode'] = $Code
    throw $exception
}

function ConvertTo-NativePtChromeProxyServer($Value) {
    # IP literals only: do not resolve a proxy hostname or accept credentials,
    # redirects, alternate numeric IP notations or command-line separators.
    if ($Value -isnot [string] -or $Value.Length -gt 150 -or
        $Value -cnotmatch '\Ahttp://(?<host>(?:[0-9]{1,3}\.){3}[0-9]{1,3}|\[::1\])(?::[1-9][0-9]{0,4})?/?\z') {
        Throw-NativePtChromeProxyError 'native_proxy_configuration_invalid' '站点代理必须是无凭据的内网或本机 HTTP 地址。'
    }
    $hostText = $Matches.host
    $uri = $null
    if (-not [uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or $uri.Port -lt 1 -or $uri.Port -gt 65535) {
        Throw-NativePtChromeProxyError 'native_proxy_configuration_invalid' '站点代理端口无效。'
    }
    $allowed = $hostText -ceq '[::1]'
    if (-not $allowed) {
        $octets = @($hostText.Split('.'))
        foreach ($octet in $octets) {
            if ($octet -cnotmatch '^(?:0|[1-9][0-9]{0,2})$' -or [int]$octet -gt 255) {
                Throw-NativePtChromeProxyError 'native_proxy_configuration_invalid' '站点代理 IP 格式无效。'
            }
        }
        $a = [int]$octets[0]; $b = [int]$octets[1]
        $allowed = $a -eq 127 -or $a -eq 10 -or ($a -eq 172 -and $b -ge 16 -and $b -le 31) -or
            ($a -eq 192 -and $b -eq 168) -or ($a -eq 100 -and $b -ge 64 -and $b -le 127)
    }
    if (-not $allowed) {
        Throw-NativePtChromeProxyError 'native_proxy_configuration_invalid' '站点代理仅允许本机、私有内网或 Tailscale IP。'
    }
    return 'http://' + $hostText + ':' + $uri.Port
}

function Resolve-NativePtChromeProxy($Config, [string]$Origin) {
    $mapping = $Config.nativePtProxyByOrigin
    if ($null -eq $mapping) { return '' }
    if ($mapping -isnot [Collections.IDictionary] -and $mapping -isnot [pscustomobject]) {
        Throw-NativePtChromeProxyError 'native_proxy_configuration_invalid' '站点代理映射必须是按来源登记的对象。'
    }
    $entries = @(if ($mapping -is [Collections.IDictionary]) {
        @($mapping.Keys | Where-Object { [string]$_ -ceq $Origin } | ForEach-Object { [pscustomobject]@{Value=$mapping[$_]} })
    } else {
        @($mapping.PSObject.Properties | Where-Object { $_.Name -ceq $Origin })
    })
    if ($entries.Count -eq 0) { return '' }
    if ($entries.Count -ne 1 -or $Origin -cnotin $CheckinNativePtHeaderOrigins) {
        Throw-NativePtChromeProxyError 'native_proxy_origin_not_registered' '站点代理只能绑定已登记的原生 PT 来源。'
    }
    $registered = @(@($Config.nativeWafPreflightUrls) + @($Config.nativeChallengePreflight) + @($Config.mainChromeFallbackUrls) | Where-Object {
        try {
            $url = if ($_ -is [string]) { [string]$_ } elseif ($_.sourceOrigin) { [string]$_.sourceOrigin } else { [string]$_.url }
            $uri = [uri]$url
            $uri.Scheme -ceq 'https' -and -not $uri.UserInfo -and $uri.GetLeftPart([UriPartial]::Authority) -ceq $Origin
        } catch { $false }
    })
    if ($registered.Count -eq 0) {
        Throw-NativePtChromeProxyError 'native_proxy_origin_not_registered' '站点代理缺少当前原生执行入口登记。'
    }
    return ConvertTo-NativePtChromeProxyServer $entries[0].Value
}

function Resolve-NativePtChromeProxyForOrigins($Config, [string[]]$Origins) {
    $selected = @($Origins | ForEach-Object { $proxy = Resolve-NativePtChromeProxy $Config $_; if ($proxy) { $proxy } })
    if ($selected.Count -eq 0) { return '' }
    if ($Origins.Count -ne 1 -or $selected.Count -ne 1) {
        Throw-NativePtChromeProxyError 'native_proxy_origin_not_registered' '站点专用代理只能用于单一来源窗口。'
    }
    return $selected[0]
}

function Get-NativePtChromeSwitchValues([string]$CommandLine, [string]$Name) {
    $key = [regex]::Escape($Name)
    $pattern = '(?<!\S)(?:"--' + $key + '=(?<outer>[^"]*)"|--' + $key + '=(?:"(?<inner>[^"]*)"|(?<plain>[^\s"]+))|--' + $key + '\s+(?:"(?<nextQuoted>[^"]*)"|(?<nextPlain>[^\s"]+)))(?=\s|$)'
    foreach ($match in [regex]::Matches($CommandLine, $pattern)) {
        foreach ($group in @('outer', 'inner', 'plain', 'nextQuoted', 'nextPlain')) {
            if ($match.Groups[$group].Success) { $match.Groups[$group].Value; break }
        }
    }
}

function Assert-NativePtMainChromeProxy {
    param($Config, [string]$ProfileRoot, [string]$Origin, [string]$ProxyServer,
        [AllowEmptyCollection()][object[]]$Processes)
    if (-not $ProxyServer) { return }
    $expected = ConvertTo-NativePtChromeProxyServer $ProxyServer
    $profileRootPath = [IO.Path]::GetFullPath($ProfileRoot).TrimEnd('\', '/')
    $executable = [IO.Path]::GetFullPath([string]$Config.chromeExecutable)
    if (-not $PSBoundParameters.ContainsKey('Processes')) {
        $Processes = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'")
    }
    foreach ($process in $Processes) {
        if ($process.Name -ne 'chrome.exe') { continue }
        if ($process.ExecutablePath -and -not [string]::Equals([IO.Path]::GetFullPath([string]$process.ExecutablePath), $executable, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $command = [string]$process.CommandLine
        if ($command -match '(?:^|\s)"?--type(?:=|\s|"|$)') { continue }
        if (-not $command) {
            Throw-NativePtChromeProxyError 'native_proxy_profile_conflict' '无法确认现有主 Chrome 的代理；未启动签到或触碰用户窗口。'
        }
        $roots = @(Get-NativePtChromeSwitchValues $command 'user-data-dir')
        if ($roots.Count -gt 1 -or ($roots.Count -eq 0 -and $command -match '(?:^|\s)"?--user-data-dir(?:=|\s|"|$)')) {
            Throw-NativePtChromeProxyError 'native_proxy_profile_conflict' '无法确认现有 Chrome 的 Profile 路由；未启动签到或触碰用户窗口。'
        }
        $actualRoot = if ($roots.Count -eq 1) { [IO.Path]::GetFullPath($roots[0]).TrimEnd('\', '/') } else {
            (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Google\Chrome\User Data').TrimEnd('\', '/')
        }
        if (-not [string]::Equals($actualRoot, $profileRootPath, [StringComparison]::OrdinalIgnoreCase)) { continue }
        $proxyValues = @(Get-NativePtChromeSwitchValues $command 'proxy-server')
        $actualProxy = ''
        if ($proxyValues.Count -eq 1) { try { $actualProxy = ConvertTo-NativePtChromeProxyServer $proxyValues[0] } catch { } }
        $overridden = $command -match '(?:^|\s)"?--(?:no-proxy-server|proxy-pac-url|proxy-auto-detect)(?:=|\s|"|$)'
        $bypassed = $false
        $hostName = ([uri]$Origin).DnsSafeHost -replace '^www\.', ''
        foreach ($bypass in @(Get-NativePtChromeSwitchValues $command 'proxy-bypass-list')) {
            foreach ($rule in $bypass.Split(';')) {
                $rule = $rule.Trim()
                if (-not $rule -or $rule -in @('<local>', '<-loopback>')) { continue }
                if ($hostName -like $rule -or ('www.' + $hostName) -like $rule -or $Origin -like $rule) { $bypassed = $true }
            }
        }
        if ($actualProxy -cne $expected -or $overridden -or $bypassed) {
            Throw-NativePtChromeProxyError 'native_proxy_profile_conflict' '现有主 Chrome 使用不同的代理路由；已停止，未提交签到或关闭用户窗口。'
        }
    }
}

function Get-NativePtChromeProxyFailure($ErrorRecord) {
    $code = [string]$ErrorRecord.Exception.Data['NativePtProxyFailureCode']
    if (-not $code) { return $null }
    return [pscustomobject]@{status='unconfirmed';failureCode='native_readback_unavailable';nativeProxyFailureCode=$code;
        submissionAttempted=$false;retryable=$false;
        nativeReadback=[pscustomobject]@{stage='preflight';code='profile_binding_unavailable';exitCode=$null;durationMs=0;stderrPresent=$false;stderrBytes=0};
        reason=if($code -eq 'native_proxy_profile_conflict'){'主 Chrome 的现有代理路由与站点专用路由不一致；未提交签到或触碰用户窗口'}else{'站点专用代理配置未通过验证；未提交签到'}}
}
