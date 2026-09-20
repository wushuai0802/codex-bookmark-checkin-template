[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root 'config\config.json') | ConvertFrom-Json
$sourceRoot = [System.IO.Path]::GetFullPath([string]$config.sourceUserDataDir)
$volumeRoot = [System.IO.Path]::GetPathRoot($sourceRoot)
$shadow = $null

try {
    $result = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{
        Volume = $volumeRoot
        Context = 'ClientAccessible'
    }
    if ($result.ReturnValue -ne 0 -or -not $result.ShadowID) {
        throw "创建只读卷快照失败，返回码：$($result.ReturnValue)"
    }

    $shadow = Get-CimInstance Win32_ShadowCopy | Where-Object ID -eq $result.ShadowID
    if (-not $shadow) { throw '卷快照已创建，但无法重新定位。' }

    $relativeSource = $sourceRoot.Substring($volumeRoot.Length).TrimStart('\')
    $shadowSourceRoot = "$($shadow.DeviceObject.TrimEnd('\'))\$relativeSource"
    Write-Output "已创建临时只读快照：$($shadow.ID)"
    & (Join-Path $PSScriptRoot 'Initialize-BrowserProfile.ps1') -Force -SourceUserDataOverride $shadowSourceRoot
}
finally {
    if ($shadow) {
        $shadow | Remove-CimInstance -ErrorAction SilentlyContinue
        Write-Output '临时只读卷快照已删除。'
    }
}
