[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrivateRoot,
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$expectedProjectName = 'codex-bookmark-checkin'
$managedRoots = @('src', 'scripts', 'tests')
$managedFiles = @('config\defaults.json', 'requirements-ocr.txt')

function Get-CanonicalPath([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $volumeRoot = [System.IO.Path]::GetPathRoot($full)
    if (-not $full.Equals($volumeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        $full = $full.TrimEnd([char[]]@(
            [System.IO.Path]::DirectorySeparatorChar,
            [System.IO.Path]::AltDirectorySeparatorChar
        ))
    }
    return $full
}

function Test-SamePath([string]$Left, [string]$Right) {
    return (Get-CanonicalPath $Left).Equals(
        (Get-CanonicalPath $Right),
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

function Test-PathWithin([string]$Candidate, [string]$Parent) {
    $candidatePath = Get-CanonicalPath $Candidate
    $parentPath = Get-CanonicalPath $Parent
    if ($candidatePath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $prefix = $parentPath + [System.IO.Path]::DirectorySeparatorChar
    return $candidatePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparsePointInExistingPath([string]$Path, [string]$Label) {
    $full = Get-CanonicalPath $Path
    $current = [System.IO.Path]::GetPathRoot($full)
    $relative = $full.Substring($current.Length)
    foreach ($segment in @($relative -split '[\\/]' | Where-Object { $_ })) {
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { break }
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label contains a reparse point: $current"
        }
    }
}

function Assert-ProjectIdentity([string]$Root, [string]$Label) {
    $manifestPath = Join-Path $Root 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "$Label is missing package.json: $Root"
    }
    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "$Label package.json is invalid: $Root" }
    if ([string]$manifest.name -cne $expectedProjectName) {
        throw "$Label project identity mismatch: $Root"
    }
    foreach ($managedRoot in $managedRoots) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $managedRoot) -PathType Container)) {
            throw "$Label is missing managed root '$managedRoot': $Root"
        }
    }
}

function Get-SafeManagedFiles([string]$Root) {
    $files = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
    foreach ($managedRoot in $managedRoots) {
        $managedPath = Join-Path $Root $managedRoot
        $pendingDirectories = [System.Collections.Generic.Stack[string]]::new()
        $pendingDirectories.Push($managedPath)
        while ($pendingDirectories.Count -gt 0) {
            $directory = $pendingDirectories.Pop()
            foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
                if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Managed source contains a reparse point: $($item.FullName)"
                }
                if ($item.PSIsContainer) { $pendingDirectories.Push($item.FullName) }
                else { [void]$files.Add($item) }
            }
        }
    }
    foreach ($relativePath in $managedFiles) {
        $managedPath = Join-Path $Root $relativePath
        if (-not (Test-Path -LiteralPath $managedPath -PathType Leaf)) {
            throw "Managed source file is missing: $relativePath"
        }
        Assert-NoReparsePointInExistingPath $managedPath 'Managed source file'
        $item = Get-Item -LiteralPath $managedPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Managed source contains a reparse point: $($item.FullName)"
        }
        [void]$files.Add($item)
    }
    return $files
}

function Get-NormalizedTextHash([string]$Path) {
    $text = [System.IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF).Replace("`r`n", "`n")
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Copy-ManagedFileAtomically([string]$Source, [string]$Destination) {
    [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
    $temporary = "$Destination.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    $replaceBackup = "$Destination.$PID.$([guid]::NewGuid().ToString('N')).replace-backup"
    $replacementSucceeded = $false
    try {
        if ([System.IO.Path]::GetExtension($Destination).Equals('.ps1', [System.StringComparison]::OrdinalIgnoreCase)) {
            $content = [System.IO.File]::ReadAllText($Source).TrimStart([char]0xFEFF)
            [System.IO.File]::WriteAllText($temporary, $content, [System.Text.UTF8Encoding]::new($true))
        }
        else {
            [System.IO.File]::WriteAllBytes($temporary, [System.IO.File]::ReadAllBytes($Source))
        }
        if ([System.IO.File]::Exists($Destination)) {
            [System.IO.File]::Replace($temporary, $Destination, $replaceBackup, $true)
            $replacementSucceeded = $true
        }
        else {
            [System.IO.File]::Move($temporary, $Destination)
        }
    }
    finally {
        if ([System.IO.File]::Exists($temporary)) { [System.IO.File]::Delete($temporary) }
        if ($replacementSucceeded -and [System.IO.File]::Exists($replaceBackup)) {
            [System.IO.File]::Delete($replaceBackup)
        }
    }
}

$resolvedPublicRoot = Get-CanonicalPath (Split-Path -Parent $PSScriptRoot)
$resolvedPrivateRoot = Get-CanonicalPath $PrivateRoot
if (-not (Test-Path -LiteralPath $resolvedPrivateRoot -PathType Container)) {
    throw "Private runtime root is missing: $resolvedPrivateRoot"
}
if ((Test-SamePath $resolvedPrivateRoot $resolvedPublicRoot) `
    -or (Test-PathWithin $resolvedPrivateRoot $resolvedPublicRoot) `
    -or (Test-PathWithin $resolvedPublicRoot $resolvedPrivateRoot)) {
    throw 'Private runtime must be separate from and not contain the public source root'
}

Assert-NoReparsePointInExistingPath $resolvedPublicRoot 'Public source root'
Assert-NoReparsePointInExistingPath $resolvedPrivateRoot 'Private runtime root'
Assert-ProjectIdentity $resolvedPublicRoot 'Public source'
Assert-ProjectIdentity $resolvedPrivateRoot 'Private runtime'

$publicPrefix = $resolvedPublicRoot + [System.IO.Path]::DirectorySeparatorChar
$entries = @(
    foreach ($sourceFile in Get-SafeManagedFiles $resolvedPublicRoot) {
        if (-not $sourceFile.FullName.StartsWith($publicPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Managed source escaped the public root: $($sourceFile.FullName)"
        }
        $relative = $sourceFile.FullName.Substring($publicPrefix.Length)
        $destination = Get-CanonicalPath (Join-Path $resolvedPrivateRoot $relative)
        if (-not (Test-PathWithin $destination $resolvedPrivateRoot)) {
            throw "Managed destination escaped the private root: $relative"
        }
        Assert-NoReparsePointInExistingPath $destination 'Managed destination'
        $state = if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) { 'missing' }
        elseif ((Get-NormalizedTextHash $sourceFile.FullName) -ne (Get-NormalizedTextHash $destination)) { 'different' }
        else { 'same' }
        [pscustomobject]@{
            relativePath = $relative
            state = $state
            source = $sourceFile.FullName
            destination = $destination
        }
    }
)

$pending = @($entries | Where-Object { $_.state -ne 'same' })
$backupRoot = $null
if ($Apply -and $pending.Count -gt 0) {
    $backupRoot = Get-CanonicalPath (Join-Path $resolvedPrivateRoot "tmp\public-runtime-sync-backups\$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')")
    if (-not (Test-PathWithin $backupRoot $resolvedPrivateRoot)) { throw 'Backup root escaped the private runtime' }
    Assert-NoReparsePointInExistingPath $backupRoot 'Backup root'

    foreach ($entry in $pending) {
        if (Test-Path -LiteralPath $entry.destination -PathType Leaf) {
            $backup = Get-CanonicalPath (Join-Path $backupRoot $entry.relativePath)
            if (-not (Test-PathWithin $backup $backupRoot)) { throw "Backup destination escaped its root: $($entry.relativePath)" }
            [System.IO.Directory]::CreateDirectory((Split-Path -Parent $backup)) | Out-Null
            Copy-Item -LiteralPath $entry.destination -Destination $backup
        }
    }
    foreach ($entry in $pending) {
        Copy-ManagedFileAtomically $entry.source $entry.destination
    }
}

$result = [ordered]@{
    schemaVersion = 1
    source = $resolvedPublicRoot
    target = $resolvedPrivateRoot
    mode = if ($Apply) { 'apply' } else { 'dry_run' }
    managedFileCount = $entries.Count
    pendingCount = $pending.Count
    missingCount = @($pending | Where-Object { $_.state -eq 'missing' }).Count
    differentCount = @($pending | Where-Object { $_.state -eq 'different' }).Count
    changedPaths = @($pending | ForEach-Object { $_.relativePath })
    backupRoot = $backupRoot
}
$result | ConvertTo-Json -Depth 4
if (-not $Apply -and $pending.Count -gt 0) { exit 2 }
