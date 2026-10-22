import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';
import {nativeUnconfirmedSubmission,safeNativeSecurityDiagnostic} from '../src/native-preflight-result.mjs';
import {requiresTrustedDeviceInitialization} from '../src/preflight-policy.mjs';

const execute=promisify(execFile),scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const quote=value=>String(value).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const preamble=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(scripts+'ResultContract.ps1')}'
`;
async function run(shell,command){
  const {stdout}=await execute(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(preamble+command,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:60000});
  return JSON.parse(stdout.trim());
}

for(const shell of shells)test(`submitted native 2FA remains unknown while genuine non-submitted 2FA and private facts survive (${shell})`,async()=>{
  const rows=await run(shell,`
. '${quote(scripts+'Native-PtGuard.ps1')}'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
foreach($name in @('Test-TwoFactorResult','Get-NativeSecurityFacts','Copy-NativeReceiptBindingFields')){
 $definition=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)|Select-Object -First 1
 . ([scriptblock]::Create($definition.Extent.Text))
}
function Invoke-NativePtGate{[pscustomobject]@{allow=$false}}
$rows=@(foreach($attempted in @($true,$false)){
 $script:NativePtGuard=@{managed=$true;attempted=$attempted;profileBinding=('a'*64);accountKey='site-default'}
 $diagnostic=[pscustomobject]@{verificationRoute=$false;otpInputPresent=$true;scopedOtpInputPresent=$true;passwordInputPresent=$false;
  sameOrigin=$true;pageContentAvailable=$true;waf=$false;matchedRules=@('scoped_secondary_input','PRIVATE_RULE');bodyText='PRIVATE_BODY';otp='PRIVATE_CODE'}
 $value=[pscustomobject]@{status='needs_attention';failureCode='two_factor_required';attentionKind='trusted_device_initialization';
  retryableLoginRecovery=$false;submissionAttempted=$attempted;nativeSecurityDiagnostic=$diagnostic}
 $completed=$value|Complete-NativePtResult
 $twoFactor=Test-TwoFactorResult $completed
 $wrapper=Copy-NativeReceiptBindingFields -Result ([pscustomobject]@{status='needs_attention';
  failureCode=if($twoFactor){'two_factor_required'}elseif($completed.submissionAttempted){'submission_outcome_unknown'}else{$completed.failureCode};
  submissionAttempted=$completed.submissionAttempted;attentionKind=$completed.attentionKind;retryableLoginRecovery=$false}) -Source $completed
 [pscustomobject]@{attempted=$attempted;completedFailure=$completed.failureCode;twoFactor=$twoFactor;wrapper=$wrapper;
  noPrivate=((ConvertTo-Json $wrapper -Depth 8 -Compress) -notmatch 'PRIVATE_')}
})
$legacy=[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';attentionKind='trusted_device_initialization';retryableLoginRecovery=$false}
if(Test-TwoFactorResult $legacy){throw 'Legacy unknown was reclassified as 2FA'}
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`);
  for(const row of rows){
    assert.equal(row.noPrivate,true);
    assert.equal(row.completedFailure,row.attempted?'submission_outcome_unknown':'two_factor_required');
    assert.equal(row.twoFactor,!row.attempted);
    const wrapper=row.wrapper,submission=nativeUnconfirmedSubmission(wrapper);
    assert.equal(requiresTrustedDeviceInitialization(wrapper),!row.attempted);
    if(row.attempted){
      assert.equal(submission.failureCode,'submission_outcome_unknown');assert.equal(submission.submissionAttempted,true);
      assert.equal(submission.underlyingFailureCode,'two_factor_required');assert.equal(submission.retryable,false);
      assert.equal(submission.nativeSecurityDiagnostic.scopedOtpInputPresent,true);
    }else assert.equal(submission,null);
    assert.deepEqual(wrapper.nativeSecurityDiagnostic.matchedRules,['scoped_secondary_input']);
    assert.equal('bodyText' in wrapper.nativeSecurityDiagnostic,false);assert.equal('otp' in wrapper.nativeSecurityDiagnostic,false);
  }
});

for(const shell of shells)test(`both real snapshot readers retain the unnamed IYUU input but reject unrelated help/search groups without reading values (${shell})`,async()=>{
  const rows=await run(shell,`
Add-Type @'
namespace SecurityFixture.Automation {
 public class ControlType {
  public string ProgrammaticName;
  public ControlType(string value){ProgrammaticName="ControlType."+value;}
  public static ControlType Edit=new ControlType("Edit");
 }
 public class CurrentInfo {
  public string Name=""; public string AutomationId=""; public ControlType ControlType; public bool IsPassword; public int NativeWindowHandle;
  public string Value {get{AutomationElement.ValueReads++;throw new System.InvalidOperationException("Do not read values");}}
 }
 public class AutomationElement {
  public CurrentInfo Current=new CurrentInfo(); public AutomationElement Parent;
  public AutomationElement[] Descendants=new AutomationElement[0];public static int ValueReads=0;
  public AutomationElement[] FindAll(TreeScope scope,Condition condition){return Descendants;}
 }
 public enum TreeScope{Descendants}
 public class Condition{public static Condition TrueCondition=new Condition();}
 public class TreeWalker{
  public static TreeWalker RawViewWalker=new TreeWalker();public static TreeWalker ControlViewWalker=new TreeWalker();
  public AutomationElement GetParent(AutomationElement element){return element.Parent;}
 }
}
'@
$tokens=$null;$errors=$null
$contractAst=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'ResultContract.ps1')}',[ref]$tokens,[ref]$errors)
$scoped=$contractAst.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-NativeScopedOtpInput'},$true)|Select-Object -First 1
. ([scriptblock]::Create($scoped.Extent.Text.Replace('[System.Windows.Automation.','[SecurityFixture.Automation.')))
function New-Node([string]$Name,[string]$Type){
 $node=[SecurityFixture.Automation.AutomationElement]::new();$node.Current.Name=$Name
 $node.Current.ControlType=if($Type -eq 'Edit'){[SecurityFixture.Automation.ControlType]::Edit}else{[SecurityFixture.Automation.ControlType]::new($Type)}
 return $node
}
function Get-AllAutomationElements{$script:allElements}
function Get-WindowElements{$script:allElements}
function Get-CurrentUri{[uri]$script:currentUrl}
$rows=@(foreach($reader in @('Invoke-PlainWafAccessibility.ps1','Invoke-MainChromeCheckinAccessibility.ps1')){
 $ast=[Management.Automation.Language.Parser]::ParseFile(('${quote(scripts)}'+$reader),[ref]$tokens,[ref]$errors)
 foreach($name in @('Read-PageSnapshot','Get-WindowPageElements','Test-EquivalentWafOrigin','Test-EquivalentOrigin')){
  $definition=$ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)|Select-Object -First 1
  if($definition){. ([scriptblock]::Create($definition.Extent.Text.Replace('[System.Windows.Automation.','[SecurityFixture.Automation.')))}
 }
 foreach($scenario in @('forgot_search','unnamed_iyuu','dataitem7','dataitem8','dataitem_large','dataitem_separate','named_otp','password_route','explicit_prompt','ordinary_captcha','empty_route','separate_tokens','large_container')){
  $originValue='https://piggo.me';$originUri=[uri]$originValue;$targetUri=[uri]($originValue+'/index.php');$script:currentUrl=$targetUri.AbsoluteUri
  $window=New-Node 'Chrome task' 'Window';$window.Current.NativeWindowHandle=42;$taskHandle=[IntPtr]42
  $document=New-Node '网页' 'Document'
  $text=New-Node ('欢迎回来 退出 魔力 [签到得魔力] 忘记二级验证?点击这里自助解绑 site content '*4) 'Text'
  $search=New-Node '' 'Edit';$searchGroup=New-Node '搜索' 'Group';$search.Parent=$searchGroup;$searchGroup.Parent=$document
  $searchText=New-Node '搜索' 'Text';$searchGroup.Descendants=@($search,$searchText)
  $pageElements=@($text,$searchGroup,$search,$searchText)
  $containerCount=$null
  if($scenario -eq 'unnamed_iyuu'){
   $edit=New-Node '' 'Edit';$inner=New-Node '' 'Pane';$group=New-Node '2FA IYUU 二级验证' 'Group'
   $edit.Parent=$inner;$inner.Parent=$group;$group.Parent=$document;$inner.Descendants=@($edit)
   $local=@((New-Node '2FA' 'Text'),(New-Node 'IYUU' 'Text'),(New-Node '二级验证' 'Text'),(New-Node '忘记二级验证?自助解绑' 'Hyperlink'),(New-Node '' 'Group'))
   $group.Descendants=@($inner,$edit)+$local;$pageElements+=@($group)+$group.Descendants
  }
  if($scenario -in @('dataitem7','dataitem8','dataitem_large')){
   $edit=New-Node '' 'Edit';$inner=New-Node '' 'Pane';$group=New-Node '2FA 二级验证' 'DataItem'
   $edit.Parent=$inner;$inner.Parent=$group;$group.Parent=$document;$inner.Descendants=@($edit)
   $local=@((New-Node '2FA' 'Text'),(New-Node '二级验证' 'Text'),(New-Node '' 'Text'),(New-Node '' 'Text'),(New-Node '' 'Text'))
   $group.Descendants=@($inner,$edit)+$local
   if($scenario -eq 'dataitem7'){$group.Current.Name='2FA IYUU 二级验证';$containerCount=$group.Descendants.Count}
   if($scenario -eq 'dataitem8'){
    $outer=New-Node '2FA IYUU 二级验证' 'DataItem';$outer.Parent=$document;$group.Parent=$outer
    $outer.Descendants=@($group)+$group.Descendants;$containerCount=$outer.Descendants.Count;$pageElements+=$outer
   }
   if($scenario -eq 'dataitem_large'){
    $group.Current.Name='2FA IYUU 二级验证';$group.Descendants+=@(1..30|ForEach-Object{New-Node 'layout' 'Text'});$containerCount=$group.Descendants.Count
   }
   $pageElements+=@($group)+$group.Descendants
  }
  if($scenario -eq 'dataitem_separate'){
   $edit=New-Node '' 'Edit';$inner=New-Node '' 'Pane';$group=New-Node '普通输入' 'DataItem'
   $edit.Parent=$inner;$inner.Parent=$group;$group.Parent=$document;$inner.Descendants=@($edit);$group.Descendants=@($inner,$edit)
   $unrelated=New-Node '2FA IYUU 二级验证' 'DataItem';$unrelated.Parent=$document
   $pageElements+=@($group,$inner,$edit,$unrelated)
  }
  if($scenario -eq 'named_otp'){$text.Current.Name='二级验证代码';$edit=New-Node '二级验证代码' 'Edit';$edit.Parent=$document;$pageElements+=$edit}
  if($scenario -eq 'password_route'){$script:currentUrl=$originValue+'/take2fa.php';$edit=New-Node '' 'Edit';$edit.Current.IsPassword=$true;$edit.Parent=$document;$pageElements+=$edit}
  if($scenario -eq 'explicit_prompt'){$text.Current.Name='请输入二级验证代码进行验证'}
  if($scenario -eq 'ordinary_captcha'){$script:currentUrl=$originValue+'/attendance.php';$text.Current.Name='请输入验证码完成签到';$edit=New-Node '验证码' 'Edit';$edit.Parent=$document;$pageElements+=$edit}
  if($scenario -eq 'empty_route'){$script:currentUrl=$originValue+'/take2fa.php';$pageElements=@($text)}
  if($scenario -eq 'separate_tokens'){$pageElements+=(New-Node '2FA IYUU 二级验证' 'Text')}
  if($scenario -eq 'large_container'){
   $large=New-Node '2FA IYUU 二级验证' 'Group';$large.Parent=$document;$searchGroup.Parent=$large
   $large.Descendants=$pageElements+@(1..30|ForEach-Object{New-Node 'layout' 'Text'});$pageElements=@($large)+$large.Descendants
  }
  $document.Descendants=$pageElements;$script:allElements=@($document)+$pageElements
  $snapshot=Read-PageSnapshot $window
  [pscustomobject]@{reader=$reader;scenario=$scenario;security=$snapshot.securityVerification;diagnostic=$snapshot.nativeSecurityDiagnostic;containerCount=$containerCount;
   valueReads=[SecurityFixture.Automation.AutomationElement]::ValueReads;noPrivate=((ConvertTo-Json $snapshot.nativeSecurityDiagnostic -Depth 5 -Compress) -notmatch 'PRIVATE_|Value|bodyText|AutomationId')}
 }
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`);
  for(const row of rows){
    const scoped=['unnamed_iyuu','dataitem7','dataitem8'].includes(row.scenario);
    assert.equal(row.security,scoped||['named_otp','password_route','explicit_prompt'].includes(row.scenario),`${row.reader}/${row.scenario}`);
    assert.equal(row.valueReads,0);assert.equal(row.noPrivate,true);
    assert.equal(row.diagnostic.scopedOtpInputPresent,scoped,`${row.reader}/${row.scenario}`);
    if(scoped){assert.equal(row.diagnostic.otpInputPresent,true);assert.ok(row.diagnostic.matchedRules.includes('scoped_secondary_input'));}
    if(row.scenario==='dataitem7')assert.equal(row.containerCount,7);
    if(row.scenario==='dataitem8')assert.equal(row.containerCount,8);
    if(row.scenario==='dataitem_large')assert.ok(row.containerCount>20);
    if(row.scenario==='password_route')assert.equal(row.diagnostic.passwordInputPresent,true);
  }
});

test('submitted/clicked preflight facts outrank 2FA classification without inventing a write for non-submitted failures',()=>{
  for(const key of ['submissionAttempted','clicked','checkinClicked','checkinClickAttempted']){
    const raw={status:'needs_attention',failureCode:'two_factor_required',attentionKind:'trusted_device_initialization',retryableLoginRecovery:false,[key]:true};
    const result=nativeUnconfirmedSubmission(raw);
    assert.equal(result.failureCode,'submission_outcome_unknown');assert.equal(result.submissionAttempted,true);
    assert.equal(result.underlyingFailureCode,'two_factor_required');assert.equal(requiresTrustedDeviceInitialization(raw),false);
  }
  assert.equal(nativeUnconfirmedSubmission({status:'needs_attention',failureCode:'two_factor_required',submissionAttempted:false}),null);
  assert.equal(requiresTrustedDeviceInitialization({failureCode:'two_factor_required',submissionAttempted:false}),true);
  assert.equal(requiresTrustedDeviceInitialization({failureCode:'submission_outcome_unknown',attentionKind:'trusted_device_initialization',retryableLoginRecovery:false}),false);
  assert.equal(nativeUnconfirmedSubmission({status:'already_signed',submissionAttempted:true}),null);
});

test('security metadata accepts only finite structural facts and the engine preserves submitted status before its 2FA branch',async()=>{
  const raw={verificationRoute:false,otpInputPresent:true,scopedOtpInputPresent:true,passwordInputPresent:false,sameOrigin:true,pageContentAvailable:true,waf:false,
    matchedRules:['scoped_secondary_input','PRIVATE_RULE','scoped_secondary_input'],bodyText:'PRIVATE_BODY',otp:'PRIVATE_CODE'};
  const safe=safeNativeSecurityDiagnostic(raw);
  assert.deepEqual(safe.matchedRules,['scoped_secondary_input']);assert.doesNotMatch(JSON.stringify(safe),/PRIVATE_/);
  assert.equal(safeNativeSecurityDiagnostic({...raw,otpInputPresent:'true'}),null);
  const source=await fs.readFile(scripts+'../src/index.mjs','utf8');
  const start=source.indexOf('const preflight = nativeWafPreflight.get(target.origin);');
  assert.ok(source.indexOf('nativeUnconfirmedSubmission(preflight)',start)<source.indexOf('requiresTrustedDeviceInitialization(preflight)',start));
});
