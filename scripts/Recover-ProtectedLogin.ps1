[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Origin,
    [Parameter(Mandatory = $true)][string]$LoginUrl
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Resolve-Runtime.ps1')
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$node = Resolve-CheckinNode $config
$uri = [uri]$Origin
$loginUri = [uri]$LoginUrl
if ($uri.Scheme -ne 'https' -or $loginUri.GetLeftPart([System.UriPartial]::Authority) -ne $uri.GetLeftPart([System.UriPartial]::Authority)) {
    throw '受保护登录地址不属于目标 HTTPS origin。'
}
$originKey = $uri.GetLeftPart([System.UriPartial]::Authority)
$verificationProperty = if ($null -ne $config.protectedLoginVerificationPaths) {
    $config.protectedLoginVerificationPaths.PSObject.Properties[$originKey]
} else { $null }
if (-not $verificationProperty -or [string]::IsNullOrWhiteSpace([string]$verificationProperty.Value)) {
    Write-Output '{"status":"failed","diagnostic":"verification_path_missing"}'
    exit 2
}
$verificationUri = [Uri]::new($uri, [string]$verificationProperty.Value)
if ($verificationUri.Scheme -ne 'https' -or $verificationUri.GetLeftPart([System.UriPartial]::Authority) -ne $originKey) {
    Write-Output '{"status":"failed","diagnostic":"verification_path_invalid"}'
    exit 2
}
$verificationUrl = $verificationUri.AbsoluteUri
$preferNative = $false
foreach ($item in @($config.nativeWafPreflightUrls)) {
    $candidateValue = if ($item -is [string]) { [string]$item } else { [string]$item.url }
    try {
        if ([Uri]::new($candidateValue).GetLeftPart([System.UriPartial]::Authority) -eq $originKey) {
            $preferNative = $true
            break
        }
    } catch { }
}

$hostKey = ($uri.DnsSafeHost -replace '[^a-z0-9.-]', '_').ToLowerInvariant()
$credentialPath = Join-Path $root "data\credentials\$hostKey.json"
if (-not (Test-Path -LiteralPath $credentialPath)) {
    Write-Output '{"status":"credential_missing"}'
    exit 2
}
$stored = Get-Content -Raw -Encoding UTF8 -LiteralPath $credentialPath | ConvertFrom-Json
if ([string]$stored.origin -ne $uri.GetLeftPart([System.UriPartial]::Authority)) { throw '受保护凭据来源不匹配。' }

function Unprotect-Text([string]$Value) {
    $secure = ConvertTo-SecureString $Value
    $pointer = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Invoke-CredentialProcess([string]$ScriptPath, [string[]]$Arguments, [string]$Username, [string]$Password) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    [void]$start.ArgumentList.Add($ScriptPath)
    foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add([string]$argument) }
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine((@{ username = $Username; password = $Password } | ConvertTo-Json -Compress))
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(180000)) {
        try { $process.Kill($true) } catch { try { $process.Kill() } catch { } }
        return [pscustomobject]@{ exitCode = 2; stdout = '{"status":"timeout"}'; stderr = '' }
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if (-not $stdout) {
        $diagnostic = if ($stderr -match 'user data directory|profile.*(?:use|lock)|ProcessSingleton') { 'profile_busy' }
        elseif ($stderr -match 'Timeout|timed out') { 'timeout' }
        elseif ($stderr -match 'strict mode|selector|Unexpected token') { 'form_unsupported' }
        else { 'helper_failed' }
        $stdout = @{ status = 'failed'; diagnostic = $diagnostic } | ConvertTo-Json -Compress
    }
    return [pscustomobject]@{ exitCode = $process.ExitCode; stdout = $stdout.Trim(); stderr = $stderr }
}

function Get-HelperStatus([string]$Text) {
    try { return [string](($Text | ConvertFrom-Json).status) }
    catch { return 'failed' }
}

$usernamePlain = $null
$passwordPlain = $null
$nativeChromeStarted = $false
$finalResult = $null
try {
    $usernamePlain = Unprotect-Text ([string]$stored.usernameProtected)
    $passwordPlain = Unprotect-Text ([string]$stored.passwordProtected)
    if ($preferNative) {
        . (Join-Path $PSScriptRoot 'Plain-CredentialLoginAccessibility.ps1')
        $plainResult = Invoke-PlainCredentialLoginAccessibility `
            -Config $config -Origin $originKey -LoginUrl $loginUri.AbsoluteUri `
            -VerificationUrl $verificationUrl -Username $usernamePlain -Password $passwordPlain
        $plainJson = $plainResult | ConvertTo-Json -Compress -Depth 6
        $finalResult = [pscustomobject]@{
            exitCode = if ([string]$plainResult.status -eq 'logged_in') { 0 } else { 2 }
            stdout = $plainJson
            stderr = ''
        }
    }
    else {
        $primary = Invoke-CredentialProcess `
            (Join-Path $root 'src\credential-login.mjs') `
            @($originKey, $loginUri.AbsoluteUri, $verificationUrl) `
            $usernamePlain $passwordPlain
        $primaryStatus = Get-HelperStatus $primary.stdout
        if ($primary.exitCode -eq 0 -and $primaryStatus -eq 'logged_in') {
            $finalResult = $primary
        }
        elseif ($primaryStatus -notin @('unsupported', 'needs_attention', 'timeout', 'failed')) {
            $finalResult = $primary
        }
        else {
            $profilePath = [string]$config.automationUserDataDir
            $existing = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
                $_.CommandLine -like "*$profilePath*"
            })
            if ($existing.Count -gt 0) {
                $finalResult = [pscustomobject]@{ exitCode = 2; stdout = '{"status":"failed","diagnostic":"profile_busy"}'; stderr = '' }
            }
            else {
                . (Join-Path $PSScriptRoot 'Native-ChromeDebug.ps1')
                $nativeHelper = Join-Path $root 'src\native-credential-login.mjs'
                if (-not (Test-Path -LiteralPath $nativeHelper)) { throw '原生受保护登录助手不存在。' }
                [void](Reset-NativeChromeDebugPort $profilePath)
                $debugPort = Get-NativeChromeDebugPort
                & (Join-Path $PSScriptRoot 'Open-PlainLoginChrome.ps1') `
                    -Offscreen -RemoteDebuggingPort $debugPort -Urls @($loginUri.AbsoluteUri) | Out-Null
                $nativeChromeStarted = $true
                $debugPort = Wait-NativeChromeDebugPort $profilePath $debugPort 25
                $finalResult = Invoke-CredentialProcess $nativeHelper `
                    @([string]$debugPort, $originKey, $loginUri.AbsoluteUri, $verificationUrl) `
                    $usernamePlain $passwordPlain
            }
        }
    }
}
finally {
    if ($nativeChromeStarted) {
        $targets = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
            $_.CommandLine -like "*$([string]$config.automationUserDataDir)*"
        })
        $targetIds = @($targets.ProcessId)
        foreach ($processInfo in @($targets | Where-Object { $targetIds -notcontains $_.ParentProcessId })) {
            $chromeProcess = Get-Process -Id $processInfo.ProcessId -ErrorAction SilentlyContinue
            if ($chromeProcess) { [void]$chromeProcess.CloseMainWindow() }
        }
        Start-Sleep -Seconds 3
        Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
            $_.CommandLine -like "*$([string]$config.automationUserDataDir)*"
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $usernamePlain = $null
    $passwordPlain = $null
}

if ($finalResult.stdout) { Write-Output $finalResult.stdout }
else { Write-Output '{"status":"failed","diagnostic":"helper_failed"}' }
exit $finalResult.exitCode
