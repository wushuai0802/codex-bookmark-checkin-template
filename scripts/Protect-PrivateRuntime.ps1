[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$acl = Get-Acl -LiteralPath $root
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
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
Set-Acl -LiteralPath $root -AclObject $acl
Write-Output "已将运行端目录权限限制为当前用户与 SYSTEM：$root"
