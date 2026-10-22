[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ChromeExecutable)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$sourcePath=Join-Path (Split-Path -Parent $PSScriptRoot) '..\scripts\Invoke-MainChromeCheckinAccessibility.ps1'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse error'}
$native=$ast.FindAll({param($n) $n -is [Management.Automation.Language.StringConstantExpressionAst] -and $n.Value -match 'public static class CheckinWindowNative'},$true)[0]
$definition=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Close-TaskWindow'},$true)[0]
. ([scriptblock]::Create($definition.Extent.Text))
foreach($name in @('Get-ChromeProcessIds','Get-ChromeWindows','Get-MainProfileChromeProcessIds','Get-WindowElements','Get-CurrentUri','Save-NativeReadLifecycle','Register-NativeTaskWindow')) {
 $definition=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)[0]
 . ([scriptblock]::Create($definition.Extent.Text))
}
$cleanupPath=Join-Path (Split-Path -Parent $PSScriptRoot) '..\scripts\Cleanup-NativePtRead.ps1'
$cleanupAst=[Management.Automation.Language.Parser]::ParseFile($cleanupPath,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Cleanup source parse error'}
$cleanupDefinition=$cleanupAst.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Close-OwnedNativeReadWindow'},$true)[0]
. ([scriptblock]::Create($cleanupDefinition.Extent.Text))
$fixtureNativeSource=@'
namespace CheckinFixture {
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public class ChromeProbe : IDisposable {
 public delegate bool WindowCallback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int len);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 public int Pid; public volatile string Phase="cold_startup"; public volatile bool Done;
 public class Sample { public string Phase;public long Handle;public bool Onscreen,Foreground; }
 private readonly object sync=new object();private readonly List<Sample> rows=new List<Sample>();private readonly Thread thread;
 public ChromeProbe(int pid){Pid=pid;thread=new Thread(Run);thread.IsBackground=true;thread.Start();}
 public bool Owns(IntPtr handle){uint pid;GetWindowThreadProcessId(handle,out pid);return pid==(uint)Pid;}
 private void Run(){while(!Done){EnumWindows(delegate(IntPtr h,IntPtr p){
  if(!Owns(h))return true;
  var c=new StringBuilder(100);GetClassName(h,c,c.Capacity);if(c.ToString()!="Chrome_WidgetWin_1")return true;
  CheckinWindowNative.Rect r;if(!CheckinWindowNative.GetWindowRect(h,out r))return true;
  int left=CheckinWindowNative.GetSystemMetrics(76),top=CheckinWindowNative.GetSystemMetrics(77);
  int right=left+CheckinWindowNative.GetSystemMetrics(78),bottom=top+CheckinWindowNative.GetSystemMetrics(79);
  var row=new Sample{Phase=Phase,Handle=h.ToInt64(),Onscreen=CheckinWindowNative.IsWindowVisible(h)&&!CheckinWindowNative.IsIconic(h)&&r.Left<right&&r.Right>left&&r.Top<bottom&&r.Bottom>top,Foreground=GetForegroundWindow()==h};
  lock(sync){rows.Add(row);}return true;},IntPtr.Zero);Thread.Sleep(10);}}
 public Sample[] Samples(){lock(sync){return rows.ToArray();}}
 public long[] Handles(){var set=new HashSet<long>();foreach(var s in Samples())set.Add(s.Handle);var arr=new long[set.Count];set.CopyTo(arr);return arr;}
 public void Dispose(){Done=true;thread.Join(2000);}
}
}
'@
Add-Type -TypeDefinition ($native.Value+[Environment]::NewLine+$fixtureNativeSource)
$fixtureParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$fixtureContainer=Join-Path $fixtureParent ('checkin-main-chrome-'+[guid]::NewGuid().ToString())
$fixtureRoot=Join-Path $fixtureContainer 'User Data'
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$config=@{chromeExecutable=$ChromeExecutable};$sourceRoot=$fixtureRoot
$ReadOnly=$true;$LifecycleToken=[guid]::NewGuid().ToString();$LifecyclePath=Join-Path $fixtureRoot 'discovery-lifecycle.json'
$html='<html><body><h1>Window fixture ready</h1><button onclick="document.getElementById(''status'').textContent=''Window fixture invoked''">Fixture action</button><p id="status">Window fixture waiting</p></body></html>'
$fixtureUrl='data:text/html;base64,'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($html))
$fixtureArguments=@(('"--user-data-dir='+$fixtureRoot+'"'),'--new-window',('--window-position='+[CheckinWindowNative]::OffscreenX+','+[CheckinWindowNative]::OffscreenY),'--window-size=1400,900','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--force-renderer-accessibility','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding',$fixtureUrl)
$fixtureProcess=$null;$monitor=$null
function Wait-FixtureHandle([long[]]$Exclude=@()) {
 $deadline=[datetimeoffset]::UtcNow.AddSeconds(20)
 do {
  foreach($candidate in @(Get-ChromeWindows)) {
   $handle=[IntPtr]$candidate.Current.NativeWindowHandle
   if($handle.ToInt64() -in $Exclude -or -not $monitor.Owns($handle)){continue}
   if(-not [CheckinWindowNative]::IsStartupOffscreenWindow($handle,[int[]]@(Get-MainProfileChromeProcessIds))){continue}
   Register-NativeTaskWindow $candidate
   [CheckinWindowNative]::RenderOffscreen($handle,$previousForeground)
   return $handle
  }
  Start-Sleep -Milliseconds 50
 }while([datetimeoffset]::UtcNow -lt $deadline)
 throw 'Fixture Chrome did not create a task window'
}
function Wait-FixtureButton([IntPtr]$Handle) {
 $window=[Windows.Automation.AutomationElement]::FromHandle($Handle)
 $deadline=[datetimeoffset]::UtcNow.AddSeconds(15)
 do {
  [CheckinWindowNative]::RenderOffscreen($Handle,$previousForeground)
  foreach($element in @($window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))){try{if($element.Current.Name -eq 'Fixture action'){return $element}}catch{}}
  Start-Sleep -Milliseconds 100
 }while([datetimeoffset]::UtcNow -lt $deadline)
 throw 'Fixture Chrome accessibility button unavailable'
}
try {
 $previousForeground=[CheckinWindowNative]::GetForegroundWindow()
 $fixtureProcess=Start-Process -FilePath $ChromeExecutable -ArgumentList $fixtureArguments -WindowStyle Hidden -PassThru
 $monitor=[CheckinFixture.ChromeProbe]::new($fixtureProcess.Id)
 $firstHandle=Wait-FixtureHandle
 [void][CheckinWindowNative]::ShowWindow($firstHandle,0)
 $hiddenWindows=@(Get-ChromeWindows|Where-Object{$_.Current.NativeWindowHandle -eq $firstHandle.ToInt32()})
 $hiddenDiscovered=$hiddenWindows.Count -eq 1
 if(-not $hiddenDiscovered){throw 'Production discovery did not find the hidden fixture window'}
 Register-NativeTaskWindow $hiddenWindows[0]
 $earlyLifecycle=Get-Content -LiteralPath $LifecyclePath -Raw|ConvertFrom-Json
 $hiddenLifecycleOwned=$earlyLifecycle.handle -eq $firstHandle.ToInt64() -and $earlyLifecycle.closed -eq $false
 [CheckinWindowNative]::RenderOffscreen($firstHandle,$previousForeground)
 $firstWindow=[Windows.Automation.AutomationElement]::FromHandle($firstHandle)
 $firstRect=[CheckinWindowNative+Rect]::new();[void][CheckinWindowNative]::GetWindowRect($firstHandle,[ref]$firstRect)
 $firstButton=Wait-FixtureButton $firstHandle
 $coldUriRead=(Get-CurrentUri $firstWindow).Scheme -eq 'data'
 $monitor.Phase='warm_startup'
 Start-Process -FilePath $ChromeExecutable -ArgumentList $fixtureArguments -WindowStyle Hidden | Out-Null
 $secondHandle=Wait-FixtureHandle @($firstHandle.ToInt64())
 [CheckinWindowNative]::RenderOffscreen($secondHandle,$previousForeground)
 $secondButton=Wait-FixtureButton $secondHandle
 $warmUriRead=(Get-CurrentUri ([Windows.Automation.AutomationElement]::FromHandle($secondHandle))).Scheme -eq 'data'
 $monitor.Phase='invoke'
 # Chrome can mark an element IsOffscreen=false even when its HWND is outside
 # the desktop. Read and Invoke the real control rather than trusting that bit.
 $pattern=$secondButton.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
 $pattern.Invoke()
 [CheckinWindowNative]::RestoreForegroundIfTask($secondHandle,$previousForeground)
 $secondWindow=[Windows.Automation.AutomationElement]::FromHandle($secondHandle)
 $deadline=[datetimeoffset]::UtcNow.AddSeconds(5);$invoked=$false
 do {
  [CheckinWindowNative]::RenderOffscreen($secondHandle,$previousForeground)
  foreach($e in @($secondWindow.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition))){try{if($e.Current.Name -eq 'Window fixture invoked'){$invoked=$true}}catch{}}
  if(-not $invoked){Start-Sleep -Milliseconds 100}
 }while(-not $invoked -and [datetimeoffset]::UtcNow -lt $deadline)
 $monitor.Phase='cleanup'
 [CheckinWindowNative]::PrepareToClose($secondHandle)
 $placement=[CheckinWindowNative+Placement]::new();$placement.Length=[Runtime.InteropServices.Marshal]::SizeOf($placement)
 [void][CheckinWindowNative]::GetWindowPlacement($secondHandle,[ref]$placement)
 $hiddenForClose=-not [CheckinWindowNative]::IsWindowVisible($secondHandle)
 Close-TaskWindow $secondWindow $previousForeground
 $secondClosed=-not [CheckinWindowNative]::IsWindow($secondHandle)
 $firstAfter=[CheckinWindowNative+Rect]::new();[void][CheckinWindowNative]::GetWindowRect($firstHandle,[ref]$firstAfter)
 $firstUnchanged=$firstRect.Left -eq $firstAfter.Left -and $firstRect.Top -eq $firstAfter.Top -and $firstRect.Right -eq $firstAfter.Right -and $firstRect.Bottom -eq $firstAfter.Bottom
 $monitor.Phase='timeout_cleanup'
 Start-Process -FilePath $ChromeExecutable -ArgumentList $fixtureArguments -WindowStyle Hidden | Out-Null
 $timeoutHandle=Wait-FixtureHandle @($firstHandle.ToInt64())
 [CheckinWindowNative]::RenderOffscreen($timeoutHandle,$previousForeground)
 $timeoutButton=Wait-FixtureButton $timeoutHandle
 $HelperProcessId=$PID;$StartedAt=[datetimeoffset]::UtcNow;$LifecyclePath=Join-Path $fixtureRoot 'timeout-lifecycle.json'
 $ownerToken=[guid]::NewGuid().ToString()
 $record=[pscustomobject]@{schemaVersion=1;readOnly=$true;helperPid=$PID;helperStartedAt=$StartedAt.ToString('o');handle=$timeoutHandle.ToInt64();token=$ownerToken;closed=$false}
 [IO.File]::WriteAllText($LifecyclePath,($record|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
 $unownedRejected=(Close-OwnedNativeReadWindow) -eq 'window_not_owned'
 $unownedStillOpen=[CheckinWindowNative]::IsWindow($timeoutHandle)
 if(-not [CheckinWindowNative]::SetProp($timeoutHandle,('CheckinNativeReadOwner_'+$ownerToken),[IntPtr]1)){throw 'Fixture task ownership property failed'}
 $timeoutClosed=(Close-OwnedNativeReadWindow) -eq 'closed'
 $firstAfterTimeout=[CheckinWindowNative+Rect]::new();[void][CheckinWindowNative]::GetWindowRect($firstHandle,[ref]$firstAfterTimeout)
 $firstUnchanged=$firstUnchanged -and $firstRect.Left -eq $firstAfterTimeout.Left -and $firstRect.Top -eq $firstAfterTimeout.Top -and $firstRect.Right -eq $firstAfterTimeout.Right -and $firstRect.Bottom -eq $firstAfterTimeout.Bottom
 $monitor.Phase='minimized_failure'
 [void][CheckinWindowNative]::ShowWindow($firstHandle,7)
 $minimizedRejected=$false
 try{[CheckinWindowNative]::RenderOffscreen($firstHandle,$previousForeground)}catch{$minimizedRejected=$true}
 $remainedMinimized=[CheckinWindowNative]::IsIconic($firstHandle)
 $monitor.Phase='anchor_cleanup'
 Close-TaskWindow $firstWindow $previousForeground
 $monitor.Dispose()
 $samples=@($monitor.Samples())
 [pscustomobject]@{samples=$samples.Count;onscreen=@($samples|Where-Object Onscreen).Count;foreground=@($samples|Where-Object Foreground).Count;hiddenDiscovered=$hiddenDiscovered;hiddenLifecycleOwned=$hiddenLifecycleOwned;coldUriRead=$coldUriRead;warmUriRead=$warmUriRead;invoked=$invoked;safeBounds=$placement.NormalPosition;hiddenForClose=$hiddenForClose;firstUnchanged=$firstUnchanged;secondClosed=$secondClosed;minimizedRejected=$minimizedRejected;remainedMinimized=$remainedMinimized;unownedRejected=$unownedRejected;unownedStillOpen=$unownedStillOpen;timeoutClosed=$timeoutClosed;phases=@($samples|Group-Object Phase|ForEach-Object{[pscustomobject]@{phase=$_.Name;samples=$_.Count;onscreen=@($_.Group|Where-Object Onscreen).Count;foreground=@($_.Group|Where-Object Foreground).Count}})}|ConvertTo-Json -Depth 5 -Compress
} finally {
 if($monitor){$monitor.Dispose()}
 if($fixtureProcess){
  if($monitor -and -not $fixtureProcess.HasExited){foreach($owned in @($monitor.Handles())){if($monitor.Owns([IntPtr]$owned) -and [CheckinWindowNative]::IsWindow([IntPtr]$owned)){[CheckinWindowNative]::PrepareToClose([IntPtr]$owned);[void][CheckinWindowNative]::PostMessage([IntPtr]$owned,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)}}}
  if(-not $fixtureProcess.HasExited -and -not $fixtureProcess.WaitForExit(2000)){$fixtureProcess.Kill();[void]$fixtureProcess.WaitForExit(2000)}
 }
 $resolvedFixtureContainer=[IO.Path]::GetFullPath($fixtureContainer)
 if((Split-Path -Parent $resolvedFixtureContainer) -ne $fixtureParent -or (Split-Path -Leaf $resolvedFixtureContainer) -notmatch '^checkin-main-chrome-[a-f0-9-]{36}$'){throw 'Fixture cleanup target rejected'}
 if(Test-Path -LiteralPath $resolvedFixtureContainer){Remove-Item -LiteralPath $resolvedFixtureContainer -Recurse -Force}
}
