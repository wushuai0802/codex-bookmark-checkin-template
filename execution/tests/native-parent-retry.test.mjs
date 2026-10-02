import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url)).replaceAll("'","''");
test('native parent retries only an explicitly non-submitted failure, not missing or malformed child results',()=>{
  const command=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$node=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-MainChromeFallbackResult'},$true)[0]
. ([scriptblock]::Create($node.Extent.Text))
function Get-Process { [pscustomobject]@{Path='Invoke-FakeNative'} }
function Join-Path { 'fixture-helper.ps1' }
function Start-Sleep { }
function Invoke-FakeNative { $script:called++; switch($script:scenario){'empty'{} 'broken'{'{bad'} 'submitted'{'{"status":"unconfirmed","failureCode":"accessibility_unavailable","submissionAttempted":true}'} 'safe'{if($script:called -eq 1){'{"status":"unconfirmed","failureCode":"window_not_created","submissionAttempted":false}'}else{'{"status":"already_signed","submissionAttempted":false}'}}} }
$mainFallbackByOrigin=@{'https://native.example'=$true}
$PSScriptRoot='fixture'
$rows=@(foreach($scenario in @('empty','broken','submitted','safe')){$script:scenario=$scenario;$script:called=0
  $value=Invoke-MainChromeFallbackResult 'https://native.example' 'https://native.example/index.php' 10
  [pscustomobject]@{scenario=$scenario;called=$script:called;status=$value.status;submitted=$value.submissionAttempted}})
$rows | ConvertTo-Json -Compress
`;
  for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
    const rows=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000}));
    for(const row of rows.slice(0,3)){assert.equal(row.called,1,row.scenario);assert.equal(row.submitted,true,row.scenario);}
    assert.equal(rows[3].called,2);assert.equal(rows[3].status,'already_signed');
  }
});

test('native preflight wrapping never labels a confirmed submission as an unknown outcome',()=>{
  const command=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$source=[IO.File]::ReadAllText('${script}')
$expressions=@([regex]::Matches($source,'(?m)^\\s*failureCode = (if \\(\\$twoFactorRequired\\).*submission_outcome_unknown.*)$') | ForEach-Object {$_.Groups[1].Value.Trim()})
$twoFactorRequired=$false;$submissionAttempted=$true
$checkinInspection=[pscustomobject]@{failureCode=$null};$inspection=$checkinInspection
$rows=@(foreach($confirmed in @($true,$false)){$explicitlyConfirmed=$confirmed;foreach($expression in $expressions){[pscustomobject]@{confirmed=$confirmed;failure=(& ([scriptblock]::Create($expression)))}}})
$rows | ConvertTo-Json -Compress
`;
  for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
    const rows=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',timeout:30000}));
    assert.equal(rows.length,4);
    for(const row of rows)assert.equal(row.failure||null,row.confirmed?null:'submission_outcome_unknown');
  }
});
