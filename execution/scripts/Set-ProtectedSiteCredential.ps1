[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Origin)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$uri = [uri]$Origin
if ($uri.Scheme -ne 'https' -or -not $uri.Host -or $uri.GetLeftPart([System.UriPartial]::Authority) -ne $Origin.TrimEnd('/')) {
    throw '凭据来源必须是规范的 HTTPS origin，例如 https://example.com。'
}

$credentialsRoot = Join-Path $root 'data\credentials'
[System.IO.Directory]::CreateDirectory($credentialsRoot) | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $credentialsRoot
$accessRules = @($acl.Access)
$aclAlreadyRestricted = $acl.AreAccessRulesProtected `
    -and $accessRules.Count -eq 1 `
    -and [string]$accessRules[0].IdentityReference -eq $identity `
    -and $accessRules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow `
    -and ($accessRules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
if (-not $aclAlreadyRestricted) {
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [System.Security.AccessControl.FileSystemRights]::FullControl,
        [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $credentialsRoot -AclObject $acl
}

$username = Read-Host '站点用户名（输入不会显示）' -AsSecureString
$password = Read-Host '站点密码（输入不会显示）' -AsSecureString
if ($username.Length -lt 1 -or $password.Length -lt 1) { throw '用户名和密码都不能为空。' }

$hostKey = ($uri.DnsSafeHost -replace '[^a-z0-9.-]', '_').ToLowerInvariant()
$credentialPath = Join-Path $credentialsRoot "$hostKey.json"
$temporary = "$credentialPath.$PID.tmp"
$payload = [ordered]@{
    version = 1
    origin = $uri.GetLeftPart([System.UriPartial]::Authority)
    usernameProtected = ConvertFrom-SecureString $username
    passwordProtected = ConvertFrom-SecureString $password
    updatedAt = (Get-Date).ToUniversalTime().ToString('o')
}
[System.IO.File]::WriteAllText($temporary, ($payload | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $credentialPath -Force
Write-Output (@{ status = 'stored'; origin = $payload.origin } | ConvertTo-Json -Compress)
