[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$WorkerProcessId,[Parameter(Mandatory=$true)][int]$ObserverProcessId,
  [Parameter(Mandatory=$true)][string]$OwnerId,[Parameter(Mandatory=$true)][datetimeoffset]$StartedAt,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,[string]$PrivateProfile)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$held=[Collections.Generic.List[object]]::new()
$seen=@{}
$completed=$false
$sharedPreserved=$false
$stage='preflight'
$rootMatched=$false
try {
  if(-not ('CheckinLongPath' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CheckinLongPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetLongPathName(string path, StringBuilder result, uint length);
}
'@}
  function Canonical-WorkerPath([string]$Value){
    $full=[IO.Path]::GetFullPath($Value);$buffer=[Text.StringBuilder]::new(32768)
    if([CheckinLongPath]::GetLongPathName($full,$buffer,32768) -gt 0){return $buffer.ToString()}
    return $full
  }
  function Command-HasPath([string]$Line,[string]$Expected,[bool]$Prefix=$false){
    foreach($part in [regex]::Matches($Line,'"([^"]*)"|([^\s"]+)')){
      $value=if($part.Groups[1].Success){$part.Groups[1].Value}else{$part.Groups[2].Value}
      if(-not [IO.Path]::IsPathRooted($value)){continue}
      try{$actual=Canonical-WorkerPath $value}catch{continue}
      if($Prefix -and $actual.StartsWith($Expected.TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){return $true}
      if(-not $Prefix -and $actual.Equals($Expected,[StringComparison]::OrdinalIgnoreCase)){return $true}
    }
    return $false
  }
  function Command-HasProfile([string]$Line,[string]$Expected){
    if(Command-HasPath $Line $Expected){return $true}
    $part=[regex]::Match($Line,'(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))')
    $value=if($part.Groups[1].Success){$part.Groups[1].Value}elseif($part.Groups[2].Success){$part.Groups[2].Value}else{$part.Groups[3].Value}
    if(-not $value){return $false}
    return (Canonical-WorkerPath $value).Equals($Expected,[StringComparison]::OrdinalIgnoreCase)
  }
  $resolvedRoot=Canonical-WorkerPath $RuntimeRoot
  $expectedScript=Canonical-WorkerPath (Join-Path $resolvedRoot 'scripts/Run-PtSupplement.mjs')
  if($OwnerId -cnotmatch '^[a-f0-9-]{36}$' -or $WorkerProcessId -lt 0){throw 'ownership'}
  if($PrivateProfile){
    $PrivateProfile=Canonical-WorkerPath $PrivateProfile
    $prefix=(Join-Path $resolvedRoot 'data').TrimEnd([char[]]'\/')+[IO.Path]::DirectorySeparatorChar
    if(-not $PrivateProfile.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'profile'}
  }
  if($WorkerProcessId -eq 0){
    $candidates=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object{
      $_.ParentProcessId -eq $ObserverProcessId -and ([string]$_.CommandLine).Contains('--worker-owner='+$OwnerId) -and
      (Command-HasPath ([string]$_.CommandLine) $expectedScript)})
    if($candidates.Count -gt 1){throw 'ambiguous owner'}
    if($candidates.Count -eq 1){$WorkerProcessId=[int]$candidates[0].ProcessId}
  }
  $worker=if($WorkerProcessId -gt 0){Get-CimInstance Win32_Process -Filter "ProcessId=$WorkerProcessId" -ErrorAction SilentlyContinue}else{$null}
  $owned=$worker -and $worker.Name -eq 'node.exe' -and $worker.ParentProcessId -eq $ObserverProcessId -and
    (Command-HasPath ([string]$worker.CommandLine) $expectedScript) -and
    ([string]$worker.CommandLine).Contains('--worker-owner='+$OwnerId) -and
    $worker.CreationDate.ToUniversalTime() -ge $StartedAt.UtcDateTime.AddSeconds(-1) -and
    $worker.CreationDate.ToUniversalTime() -le $StartedAt.UtcDateTime.AddSeconds(5)
  $rootMatched=[bool]$owned;$stage='ownership'
  $scopeChecks=@{present=[bool]$worker;node=($worker.Name -eq 'node.exe');parent=($worker.ParentProcessId -eq $ObserverProcessId);
    script=($worker -and (Command-HasPath ([string]$worker.CommandLine) $expectedScript));
    owner=($worker -and ([string]$worker.CommandLine).Contains('--worker-owner='+$OwnerId));
    start=($worker -and $worker.CreationDate.ToUniversalTime() -ge $StartedAt.UtcDateTime.AddSeconds(-1) -and $worker.CreationDate.ToUniversalTime() -le $StartedAt.UtcDateTime.AddSeconds(5))}
  function Add-OwnedProcess($Info,[bool]$BrowserParent=$false){
    if($seen.ContainsKey([int]$Info.ProcessId)){return}
    $browser=[string]$Info.Name -match '^(chrome|msedge|firefox|brave|vivaldi|chromium|chrome_crashpad_handler|crashpad_handler)\.exe$'
    if(-not $browser -and $Info.ProcessId -ne $WorkerProcessId){
      # Native-messaging hosts and unrelated services are not automation helpers.
      # Only project scripts below the owned Node worker may be terminated.
      if($BrowserParent -or [string]$Info.Name -notmatch '^(node|pwsh|powershell|python|python3)\.exe$' -or
        -not (Command-HasPath ([string]$Info.CommandLine) $resolvedRoot $true)){
        $seen[[int]$Info.ProcessId]=$true;return
      }
    }
    if($browser -and -not $BrowserParent){
      $part=[regex]::Match([string]$Info.CommandLine,'(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))')
      $directory=if($part.Groups[1].Success){$part.Groups[1].Value}elseif($part.Groups[2].Success){$part.Groups[2].Value}else{$part.Groups[3].Value}
      if(-not $PrivateProfile -or -not $directory -or -not (Canonical-WorkerPath $directory).Equals($PrivateProfile,[StringComparison]::OrdinalIgnoreCase)){
        $script:sharedPreserved=$true;$seen[[int]$Info.ProcessId]=$true;return
      }
    }
    $process=Get-Process -Id $Info.ProcessId -ErrorAction SilentlyContinue
    if(-not $process){return}
    [void]$process.Handle
    if([Math]::Abs(($process.StartTime.ToUniversalTime()-$Info.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 50){$process.Dispose();return}
    $seen[[int]$Info.ProcessId]=$true
    $held.Add([pscustomobject]@{pid=[int]$Info.ProcessId;process=$process;browser=$browser;started=$Info.CreationDate.ToUniversalTime()})
  }
  if($owned){
    $stage='collect'
    Add-OwnedProcess $worker
    # Held OS handles prevent PID reuse while descendants are collected/stopped.
    for($round=0;$round -lt 4;$round++){
      for($index=0;$index -lt $held.Count -and $held.Count -lt 128;$index++){
        $parent=$held[$index]
        foreach($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($parent.pid)" -ErrorAction SilentlyContinue)){
          if($child.CreationDate.ToUniversalTime() -ge $parent.started){Add-OwnedProcess $child $parent.browser}
        }
      }
      foreach($entry in @($held | Where-Object{-not $_.browser})){
        $stage='stop'
        if(-not $entry.process.HasExited){try{$entry.process.Kill()}catch{}}
      }
      foreach($entry in @($held | Where-Object{$_.browser})){
        if(-not $entry.process.HasExited){try{[void]$entry.process.CloseMainWindow()}catch{}}
      }
      Start-Sleep -Milliseconds 150
      foreach($entry in $held){if(-not $entry.process.HasExited){try{$entry.process.Kill()}catch{}}}
      if(@($held | Where-Object{-not $_.process.HasExited}).Count -eq 0){
        $stage='verify'
        $more=@(foreach($entry in $held){Get-CimInstance Win32_Process -Filter "ParentProcessId=$($entry.pid)" -ErrorAction SilentlyContinue})
        if(@($more|Where-Object{-not $seen.ContainsKey([int]$_.ProcessId)}).Count -eq 0){$completed=$true;break}
      }
    }
  }else{
    # An absent/reused root PID is never permission to kill another process.
    # Keep the durable barrier if a potentially owned helper/private browser remains.
    $active=@(Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='pwsh.exe' OR Name='powershell.exe' OR Name='chrome.exe' OR Name='msedge.exe'" |
      Where-Object{
        $_.ProcessId -ne $PID -and $_.ProcessId -ne $ObserverProcessId -and
        $_.CreationDate.ToUniversalTime() -ge $StartedAt.UtcDateTime.AddSeconds(-1) -and
        (([string]$_.CommandLine).Contains('--worker-owner='+$OwnerId) -or
          ($PrivateProfile -and (Command-HasProfile ([string]$_.CommandLine) $PrivateProfile)))
      })
    $completed=$active.Count -eq 0
  }
}catch{$completed=$false}
finally{foreach($entry in $held){$entry.process.Dispose()}}
@{completed=[bool]$completed;sharedBrowserPreserved=[bool]$sharedPreserved;stage=$stage;rootMatched=$rootMatched;scopeChecks=$scopeChecks}|ConvertTo-Json -Compress -Depth 3
