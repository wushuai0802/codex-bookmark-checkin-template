[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$HelperProcessId,
    [Parameter(Mandatory=$true)][datetimeoffset]$StartedAt,
    [Parameter(Mandatory=$true)][string]$LifecyclePath)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)

function Stop-OwnedNativeReadHelpers {
    $helper=Get-Process -Id $HelperProcessId -ErrorAction SilentlyContinue
    if (-not $helper) { return }
    if ($helper.ProcessName -notin @('pwsh','powershell') -or
        $helper.StartTime.ToUniversalTime() -lt $StartedAt.UtcDateTime.AddSeconds(-1) -or
        $helper.StartTime.ToUniversalTime() -gt $StartedAt.UtcDateTime.AddSeconds(5)) { throw 'helper ownership rejected' }
    $owned=@([pscustomobject]@{id=$HelperProcessId;started=$helper.StartTime.ToUniversalTime()})
    for($index=0;$index -lt $owned.Count -and $owned.Count -lt 64;$index++) {
        foreach($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($owned[$index].id)")) {
            # Chrome is a shared main-profile session, not a disposable helper.
            # Never traverse a browser tree or kill it through taskkill /T.
            if($child.Name -notin @('powershell.exe','pwsh.exe','node.exe','conhost.exe') -or
                $child.CreationDate.ToUniversalTime() -lt $StartedAt.UtcDateTime.AddSeconds(-1)) { continue }
            if(@($owned.id) -notcontains [int]$child.ProcessId) {
                $owned += [pscustomobject]@{id=[int]$child.ProcessId;started=$child.CreationDate.ToUniversalTime()}
            }
        }
    }
    [array]::Reverse($owned)
    foreach($entry in $owned) {
        $process=Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if($process -and [Math]::Abs(($process.StartTime.ToUniversalTime()-$entry.started).TotalMilliseconds) -lt 10) {
            # Hold the process object's handle after verifying its start time;
            # a recycled numeric PID must not target a later unrelated process.
            try { [void]$process.Kill() } catch { }
        }
    }
}

function Close-OwnedNativeReadWindow {
    if(-not (Test-Path -LiteralPath $LifecyclePath -PathType Leaf)) { return 'window_unavailable' }
    $record=Get-Content -LiteralPath $LifecyclePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if($record.schemaVersion -ne 1 -or $record.readOnly -ne $true -or $record.helperPid -ne $HelperProcessId -or
        $record.token -notmatch '^[a-f0-9-]{36}$' -or
        [datetimeoffset]$record.helperStartedAt -lt $StartedAt.AddSeconds(-1) -or
        [datetimeoffset]$record.helperStartedAt -gt $StartedAt.AddSeconds(5)) { return 'window_not_owned' }
    if($record.closed -eq $true) { return 'already_closed' }
    Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CheckinReadCleanupNative {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Placement {
  public int Length,Flags,ShowCommand; public Point MinPosition,MaxPosition; public Rect NormalPosition;
 }
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr handle,string name);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle,uint message,IntPtr wParam,IntPtr lParam);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle,int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowPlacement(IntPtr handle,ref Placement placement);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPlacement(IntPtr handle,ref Placement placement);
 public static void PrepareToClose(IntPtr handle) {
  ShowWindow(handle,0);
  var placement=new Placement();placement.Length=Marshal.SizeOf(typeof(Placement));
  if(!GetWindowPlacement(handle,ref placement))throw new Win32Exception(Marshal.GetLastWin32Error());
  placement.Flags=0;placement.ShowCommand=0;
  placement.NormalPosition=new Rect { Left=80,Top=80,Right=1480,Bottom=980 };
  if(!SetWindowPlacement(handle,ref placement))throw new Win32Exception(Marshal.GetLastWin32Error());
  if(IsWindowVisible(handle))throw new InvalidOperationException("Task window became visible during cleanup");
 }
}
'@
    $handle=[IntPtr][long]$record.handle
    if(-not [CheckinReadCleanupNative]::IsWindow($handle)) { return 'already_closed' }
    # A per-task window property survives while this exact window exists and
    # vanishes on destruction. A reused HWND cannot close an unrelated window.
    if([CheckinReadCleanupNative]::GetProp($handle,('CheckinNativeReadOwner_'+$record.token)) -ne [IntPtr]1) { return 'window_not_owned' }
    # A timeout must not persist task-only off-screen bounds into the user's
    # shared Chrome profile. Hide before updating placement; still close the
    # owned HWND when the placement operation itself fails.
    try { [CheckinReadCleanupNative]::PrepareToClose($handle) } catch { }
    [void][CheckinReadCleanupNative]::PostMessage($handle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
    $deadline=[datetimeoffset]::UtcNow.AddSeconds(2)
    while([CheckinReadCleanupNative]::IsWindow($handle) -and [datetimeoffset]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if([CheckinReadCleanupNative]::IsWindow($handle)) { return 'window_close_timeout' }
    return 'closed'
}

try { Stop-OwnedNativeReadHelpers; $code=Close-OwnedNativeReadWindow }
catch { $code='window_unavailable' }
@{code=$code} | ConvertTo-Json -Compress
