$script:CheckinProjectRoot = Split-Path -Parent $PSScriptRoot

function Resolve-CheckinExecutable {
    param(
        [string]$Configured,
        [string[]]$CommandNames,
        [switch]$Optional
    )

    if ($Configured) {
        if (Test-Path -LiteralPath $Configured) { return (Resolve-Path -LiteralPath $Configured).Path }
        $configuredCommand = Get-Command $Configured -ErrorAction SilentlyContinue
        if ($configuredCommand) { return $configuredCommand.Source }
    }
    foreach ($name in $CommandNames) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command -and $command.Source -notmatch 'WindowsApps\\python(?:3)?\.exe$') { return $command.Source }
    }
    if ($Optional) { return $null }
    throw "未找到运行时：$($CommandNames -join ', ')"
}

function Resolve-CheckinNode {
    param($Config)
    return Resolve-CheckinExecutable -Configured ([string]$Config.nodeExecutable) -CommandNames @('node.exe', 'node')
}

function Resolve-CheckinPython {
    param($Config, [switch]$Optional)
    foreach ($candidate in @(
        (Join-Path $script:CheckinProjectRoot '.venv\Scripts\python.exe'),
        (Join-Path $script:CheckinProjectRoot 'venv\Scripts\python.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return Resolve-CheckinExecutable -Configured ([string]$Config.pythonExecutable) -CommandNames @('python.exe', 'python3.exe', 'python', 'python3') -Optional:$Optional
}
