import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url)).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];

for(const shell of shells)test(`native preflight projects both entry lists through the background preference (${shell})`,()=>{
  const source=`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'preflight parse failed'}
$function=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Resolve-UnattendedNativeWindowMode'},$true)[0]
. ([scriptblock]::Create($function.Extent.Text))
function Resolve-NativeProfilePath([string]$Override,[string]$Origin){return 'fixture-profile'}
$maps=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -eq 'items'},$true))
$results=@()
foreach($mode in @('offscreen','missing','visible')){
  $config=[pscustomobject]@{
    nativeWafPreflightUrls=@(
      [pscustomobject]@{url='https://first.example/index.php';waitSeconds=10;passiveOnly=$true;windowMode='minimized'},
      [pscustomobject]@{url='https://second.example/index.php';waitSeconds=10;windowMode='visible'},
      'https://third.example/index.php'
    )
    nativeChallengePreflight=@([pscustomobject]@{url='https://fourth.example/index.php';waitSeconds=10;action='checkin';windowMode='visible'})
    nativeAccessibilityCheckinOrigins=@()
  }
  if($mode -ne 'missing'){$config|Add-Member -NotePropertyName backgroundWindowMode -NotePropertyValue $mode}
  . ([scriptblock]::Create($maps[0].Extent.Text))
  . ([scriptblock]::Create($maps[1].Extent.Text))
  $results+=@{mode=$mode;windows=@($items.windowMode);actions=@($items.action)}
}
$config=[pscustomobject]@{backgroundWindowMode='offscreen'}
$invalidRejected=$false
try{Resolve-UnattendedNativeWindowMode 'invalid'|Out-Null}catch{$invalidRejected=$true}
@{results=$results;invalidRejected=$invalidRejected}|ConvertTo-Json -Compress -Depth 5
`;
  const run=spawnSync(shell,['-NoProfile','-NonInteractive','-Command',source],{encoding:'utf8',windowsHide:true,timeout:15000});
  assert.equal(run.status,0,run.stderr);
  const report=JSON.parse(run.stdout.trim().replace(/^\uFEFF/,''));
  assert.deepEqual(report.results[0].windows,['offscreen','offscreen','offscreen','offscreen']);
  assert.deepEqual(report.results[1].windows,['offscreen','offscreen','offscreen','offscreen']);
  assert.deepEqual(report.results[2].windows,['minimized','visible','offscreen','visible']);
  assert.equal(report.results[0].actions.at(-1),'checkin');
  assert.equal(report.invalidRejected,true);
});
