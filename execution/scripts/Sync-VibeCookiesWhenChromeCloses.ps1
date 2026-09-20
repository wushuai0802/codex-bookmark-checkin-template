[CmdletBinding()]
param(
    [datetime]$Deadline = (Get-Date).Date.AddDays(1).AddHours(7).AddMinutes(55)
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$statePath = Join-Path $root 'data\vibe-cookie-sync-state.json'
$sourceRoot = [string]$config.sourceUserDataDir
$sourceProfile = Join-Path $sourceRoot ([string]$config.sourceProfileDirectory)
$targetRoot = [string]$config.automationUserDataDir
$sessionHelper = Join-Path $PSScriptRoot 'Sync-ChromeSiteSession.mjs'
$sessionExtractor = Join-Path $PSScriptRoot 'Extract-ChromeSessionStorage.mjs'
$chromeExecutable = [string]$config.chromeExecutable
$sessionStoragePath = Join-Path $root 'data\vibe-session-storage.json'

function Write-State([string]$status, [string]$message = '') {
    $value = [ordered]@{
        status = $status
        message = $message
        updatedAt = (Get-Date).ToString('o')
        deadline = $Deadline.ToString('o')
    } | ConvertTo-Json
    $temporary = "$statePath.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, $value, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

foreach ($required in @($sessionHelper, $sessionExtractor, $chromeExecutable, (Join-Path $sourceRoot 'Local State'), (Join-Path $targetRoot 'Local State'))) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Cookie 同步所需文件不存在：$required" }
}

$sourceState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $sourceRoot 'Local State') | ConvertFrom-Json
$targetState = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $targetRoot 'Local State') | ConvertFrom-Json
if (-not $sourceState.os_crypt.encrypted_key -or $sourceState.os_crypt.encrypted_key -ne $targetState.os_crypt.encrypted_key) {
    throw '源 Chrome 与机器人配置的加密主密钥不一致，拒绝同步 Cookie。'
}

Write-State 'waiting' '等待 Chrome 正常退出后同步 Vibe Code Cookie。'
while ((Get-Date) -lt $Deadline) {
    $chrome = @(Get-Process chrome -ErrorAction SilentlyContinue)
    if ($chrome.Count -eq 0) {
        $shadowRoot = Join-Path $root "tmp\vibe-source-shadow-$PID"
        $resolvedTmpRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'tmp'))
        $resolvedShadowRoot = [System.IO.Path]::GetFullPath($shadowRoot)
        if (-not $resolvedShadowRoot.StartsWith("$resolvedTmpRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw '临时会话目录不在任务 tmp 目录内，拒绝继续。'
        }
        try {
            New-Item -ItemType Directory -Path (Join-Path $shadowRoot 'Default\Network') -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $sourceRoot 'Local State') -Destination (Join-Path $shadowRoot 'Local State') -Force
            foreach ($relative in @('Preferences', 'Secure Preferences')) {
                $sourceItem = Join-Path $sourceProfile $relative
                if (Test-Path -LiteralPath $sourceItem) {
                    Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $shadowRoot "Default\$relative") -Force
                }
            }
            foreach ($relative in @('Login Data', 'Login Data For Account', 'Web Data', 'Account Web Data', 'Affiliation Database')) {
                $sourceItem = Join-Path $sourceProfile $relative
                if (Test-Path -LiteralPath $sourceItem) {
                    Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $shadowRoot "Default\$relative") -Force
                }
            }
            foreach ($relative in @('Local Storage', 'Session Storage', 'Sessions', 'Accounts', 'Sync Data')) {
                $sourceItem = Join-Path $sourceProfile $relative
                if (Test-Path -LiteralPath $sourceItem) {
                    Copy-Item -LiteralPath $sourceItem -Destination (Join-Path $shadowRoot "Default\$relative") -Recurse -Force
                }
            }
            $sourceCookies = Join-Path $sourceProfile 'Network\Cookies'
            if (Test-Path -LiteralPath $sourceCookies) {
                Copy-Item -LiteralPath $sourceCookies -Destination (Join-Path $shadowRoot 'Default\Network\Cookies') -Force
            }

            $sessionDatabase = Join-Path $shadowRoot 'Default\Session Storage'
            $extractionResultText = & node $sessionExtractor $sessionDatabase 'https://new.sharedchat.cc' $sessionStoragePath
            if ($LASTEXITCODE -ne 0) { throw "Vibe Code 会话数据库提取失败，退出码 $LASTEXITCODE。" }
            $extractionResult = $extractionResultText | ConvertFrom-Json

            $sessionResultText = & node $sessionHelper $shadowRoot $targetRoot 'https://new.sharedchat.cc' $chromeExecutable $sessionStoragePath
            if ($LASTEXITCODE -ne 0) { throw "Vibe Code 站点会话同步失败，退出码 $LASTEXITCODE。" }
            $sessionResult = $sessionResultText | ConvertFrom-Json
            if ($sessionResult.sourceLoginRoute -or -not $sessionResult.sourceHasBenefitUi) {
                throw '源 Chrome 的 Vibe Code 会话仍未登录，拒绝覆盖机器人会话。'
            }
            if ($sessionResult.targetLoginRoute -or -not $sessionResult.targetHasBenefitUi) {
                throw 'Vibe Code 会话转移后仍未登录，拒绝报告同步成功。'
            }
            if ([int]$sessionResult.copiedLocalStorageEntries -lt 1 -and [int]$sessionResult.copiedCookies -lt 1) {
                throw '源 Chrome 中没有找到 Vibe Code 的有效会话数据。'
            }
            $sourceState = if ($sessionResult.sourceLoginRoute) { '源会话仍在登录页' } elseif ($sessionResult.sourceHasBenefitUi) { '源会话已登录' } else { '源会话状态未确认' }
            $targetState = if ($sessionResult.targetLoginRoute) { '目标会话仍在登录页' } elseif ($sessionResult.targetHasBenefitUi) { '目标会话已登录' } else { '目标会话状态未确认' }
            Write-State 'completed' "已验证并同步 Vibe Code 会话（Cookie $([int]$sessionResult.copiedCookies) 条，本地存储 $([int]$sessionResult.copiedLocalStorageEntries) 项，会话数据库 $([int]$extractionResult.entryCount) 项；$sourceState，$targetState）。"
            exit 0
        }
        catch {
            $message = ([string]$_.Exception.Message) -replace '[\r\n\t]+', ' '
            if ($message.Length -gt 240) { $message = $message.Substring(0, 240) }
            Write-State 'failed' $message
            throw
        }
        finally {
            if (Test-Path -LiteralPath $resolvedShadowRoot) {
                Remove-Item -LiteralPath $resolvedShadowRoot -Recurse -Force
            }
        }
    }
    Start-Sleep -Seconds 30
}

Write-State 'expired' '截至截止时间 Chrome 仍未完全退出，未同步 Cookie。'
exit 2
