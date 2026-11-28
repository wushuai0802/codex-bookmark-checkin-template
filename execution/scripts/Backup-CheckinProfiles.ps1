[CmdletBinding()]
param(
    [string]$BackupRoot,
    [string]$RuntimeRoot,
    [string]$ConfigPath,
    [string]$VerifyArchive,
    [ValidateRange(1, 30)]
    [int]$KeepDaily = 3,
    [ValidateRange(0, 24)]
    [int]$KeepMonthly = 1,
    [string]$TimestampLabel,
    [switch]$DryRun,
    [switch]$SkipRetention
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$excludedRelativeDirs = @(
    'Cache',
    'Cache_Data',
    'Code Cache',
    'GPUCache',
    'GrShaderCache',
    'GraphiteDawnCache',
    'DawnCache',
    'DawnGraphiteCache',
    'ShaderCache',
    'BrowserMetrics',
    'Crashpad',
    'OptGuideOnDeviceModel',
    'optimization_guide_model_store',
    'blob_storage',
    'component_crx_cache',
    'extensions_crx_cache',
    'Safe Browsing',
    'Service Worker\CacheStorage',
    'Service Worker\ScriptCache'
)

$pendingManualStates = @(
    'pending',
    'pending_verification',
    'waiting_for_user',
    'awaiting_user',
    'awaiting_manual_handoff',
    'waiting_login',
    'awaiting_login'
)

$reservedDeviceNames = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]@('CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'),
    [System.StringComparer]::OrdinalIgnoreCase
)

function Get-CanonicalPath([string]$PathValue) {
    $full = [System.IO.Path]::GetFullPath($PathValue)
    $driveRoot = [System.IO.Path]::GetPathRoot($full)
    if ($full.Equals($driveRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $full }
    return $full.TrimEnd('\', '/')
}

function Test-PathIsWithin([string]$CandidatePath, [string]$ParentPath) {
    $candidate = Get-CanonicalPath $CandidatePath
    $parent = Get-CanonicalPath $ParentPath
    if ($candidate.Equals($parent, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = $parent.TrimEnd('\', '/') + '\'
    return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NotDriveRoot([string]$PathValue, [string]$Label) {
    $full = [System.IO.Path]::GetFullPath($PathValue)
    $driveRoot = [System.IO.Path]::GetPathRoot($full)
    if ($full.TrimEnd('\').Equals($driveRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "安全检查失败：${Label}不能是磁盘根目录。"
    }
}

function Assert-NoReparsePointInPath([string]$PathValue, [string]$BoundaryPath) {
    $current = Get-CanonicalPath $PathValue
    $boundary = if ($BoundaryPath) { Get-CanonicalPath $BoundaryPath } else { $null }
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "安全检查失败：路径包含联接点或符号链接：$current"
            }
        }
        if ($boundary -and $current.Equals($boundary, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Get-CanonicalPath $parent
        if ($boundary -and -not (Test-PathIsWithin $current $boundary)) { break }
    }
}

function Assert-NotInsideGitRepo([string]$PathValue) {
    $current = Get-CanonicalPath $PathValue
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $current '.git')) {
            throw '安全检查失败：备份目标不能位于 Git 仓库目录内。'
        }
        $parent = [System.IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrEmpty($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Get-CanonicalPath $parent
    }
}

function Test-ProcessAlive([int]$ProcessId) {
    if ($ProcessId -le 0) { return $false }
    try {
        $null = Get-Process -Id $ProcessId -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-ChromeProcessUsesProfile {
    param([string]$CommandLine, [string]$ProfilePath)
    if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($ProfilePath)) { return $false }
    $normalized = $ProfilePath.TrimEnd('\', '/')
    if ($CommandLine.Trim().Trim('"').TrimEnd('\', '/') -ieq $normalized) { return $true }
    $escaped = [regex]::Escape($normalized)
    return $CommandLine -match "(?i)(?:^|\s)--user-data-dir=(?:`"$escaped[\\/]?`"|$escaped[\\/]?(?=\s|$))"
}

function Assert-NoRunningChromeForProfiles([string[]]$ProfilePaths) {
    $chromeProcesses = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue)
    foreach ($profilePath in $ProfilePaths) {
        $busy = @($chromeProcesses | Where-Object { Test-ChromeProcessUsesProfile $_.CommandLine $profilePath })
        if ($busy.Count -gt 0) {
            throw '安全检查失败：检测到机器人 Chrome 正在使用目标 Profile，拒绝热备份。'
        }
    }
}

function Assert-NoActiveRunOrManualSession([string]$RootPath, [string]$OwnLockNonce = '') {
    $runLockPath = Join-Path $RootPath 'tmp\run.lock'
    if (Test-Path -LiteralPath $runLockPath -PathType Leaf) {
        $lockObj = $null
        try {
            $lockObj = Get-Content -Raw -Encoding UTF8 -LiteralPath $runLockPath | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw '安全检查失败：检测到不可解析的 run.lock，拒绝热备份 Chrome Profile。'
        }
        $isSelf = (-not [string]::IsNullOrEmpty($OwnLockNonce)) -and ([int]$lockObj.pid -eq $PID) -and ([string]$lockObj.nonce -eq $OwnLockNonce)
        if (-not $isSelf) {
            $lockPid = 0
            if ($null -ne $lockObj.pid -and [int]::TryParse([string]$lockObj.pid, [ref]$lockPid) -and (Test-ProcessAlive $lockPid)) {
                throw "安全检查失败：执行锁 run.lock 正被活跃进程占用（PID=$lockPid），拒绝热备份 Chrome Profile。"
            }
        }
    }

    foreach ($rel in @('tmp\manual-handoff.json', 'tmp\manual-verification.json', 'tmp\manual-session.json')) {
        $statePath = Join-Path $RootPath $rel
        if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { continue }
        $stateObj = $null
        try {
            $stateObj = Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "安全检查失败：人工会话状态文件不可解析（$rel），拒绝热备份 Chrome Profile。"
        }
        if ($pendingManualStates -contains [string]$stateObj.state) {
            throw "安全检查失败：存在待处理人工会话（$rel），拒绝热备份 Chrome Profile。"
        }
        $sessionPid = 0
        if ($null -ne $stateObj.pid -and [int]::TryParse([string]$stateObj.pid, [ref]$sessionPid) -and (Test-ProcessAlive $sessionPid)) {
            throw "安全检查失败：人工会话进程仍在运行（$rel，PID=$sessionPid），拒绝热备份 Chrome Profile。"
        }
    }
}

function Assert-IdleWindow([string]$RootPath, [string[]]$ProfilePaths, [string]$OwnLockNonce = '') {
    Assert-NoActiveRunOrManualSession $RootPath $OwnLockNonce
    Assert-NoRunningChromeForProfiles $ProfilePaths
}

function Acquire-BackupRunLock([string]$RootPath) {
    $tmpDir = Join-Path $RootPath 'tmp'
    if (-not (Test-Path -LiteralPath $tmpDir)) {
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    }
    $runLockPath = Join-Path $tmpDir 'run.lock'
    $nonce = [guid]::NewGuid().ToString('N')
    $nowIso = [datetimeoffset]::UtcNow.ToString('o')
    $procStartIso = try { (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { $nowIso }
    $payload = ([ordered]@{
        pid              = $PID
        nonce            = $nonce
        kind             = 'profile_backup'
        startedAt        = $nowIso
        processStartedAt = $procStartIso
    } | ConvertTo-Json -Compress)
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($payload)

    try {
        $stream = [System.IO.File]::Open($runLockPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $stream.Write($bytes, 0, $bytes.Length)
        } finally {
            $stream.Dispose()
        }
    } catch [System.IO.IOException] {
        # Re-check whether an active or stale lock exists; never steal an active or unreadable lock.
        Assert-NoActiveRunOrManualSession $RootPath
        throw '安全检查失败：发现残留 run.lock 文件，请先确认并清理后再执行备份。'
    }
    return [pscustomobject]@{
        path  = $runLockPath
        nonce = $nonce
    }
}

function Release-BackupRunLock([object]$LockHandle) {
    if ($null -eq $LockHandle -or [string]::IsNullOrWhiteSpace([string]$LockHandle.path)) { return }
    if (-not (Test-Path -LiteralPath $LockHandle.path -PathType Leaf)) { return }
    try {
        $owner = Get-Content -Raw -Encoding UTF8 -LiteralPath $LockHandle.path | ConvertFrom-Json -ErrorAction Stop
        if ([int]$owner.pid -eq $PID -and [string]$owner.nonce -eq [string]$LockHandle.nonce) {
            Remove-Item -LiteralPath $LockHandle.path -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

function Get-Sha256Hex([string]$FilePath) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $stream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
        try {
            $hashBytes = $sha.ComputeHash($stream)
            return ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
        } finally {
            $stream.Dispose()
        }
    } finally {
        $sha.Dispose()
    }
}

function Get-StringSha256Prefix([string]$Text, [int]$Length = 8) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text.ToLowerInvariant())
        $hex = ([System.BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
        return $hex.Substring(0, $Length)
    } finally {
        $sha.Dispose()
    }
}

function Test-IsExcludedRelativePath([string]$RelativePath) {
    $normalized = $RelativePath.Replace('/', '\').TrimStart('\')
    if ([string]::IsNullOrWhiteSpace($normalized)) { return $false }
    $parts = $normalized.Split('\')
    foreach ($pattern in $excludedRelativeDirs) {
        if ($normalized.Equals($pattern, [System.StringComparison]::OrdinalIgnoreCase) -or
            $normalized.StartsWith("$pattern\", [System.StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
        if ($parts.Length -ge 2 -and ($parts[0] -ieq 'Default' -or $parts[0] -match '^Profile \d+$')) {
            $subRelative = ($parts[1..($parts.Length - 1)] -join '\')
            if ($subRelative.Equals($pattern, [System.StringComparison]::OrdinalIgnoreCase) -or
                $subRelative.StartsWith("$pattern\", [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
    }
    return $false
}

function Write-AtomicUtf8File([string]$TargetPath, [string]$Content) {
    $parent = Split-Path -Parent $TargetPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $tempPath = "$TargetPath.$([guid]::NewGuid().ToString('N')).tmp"
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    try {
        [System.IO.File]::WriteAllText($tempPath, $Content, $utf8NoBom)
        Move-Item -LiteralPath $tempPath -Destination $TargetPath -Force
    } finally {
        if (Test-Path -LiteralPath $tempPath) {
            Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-DiscoveredProfiles([string]$RootPath, [string]$EffectiveConfigPath) {
    $allowedDataRoot = Get-CanonicalPath (Join-Path $RootPath 'data')
    if (-not (Test-Path -LiteralPath $allowedDataRoot -PathType Container)) {
        throw '未找到运行副本 data 目录，无法发现 Chrome Profile。'
    }
    Assert-NoReparsePointInPath $allowedDataRoot $RootPath

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($EffectiveConfigPath -and (Test-Path -LiteralPath $EffectiveConfigPath -PathType Leaf)) {
        $configObj = Get-Content -Raw -Encoding UTF8 -LiteralPath $EffectiveConfigPath | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$configObj.automationUserDataDir)) {
            $configured = Get-CanonicalPath ([string]$configObj.automationUserDataDir)
            if (-not (Test-PathIsWithin $configured $allowedDataRoot)) {
                throw '安全检查失败：config.json 中的 automationUserDataDir 不在项目 data 目录内。'
            }
            if (Test-Path -LiteralPath (Join-Path $configured 'Local State') -PathType Leaf) {
                $candidates.Add($configured)
            }
        }
    }

    $mainCandidate = Get-CanonicalPath (Join-Path $allowedDataRoot 'chrome-user-data')
    if (Test-Path -LiteralPath (Join-Path $mainCandidate 'Local State') -PathType Leaf) {
        $candidates.Add($mainCandidate)
    }

    foreach ($group in @('accounts', 'sessions', 'sites')) {
        $groupRoot = Join-Path $allowedDataRoot $group
        if (-not (Test-Path -LiteralPath $groupRoot -PathType Container)) { continue }
        Assert-NoReparsePointInPath $groupRoot $allowedDataRoot
        foreach ($entry in @(Get-ChildItem -LiteralPath $groupRoot -Directory -Force -ErrorAction Stop)) {
            if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "安全检查失败：Profile 分组包含联接点或符号链接：$($entry.FullName)"
            }
            $candidate = Get-CanonicalPath (Join-Path $entry.FullName 'chrome-user-data')
            if (Test-Path -LiteralPath (Join-Path $candidate 'Local State') -PathType Leaf) {
                if (-not (Test-PathIsWithin $candidate $allowedDataRoot)) {
                    throw "安全检查失败：发现越界 Profile 路径：$candidate"
                }
                $candidates.Add($candidate)
            }
        }
    }

    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $uniquePaths = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in $candidates) {
        if ($seen.Add($candidate)) {
            Assert-NoReparsePointInPath $candidate $allowedDataRoot
            $uniquePaths.Add($candidate)
        }
    }
    $uniquePaths.Sort([System.StringComparer]::OrdinalIgnoreCase)

    $results = [System.Collections.Generic.List[object]]::new()
    $index = 0
    foreach ($fullPath in $uniquePaths) {
        $index++
        $relative = $fullPath.Substring($allowedDataRoot.Length).TrimStart('\')
        $firstSegment = $relative.Split('\')[0].ToLowerInvariant()
        $category = if ($firstSegment -in @('accounts', 'sessions', 'sites')) { $firstSegment } else { 'main' }
        $hashPrefix = Get-StringSha256Prefix $relative 8
        $id = ('profile-{0:D2}-{1}' -f $index, $hashPrefix)
        $results.Add([pscustomobject]@{
            id           = $id
            category     = $category
            fullPath     = $fullPath
            relativePath = $relative
            archiveFile  = "$id.zip"
        })
    }
    return @($results)
}

function Collect-ProfileFiles([string]$ProfileFullPath) {
    $files = [System.Collections.Generic.List[object]]::new()
    $stack = [System.Collections.Generic.Stack[string]]::new()
    $stack.Push($ProfileFullPath)
    while ($stack.Count -gt 0) {
        $currentDir = $stack.Pop()
        $dirItem = Get-Item -LiteralPath $currentDir -Force
        if (($dirItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "安全检查失败：Profile 目录内包含联接点或符号链接：$currentDir"
        }
        foreach ($child in @(Get-ChildItem -LiteralPath $currentDir -Force -ErrorAction Stop)) {
            if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "安全检查失败：Profile 目录内包含联接点或符号链接：$($child.FullName)"
            }
            $relative = $child.FullName.Substring($ProfileFullPath.Length).TrimStart('\')
            if (Test-IsExcludedRelativePath $relative) { continue }
            if ($child.PSIsContainer) {
                $stack.Push($child.FullName)
            } else {
                $files.Add([pscustomobject]@{
                    fullPath     = $child.FullName
                    relativePath = $relative
                    length       = [int64]$child.Length
                })
            }
        }
    }
    return @($files)
}

function Write-ProfileZip([string]$ProfileFullPath, [string]$DestinationZipPath, [object[]]$FileEntries) {
    $zip = [System.IO.Compression.ZipFile]::Open($DestinationZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($fileEntry in $FileEntries) {
            $entryName = $fileEntry.relativePath.Replace('\', '/')
            $zipEntry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Fastest)
            $destStream = $zipEntry.Open()
            try {
                $sourceStream = [System.IO.File]::Open(
                    $fileEntry.fullPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::Read
                )
                try {
                    $sourceStream.CopyTo($destStream)
                } finally {
                    $sourceStream.Dispose()
                }
            } finally {
                $destStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
    }
}

function Assert-SafeZipEntryName([string]$EntryFullName, [string]$ArchiveFile) {
    if ([string]::IsNullOrWhiteSpace($EntryFullName)) {
        throw "离线恢复校验失败：归档包含空条目路径（$ArchiveFile）。"
    }
    if ($EntryFullName -match '^[\\/]|^[A-Za-z]:|:') {
        throw "离线恢复校验失败：归档包含绝对路径或 NTFS ADS（$ArchiveFile）。"
    }
    $normalized = $EntryFullName.Replace('\', '/')
    $segments = $normalized.Split('/')
    foreach ($segment in $segments) {
        if ($segment -eq '' -or $segment -eq '.' -or $segment -eq '..') {
            throw "离线恢复校验失败：归档包含非法路径段（$ArchiveFile）。"
        }
        $baseName = $segment.Split('.')[0]
        if ($reservedDeviceNames.Contains($baseName)) {
            throw "离线恢复校验失败：归档包含保留设备名（$ArchiveFile）。"
        }
    }
    return $normalized
}

function Invoke-VerifyBackupArchive([string]$TargetPath) {
    $resolved = Get-CanonicalPath $TargetPath
    $manifestPath = if (Test-Path -LiteralPath $resolved -PathType Container) {
        Join-Path $resolved 'manifest.json'
    } else {
        $resolved
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "离线恢复校验失败：未找到备份清单 $manifestPath"
    }
    $archiveDir = Get-CanonicalPath (Split-Path -Parent $manifestPath)
    $manifestInfo = Get-Item -LiteralPath $manifestPath -Force
    if ($manifestInfo.Length -gt 5MB) {
        throw '离线恢复校验失败：manifest.json 体积超过安全上限。'
    }
    $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json -ErrorAction Stop
    if ([int]$manifest.schemaVersion -ne 1 -or [string]$manifest.kind -ne 'chrome_profile_backup' -or $null -eq $manifest.profiles) {
        throw '离线恢复校验失败：manifest.json 结构无效。'
    }
    $profiles = @($manifest.profiles)
    if ($profiles.Count -le 0 -or $profiles.Count -ne [int]$manifest.profileCount) {
        throw '离线恢复校验失败：manifest.json 中的 Profile 数量不一致。'
    }

    $verifiedCount = 0
    $totalVerifiedFiles = 0
    $seenIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($entry in $profiles) {
        $entryId = [string]$entry.id
        if ($entryId -notmatch '^[A-Za-z0-9_-]{1,64}$' -or -not $seenIds.Add($entryId)) {
            throw "离线恢复校验失败：清单中的 Profile ID 非法或重复：$entryId"
        }
        $archiveFile = [string]$entry.archiveFile
        if ($archiveFile -notmatch '^[A-Za-z0-9_.-]+\.zip$' -or $archiveFile -match '\.\.') {
            throw "离线恢复校验失败：清单中的归档文件名非法：$archiveFile"
        }
        $zipPath = Get-CanonicalPath (Join-Path $archiveDir $archiveFile)
        if (-not (Test-PathIsWithin $zipPath $archiveDir)) {
            throw "离线恢复校验失败：归档路径越界：$archiveFile"
        }
        if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
            throw "离线恢复校验失败：缺少归档文件 $archiveFile"
        }
        $actualHash = Get-Sha256Hex $zipPath
        if (-not $actualHash.Equals([string]$entry.sha256, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "离线恢复校验失败：归档文件 SHA-256 校验不匹配（$archiveFile）。"
        }

        # Streaming zero-disk-write verification: decompresses every entry to verify
        # deflate/CRC32 integrity and Local State presence without writing plaintext cookies to %TEMP%.
        $verifiedFiles = 0
        $localStateBytes = [int64]0
        $foundLocalState = $false
        $seenEntries = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        $buffer = New-Object byte[] 65536
        $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
        try {
            foreach ($zipEntry in $zip.Entries) {
                if ([string]::IsNullOrEmpty($zipEntry.Name) -and $zipEntry.FullName.EndsWith('/')) { continue }
                $normalizedEntry = Assert-SafeZipEntryName $zipEntry.FullName $archiveFile
                if (-not $seenEntries.Add($normalizedEntry)) {
                    throw "离线恢复校验失败：归档包含重复条目（$archiveFile）。"
                }
                $entryBytes = [int64]0
                $inStream = $zipEntry.Open()
                try {
                    while (($read = $inStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        $entryBytes += $read
                    }
                } finally {
                    $inStream.Dispose()
                }
                if ($normalizedEntry.Equals('Local State', [System.StringComparison]::OrdinalIgnoreCase)) {
                    $foundLocalState = $true
                    $localStateBytes = $entryBytes
                }
                $verifiedFiles++
            }
        } finally {
            $zip.Dispose()
        }

        if ($verifiedFiles -ne [int]$entry.fileCount) {
            throw "离线恢复校验失败：归档文件数与清单不符（$archiveFile：期望 $($entry.fileCount)，实际 $verifiedFiles）。"
        }
        if (-not $foundLocalState -or $localStateBytes -le 0) {
            throw "离线恢复校验失败：归档缺少有效 Local State（$archiveFile）。"
        }

        $verifiedCount++
        $totalVerifiedFiles += $verifiedFiles
    }

    return [pscustomobject]@{
        ok                  = $true
        mode                = 'verify'
        archiveName         = Split-Path -Leaf $archiveDir
        manifestPath        = $manifestPath
        verifiedProfiles    = $verifiedCount
        totalExtractedFiles = $totalVerifiedFiles
        verifiedAt          = [datetimeoffset]::UtcNow.ToString('o')
    }
}

function Invoke-BackupRetention([string]$TargetBackupRoot, [int]$DailyLimit, [int]$MonthlyLimit, [string]$ProtectArchiveName) {
    $canonicalBackupRoot = Get-CanonicalPath $TargetBackupRoot
    $validDirs = [System.Collections.Generic.List[object]]::new()
    foreach ($dir in @(Get-ChildItem -LiteralPath $canonicalBackupRoot -Directory -Force -ErrorAction SilentlyContinue)) {
        if (($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if ($dir.Name -notmatch '^profiles-(\d{4})(\d{2})\d{2}-\d{6}(?:-\d{3})?$') { continue }
        if (-not (Test-PathIsWithin $dir.FullName $canonicalBackupRoot)) { continue }
        $manifestFile = Join-Path $dir.FullName 'manifest.json'
        if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { continue }
        try {
            $m = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestFile | ConvertFrom-Json -ErrorAction Stop
            if ([int]$m.schemaVersion -ne 1 -or [string]$m.kind -ne 'chrome_profile_backup') { continue }
            # Only verified backups occupy retention slots so an unverified/broken backup never evicts a valid one.
            if ([string]::IsNullOrWhiteSpace([string]$m.verifiedAt)) { continue }
            $null = [datetimeoffset]::Parse([string]$m.verifiedAt)
        } catch {
            continue
        }
        $validDirs.Add([pscustomobject]@{
            name     = $dir.Name
            fullPath = $dir.FullName
            monthKey = "$($Matches[1])-$($Matches[2])"
        })
    }

    $ordered = @($validDirs | Sort-Object -Property name -Descending)
    $keepNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    if ($ProtectArchiveName) { $null = $keepNames.Add($ProtectArchiveName) }

    $dailyKept = 0
    $coveredMonths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($item in $ordered) {
        if ($dailyKept -lt $DailyLimit) {
            $null = $keepNames.Add($item.name)
            $null = $coveredMonths.Add($item.monthKey)
            $dailyKept++
        }
    }

    $monthlyKept = 0
    foreach ($item in $ordered) {
        if ($monthlyKept -ge $MonthlyLimit) { break }
        if ($keepNames.Contains($item.name)) { continue }
        if ($coveredMonths.Contains($item.monthKey)) { continue }
        $null = $keepNames.Add($item.name)
        $null = $coveredMonths.Add($item.monthKey)
        $monthlyKept++
    }

    $pruned = [System.Collections.Generic.List[string]]::new()
    foreach ($item in $ordered) {
        if ($keepNames.Contains($item.name)) { continue }
        $targetItem = Get-Item -LiteralPath $item.fullPath -Force
        if (($targetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        if (-not (Test-PathIsWithin $item.fullPath $canonicalBackupRoot)) { continue }
        Remove-Item -LiteralPath $item.fullPath -Recurse -Force
        $pruned.Add($item.name)
    }

    return [pscustomobject]@{
        retainedCount = $keepNames.Count
        prunedCount   = $pruned.Count
        prunedNames   = @($pruned)
    }
}

if (-not [string]::IsNullOrWhiteSpace($VerifyArchive)) {
    $verifyResult = Invoke-VerifyBackupArchive $VerifyArchive
    $verifyResult | ConvertTo-Json -Depth 5
    exit 0
}

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    throw '缺少必需参数：请指定 -BackupRoot 或 -VerifyArchive。'
}

$root = if ($RuntimeRoot) { Get-CanonicalPath $RuntimeRoot } else { Get-CanonicalPath (Split-Path -Parent $PSScriptRoot) }
$effectiveConfigPath = if ($ConfigPath) { Get-CanonicalPath $ConfigPath } else { Join-Path $root 'config\config.json' }
$resolvedBackupRoot = Get-CanonicalPath $BackupRoot

Assert-NotDriveRoot $root '运行根目录'
Assert-NotDriveRoot $resolvedBackupRoot '备份目标目录'
if (Test-PathIsWithin $resolvedBackupRoot $root) {
    throw '安全检查失败：备份目标不能位于运行副本目录内。'
}
Assert-NotInsideGitRepo $resolvedBackupRoot
Assert-NoReparsePointInPath $resolvedBackupRoot $null

$profiles = Get-DiscoveredProfiles $root $effectiveConfigPath
if ($profiles.Count -eq 0) {
    throw '未在 data 目录发现任何有效 Chrome Profile（缺少 Local State）。'
}

$profilePaths = @($profiles | ForEach-Object { $_.fullPath })
$backupMutexName = 'Local\CheckinProfileBackup-' + (Get-StringSha256Prefix $root 12)
$backupMutex = [System.Threading.Mutex]::new($false, $backupMutexName)
$mutexAcquired = $false
$runLockHandle = $null

try {
    try {
        $mutexAcquired = $backupMutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $mutexAcquired = $true
    }
    if (-not $mutexAcquired) {
        throw '安全检查失败：已有另一个 Profile 备份实例正在运行。'
    }

    Assert-IdleWindow $root $profilePaths

    if (-not $DryRun) {
        $runLockHandle = Acquire-BackupRunLock $root
        Assert-NoRunningChromeForProfiles $profilePaths
    }

    $collected = [System.Collections.Generic.List[object]]::new()
    $totalSourceBytes = [int64]0
    $totalFileCount = 0
    foreach ($profile in $profiles) {
        $files = Collect-ProfileFiles $profile.fullPath
        $bytes = [int64](($files | Measure-Object -Property length -Sum).Sum)
        $totalSourceBytes += $bytes
        $totalFileCount += $files.Count
        $collected.Add([pscustomobject]@{
            profile = $profile
            files   = $files
            bytes   = $bytes
        })
    }

    if ($DryRun) {
        [pscustomobject]@{
            ok               = $true
            mode             = 'dry_run'
            profileCount     = $profiles.Count
            totalFileCount   = $totalFileCount
            totalSourceBytes = $totalSourceBytes
            categories       = @($profiles | Group-Object category | ForEach-Object { [pscustomobject]@{ category = $_.Name; count = $_.Count } })
        } | ConvertTo-Json -Depth 5
        exit 0
    }

    if (-not [string]::IsNullOrWhiteSpace($TimestampLabel)) {
        if ($TimestampLabel -notmatch '^\d{8}-\d{6}(?:-\d{3})?$') {
            throw '参数错误：TimestampLabel 必须符合 yyyyMMdd-HHmmss 格式。'
        }
        $label = $TimestampLabel
    } else {
        $label = [datetime]::Now.ToString('yyyyMMdd-HHmmss')
    }

    New-Item -ItemType Directory -Path $resolvedBackupRoot -Force | Out-Null
    $archiveName = "profiles-$label"
    $finalArchiveDir = Join-Path $resolvedBackupRoot $archiveName
    if (Test-Path -LiteralPath $finalArchiveDir) {
        $archiveName = "profiles-$label-$([datetime]::Now.ToString('fff'))"
        $finalArchiveDir = Join-Path $resolvedBackupRoot $archiveName
        if (Test-Path -LiteralPath $finalArchiveDir) {
            throw "备份目标目录已存在：$archiveName"
        }
    }

    $stagingDir = Join-Path $resolvedBackupRoot ".staging-$archiveName-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

    $promoted = $false
    try {
        $manifestProfiles = [System.Collections.Generic.List[object]]::new()
        $totalArchiveBytes = [int64]0

        foreach ($item in $collected) {
            $profile = $item.profile
            $zipPath = Join-Path $stagingDir $profile.archiveFile
            Write-ProfileZip $profile.fullPath $zipPath $item.files
            $zipInfo = Get-Item -LiteralPath $zipPath -Force
            $zipHash = Get-Sha256Hex $zipPath
            $totalArchiveBytes += [int64]$zipInfo.Length
            $manifestProfiles.Add([pscustomobject]@{
                id           = $profile.id
                category     = $profile.category
                relativePath = $profile.relativePath
                archiveFile  = $profile.archiveFile
                fileCount    = $item.files.Count
                sourceBytes  = $item.bytes
                archiveBytes = [int64]$zipInfo.Length
                sha256       = $zipHash
            })
        }

        # Re-verify no Chrome or manual session started mid-packaging before verifying and promoting.
        Assert-IdleWindow $root $profilePaths $runLockHandle.nonce

        $createdAt = [datetimeoffset]::UtcNow.ToString('o')
        $manifestObj = [ordered]@{
            schemaVersion     = 1
            kind              = 'chrome_profile_backup'
            archiveName       = $archiveName
            createdAt         = $createdAt
            verifiedAt        = $null
            profileCount      = $manifestProfiles.Count
            totalFileCount    = $totalFileCount
            totalSourceBytes  = $totalSourceBytes
            totalArchiveBytes = $totalArchiveBytes
            profiles          = @($manifestProfiles)
        }
        $stagingManifestPath = Join-Path $stagingDir 'manifest.json'
        Write-AtomicUtf8File $stagingManifestPath ($manifestObj | ConvertTo-Json -Depth 6)

        # Verify inside staging before promoting to final profiles-* directory so an unverified archive never lands.
        $verification = Invoke-VerifyBackupArchive $stagingManifestPath
        $manifestObj.verifiedAt = $verification.verifiedAt
        Write-AtomicUtf8File $stagingManifestPath ($manifestObj | ConvertTo-Json -Depth 6)

        Move-Item -LiteralPath $stagingDir -Destination $finalArchiveDir
        $promoted = $true
    } finally {
        if (-not $promoted -and (Test-Path -LiteralPath $stagingDir)) {
            Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    $finalManifestPath = Join-Path $finalArchiveDir 'manifest.json'
    $retention = if ($SkipRetention) {
        [pscustomobject]@{ retainedCount = $null; prunedCount = 0; prunedNames = @() }
    } else {
        Invoke-BackupRetention $resolvedBackupRoot $KeepDaily $KeepMonthly $archiveName
    }

    [pscustomobject]@{
        ok                = $true
        mode              = 'backup'
        archiveName       = $archiveName
        manifestPath      = $finalManifestPath
        createdAt         = $manifestObj.createdAt
        verifiedAt        = $manifestObj.verifiedAt
        profileCount      = $manifestObj.profileCount
        totalFileCount    = $totalFileCount
        totalSourceBytes  = $totalSourceBytes
        totalArchiveBytes = $totalArchiveBytes
        retainedCount     = $retention.retainedCount
        prunedCount       = $retention.prunedCount
    } | ConvertTo-Json -Depth 5
} finally {
    Release-BackupRunLock $runLockHandle
    if ($mutexAcquired) { $backupMutex.ReleaseMutex() }
    $backupMutex.Dispose()
}
