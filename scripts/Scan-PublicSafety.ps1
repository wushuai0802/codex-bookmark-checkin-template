[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$git = Get-Command git -ErrorAction SilentlyContinue

if ($git -and (Test-Path -LiteralPath (Join-Path $root '.git'))) {
    # Scan both committed files and new, non-ignored files so a pre-commit
    # safety check cannot miss a secret introduced in an untracked file.
    $relativeFiles = @(& $git.Source -C $root ls-files --cached --others --exclude-standard)
}
else {
    $relativeFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        $_.FullName.Substring($root.Length + 1).Replace('\', '/')
    } | Where-Object {
        $_ -notmatch '^(node_modules|data|logs|tmp|outputs|work|inputs|downloads|\.git|\.venv|venv|\.pytest_cache)(/|$)' -and
        $_ -notmatch '(^|/)(__pycache__|\.pytest_cache)(/|$)' -and
        $_ -notmatch '(^|/)\.env(/|$)' -and
        $_ -notmatch '^(progress\.md|requirements-ocr\.txt|pnpm-lock\.yaml|eng\.traineddata)$' -and
        $_ -notmatch '^scripts/(Install-CaptchaOcr\.ps1|Invoke-CheckinReportOutbox\.ps1)$' -and
        $_ -notin @('config/config.json', 'config/config.local.json', 'config/qa-rules.local.json', 'setup/answers.json')
    })
}

$patterns = [ordered]@{
    'Windows user path' = '(?i)[A-Z]:\\Users\\[^\\\s''"]+'
    'Private workspace path' = '(?i)[A-Z]:\\AIWorkspace\\'
    'Email address' = '(?i)\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b'
    'Telegram bot token' = '\b\d{7,12}:[A-Za-z0-9_-]{30,}\b'
    'OpenAI-style secret' = '\bsk-[A-Za-z0-9_-]{20,}\b'
    'GitHub token' = '\bgh[opusr]_[A-Za-z0-9]{20,}\b'
    'Assigned secret' = '(?i)[''"]?(password|passwd|cookie|authorization|secret|api[_-]?key|access[_-]?token)[''"]?\s*[:=]\s*[''"][^{}$%<][^''"]{5,}[''"]'
}

$findings = @()
foreach ($relative in $relativeFiles) {
    $fullPath = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $fullPath)) { continue }
    if ([System.IO.Path]::GetExtension($fullPath) -match '^\.(png|jpg|jpeg|gif|webp|ico|zip|gz|pdf|lock|pyc|pyo|dll|exe|bin|traineddata)$') { continue }
    $lineNumber = 0
    foreach ($line in Get-Content -LiteralPath $fullPath -ErrorAction SilentlyContinue) {
        $lineNumber += 1
        foreach ($entry in $patterns.GetEnumerator()) {
            if ($relative -eq 'scripts/Scan-PublicSafety.ps1' -and $entry.Key -eq 'Assigned secret') { continue }
            if ($line -match $entry.Value) {
                $findings += [pscustomobject]@{ file = $relative; line = $lineNumber; rule = $entry.Key }
            }
        }
    }
}

$result = [ordered]@{ safe = $findings.Count -eq 0; scannedFiles = $relativeFiles.Count; findings = $findings }
$result | ConvertTo-Json -Depth 6
if ($findings.Count -gt 0) { exit 1 }
