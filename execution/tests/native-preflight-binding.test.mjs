import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../scripts/Prepare-NativeWafSession.ps1',import.meta.url));
const quote=value=>String(value).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];

for(const shell of shells)test(`all five actual native preflight wrappers preserve only bound child receipt metadata (${shell})`,()=>{
  const source=fs.readFileSync(script,'utf8');
  assert.equal((source.match(/\$preflightResults \+= Copy-NativeReceiptBindingFields -Result/g)??[]).length,5);
  const command=`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(script)}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Preflight parse failed'}
$function=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Copy-NativeReceiptBindingFields'},$true)[0]
. ([scriptblock]::Create($function.Extent.Text))
$wrappers=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and
  $n.Left -is [Management.Automation.Language.VariableExpressionAst] -and $n.Left.VariablePath.UserPath -eq 'preflightResults' -and
  $n.Right.Extent.Text -match '^Copy-NativeReceiptBindingFields'},$true) | Sort-Object { $_.Extent.StartOffset })
if($wrappers.Count -ne 5){throw 'Every wrapping branch must propagate receipt bindings'}
function New-FixtureReceipt([string]$Mark,[string]$Scenario){
  if($Scenario -eq 'missing'){return $null}
  $value=[pscustomobject]@{status='signed';reason='fixture';submissionAttempted=$true;
    evidence=[pscustomobject]@{source='page_text';authoritative=$true;businessDate='2026-10-08';pagePath='/attendance.php'}}
  if($Scenario -eq 'bound'){
    $value|Add-Member profileBinding ($Mark * 64)
    $value|Add-Member accountKey 'site-default'
    $value|Add-Member operationMode 'safe_history_page'
    $value|Add-Member readSafety 'reviewed_passive'
  }elseif($Scenario -eq 'invalid'){
    $value|Add-Member profileBinding 'not-a-profile-binding'
    $value|Add-Member accountKey 'wrong-account'
    $value|Add-Member operationMode 'submit'
    $value|Add-Member readSafety 'unchecked'
  }
  return $value
}
$origin='https://native.example';$url=$origin+'/attendance.php'
$fallbackEntry=[pscustomobject]@{url=$url};$item=[pscustomobject]@{trustAsSigned=$false}
$confirmed=$true;$mainConfirmed=$true;$explicitlyConfirmed=$true
$twoFactorRequired=$false;$mainTwoFactorRequired=$false;$passiveTwoFactorRequired=$false
$submissionAttempted=$true;$mainSubmissionAttempted=$true
$passivePrepared=$true;$preparedOnly=$false;$prepared=$false;$endpointConfirmed=$false
$rows=@(foreach($scenario in @('bound','legacy','invalid','missing')){
  $checkinInspection=New-FixtureReceipt 'a' $scenario
  $mainInspection=New-FixtureReceipt 'b' $scenario
  $passiveInspection=New-FixtureReceipt 'c' $scenario
  $inspection=New-FixtureReceipt 'd' $scenario
  $index=0
  foreach($wrapper in $wrappers){
    $preflightResults=@()
    . ([scriptblock]::Create($wrapper.Extent.Text))
    if($preflightResults.Count -ne 1){throw 'Receipt wrapper must emit exactly one result'}
    $value=$preflightResults[0]
    [pscustomobject]@{scenario=$scenario;branch=$index;status=$value.status;submitted=$value.submissionAttempted;
      binding=$value.profileBinding;account=$value.accountKey;mode=$value.operationMode;safety=$value.readSafety;
      evidenceAuthoritative=$value.evidence.authoritative;pagePath=$value.evidence.pagePath}
    $index++
  }
})
ConvertTo-Json -InputObject $rows -Depth 6 -Compress
`;
  const rows=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000}));
  assert.equal(rows.length,20);
  for(const row of rows){
    const label=`${shell}/${row.scenario}/${row.branch}`;
    if(row.scenario==='bound'){
      assert.equal(row.binding,['a','b','b','c','d'][row.branch].repeat(64),label);
      assert.equal(row.account,'site-default',label);assert.equal(row.mode,'safe_history_page',label);
      assert.equal(row.safety,'reviewed_passive',label);assert.equal(row.evidenceAuthoritative,true,label);
      assert.equal(row.pagePath,'/attendance.php',label);
    }else{
      assert.equal(row.binding,null,label);assert.equal(row.account,null,label);
      assert.equal(row.mode,null,label);assert.equal(row.safety,null,label);
    }
    assert.equal(row.submitted,true,label);
  }
});
