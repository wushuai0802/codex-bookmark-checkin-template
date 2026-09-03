[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
foreach ($principal in @($identity, 'SYSTEM')) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $principal, [System.Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance, $propagation, $allow
    )
    [void]$acl.AddAccessRule($rule)
}
$directory = [System.IO.DirectoryInfo]::new($root)
[System.IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl)
Write-Output "已将运行端目录权限限制为当前用户与 SYSTEM：$root"
