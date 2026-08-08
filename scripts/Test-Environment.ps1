[CmdletBinding()]
param(
    [string[]]$ContainerFolderNames = @(),
    [string[]]$TargetFolderNames = @(),
    [string[]]$EdgeContainerFolderNames = @(),
    [string[]]$EdgeTargetFolderNames = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
$pwshCommand = Get-Command pwsh -ErrorAction SilentlyContinue
$projectPython = @(
    (Join-Path $root '.venv\Scripts\python.exe'),
    (Join-Path $root 'venv\Scripts\python.exe')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$pythonCommand = if ($projectPython) { $projectPython } else {
    Get-Command python,python3 -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'WindowsApps\\python(?:3)?\.exe$' } | Select-Object -First 1
}
$quoteCharacters = [char[]]@([char]39, [char]34)
$resolvedContainerNames = @($ContainerFolderNames | ForEach-Object { [string]$_ -split ',' } | ForEach-Object { $_.Trim().Trim($quoteCharacters) } | Where-Object { $_ })
$resolvedTargetNames = @($TargetFolderNames | ForEach-Object { [string]$_ -split ',' } | ForEach-Object { $_.Trim().Trim($quoteCharacters) } | Where-Object { $_ })
$resolvedEdgeContainerNames = @($EdgeContainerFolderNames | ForEach-Object { [string]$_ -split ',' } | ForEach-Object { $_.Trim().Trim($quoteCharacters) } | Where-Object { $_ })
$resolvedEdgeTargetNames = @($EdgeTargetFolderNames | ForEach-Object { [string]$_ -split ',' } | ForEach-Object { $_.Trim().Trim($quoteCharacters) } | Where-Object { $_ })

if (-not $nodeCommand) {
    [ordered]@{
        generatedAt = (Get-Date).ToString('o')
        ready = $false
        checks = [ordered]@{
            supportedWindows = $IsWindows -or $env:OS -eq 'Windows_NT'
            powershellSupported = $PSVersionTable.PSVersion.Major -ge 5
            nodePresent = $false
            npmPresent = [bool]$npmCommand
            pythonPresent = [bool]$pythonCommand
            scheduledTaskCmdletPresent = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
        }
        guidance = [ordered]@{ blocking = @('nodePresent'); needsUserInput = @('installNode') }
    } | ConvertTo-Json -Depth 8
    return
}

$nodeArguments = @((Join-Path $root 'src\preflight.mjs'))
if ($resolvedContainerNames.Count -gt 0 -or $resolvedTargetNames.Count -gt 0 -or $resolvedEdgeContainerNames.Count -gt 0 -or $resolvedEdgeTargetNames.Count -gt 0) {
    if ($resolvedContainerNames.Count -eq 0 -or $resolvedTargetNames.Count -eq 0) {
        throw 'ContainerFolderNames 和 TargetFolderNames 必须同时提供。'
    }
    $scope = [ordered]@{
        mobileFolderNames = @($resolvedContainerNames)
        targetFolderNames = @($resolvedTargetNames)
    }
    if ($resolvedEdgeContainerNames.Count -gt 0 -or $resolvedEdgeTargetNames.Count -gt 0) {
        if ($resolvedEdgeContainerNames.Count -eq 0 -or $resolvedEdgeTargetNames.Count -eq 0) {
            throw 'EdgeContainerFolderNames 和 EdgeTargetFolderNames 必须同时提供。'
        }
        $scope.edgeMobileFolderNames = @($resolvedEdgeContainerNames)
        $scope.edgeTargetFolderNames = @($resolvedEdgeTargetNames)
    }
    $scope = $scope | ConvertTo-Json -Compress
    $scopeBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($scope))
    $nodeArguments += @('--scope-json-base64', $scopeBase64)
}
$raw = & $nodeCommand.Source @nodeArguments
if ($LASTEXITCODE -ne 0) { throw '环境预检程序运行失败。' }
$report = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
$report.checks | Add-Member -NotePropertyName powershellSupported -NotePropertyValue ($PSVersionTable.PSVersion.Major -ge 5) -Force
$report.checks | Add-Member -NotePropertyName npmPresent -NotePropertyValue ([bool]$npmCommand) -Force
$report.checks | Add-Member -NotePropertyName pwshPresent -NotePropertyValue ([bool]$pwshCommand) -Force
$report.checks | Add-Member -NotePropertyName pythonPresent -NotePropertyValue ([bool]$pythonCommand) -Force
$report | Add-Member -NotePropertyName optionalCapabilities -NotePropertyValue ([ordered]@{
    pythonForSavedLoginSync = [bool]$pythonCommand
    windowsTaskScheduler = [bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)
    edgeBookmarkSource = [bool]$report.checks.readableEdgeBookmarkProfile
    externalNotification = $false
}) -Force
$report.checks | Add-Member -NotePropertyName scheduledTaskCmdletPresent -NotePropertyValue ([bool](Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) -Force
if (-not $npmCommand) {
    $report.ready = $false
    $report.guidance.blocking = @($report.guidance.blocking) + 'npmPresent'
}
$report | ConvertTo-Json -Depth 10
