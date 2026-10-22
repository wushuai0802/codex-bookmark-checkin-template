import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const source=fs.readFileSync(scripts+'Prepare-NativeWafSession.ps1','utf8');
const quote=value=>String(value).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const origin='https://audiences.me',binding='a'.repeat(64),at='2026-10-11T04:00:00.123Z';
const evidence={source:'page_text',authoritative:true,confirmedAt:at,businessDate:'2026-10-11',
  pagePath:'/index.php',statusSignal:'nexus_daily_header_signed',evidenceScope:'site_account_day'};
const receipt={origin,url:origin+'/index.php',status:'already_signed',accountKey:'site-default',profileBinding:binding,
  businessDate:'2026-10-11',observedAt:at,submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',evidence};
const envelope={origin,url:origin+'/index.php',status:'already_signed',accountKey:'site-default',profileBinding:binding,
  submissionAttempted:false,evidence,readbackReceipt:receipt,nativeReadback:{stage:'completed',code:'receipt_accepted',
    exitCode:0,durationMs:0,stderrPresent:false,stderrBytes:0},reason:'PRIVATE_READ_REASON'};
const fromJson=value=>`([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json)`;
const harness=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(scripts+'Native-PtGuard.ps1')}'
$tokens=$null;$errors=$null
$script:preflightAst=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Preflight parse failed'}
foreach($name in @('Convert-NativeChildReceipt','New-NativeChildTransportFailure','Get-NativeSecurityFacts','Test-NativePostActionReceipt','Invoke-NativePostActionReadback','Test-TwoFactorResult','Copy-NativeReceiptBindingFields')){
 $definition=$script:preflightAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)|Select-Object -First 1
 if(-not $definition){throw 'Required post-action function missing'}
 . ([scriptblock]::Create($definition.Extent.Text))
}
function Reset-Fixture {
 $script:fixtureNow=[datetimeoffset]'2026-10-11T04:00:10.500Z'
 $script:profile='D:\\fixture\\data\\shared';$script:root='D:\\fixture';$script:origin='${origin}';$script:url=$origin+'/attendance.php'
 $script:config=[pscustomobject]@{ptReadOnlyPolicies=[pscustomobject]@{'${origin}'=[pscustomobject]@{reviewed=$true;nativeApiHeaderFallback=$true}}}
 $script:NativePtGuard=@{managed=$true;mainProfile=$false;origin=$origin;url=$url;profile=$profile;profileBinding=('a'*64);accountKey='site-default'}
 $script:child=[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;
  nativeGate=$true;profileBinding=('a'*64);accountKey='site-default';retryable=$false;retryCause='native_readback_unavailable';
  checkinClickAttempted=$true;checkinClicked=$true;reason='original unknown';inspection=[pscustomobject]@{bodyText='PRIVATE_CHILD_TEXT'}}
 $script:readback=${fromJson(envelope)}
 $script:confirmation=[pscustomobject]@{status='already_signed';accountKey='site-default';profileBinding=('a'*64);
  submissionAttempted=$false;evidence=${fromJson(evidence)}}
 $script:registration=[pscustomobject]@{allow=$true;receiptAccepted=$true;submissionAttempted=$false;profileBinding=('a'*64);accountKey='site-default'}
 $script:events=[Collections.Generic.List[string]]::new();$script:reads=0;$script:registers=0;$script:inspects=0;$script:actions=0
 $script:diagnostics=[Collections.Generic.List[object]]::new()
 $script:scenario='success';$script:chromePresent=$false
}
function Invoke-MainChromeReadOnlyFallbackResult([string]$Origin,[int]$TimeoutSeconds,[bool]$UseMain=$true){
 $script:reads++;$script:events.Add('readonly')
 if($UseMain -or $Origin -cne $script:origin){throw 'Wrong readonly route'}
 if($script:scenario -eq 'read_throw'){throw 'PRIVATE read failure'}
 if($script:scenario -eq 'read_false'){return $false}
 if($script:scenario -eq 'read_null'){return $null}
 return $script:readback
}
function Register-NativePtReadback($Result){
 $script:registers++;$script:events.Add('register')
 if($script:scenario -eq 'register_throw'){throw 'PRIVATE save failure'}
 return $script:registration
}
function Initialize-NativePtGuard {param($Root,$Origin,$Url,$ProfilePath,[switch]$MainProfile,[switch]$ReadOnly)
 $script:inspects++;$script:events.Add('inspect')
 if($MainProfile -or $ReadOnly -or $ProfilePath -cne $script:profile){throw 'Wrong gate route'}
 if($script:scenario -eq 'inspect_throw'){throw 'PRIVATE inspect failure'}
 return $script:confirmation
}
function Start-NativePtWrite{$script:actions++;throw 'Post-action confirmation must not write'}
function Invoke-MainChromeFallbackResult{$script:actions++;throw 'Must not use another Profile'}
function Write-NativeChildTransportDiagnostic([string]$Origin,$Diagnostic){$script:diagnostics.Add($Diagnostic)}
function Write-NativeSecurityDiagnostic { }
function Invoke-FixturePostAction {
 Invoke-NativePostActionReadback -Child $script:child -Origin $script:origin -Url $script:url -ProfilePath $script:profile -TimeoutSeconds 35 -Clock {$script:fixtureNow}
}
`;
function run(shell,command){
  try{return JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(harness+command,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:60_000,maxBuffer:200_000,stdio:['ignore','pipe','pipe']}).trim().replace(/^\uFEFF/,''));}
  catch(error){throw new Error(`${shell} fixture failed: ${String(error.stderr??'').slice(0,1200)}`);}
}

for(const shell of shells)test(`same-run post-action receipt closes once after persistence while preserving the real submitted action (${shell})`,()=>{
  const rows=run(shell,`$rows=@(foreach($kind in @('current','older_inspect')){
 Reset-Fixture
 if($kind -eq 'older_inspect'){$script:confirmation.evidence.confirmedAt='2026-10-11T03:59:30.123Z';$script:confirmation.evidence.pagePath='/attendance.php';$script:confirmation.evidence.statusSignal='same_day_page_text'}
 $result=Invoke-FixturePostAction
 $repeat=Invoke-NativePostActionReadback -Child $result -Origin $origin -Url $url -ProfilePath $profile -TimeoutSeconds 35 -Clock {$script:fixtureNow}
 $originalRepeat=Invoke-FixturePostAction
 [pscustomobject]@{kind=$kind;result=$result;reads=$reads;registers=$registers;inspects=$inspects;actions=$actions;events=@($events.ToArray());
  repeatStatus=$repeat.status;originalRepeatStatus=$originalRepeat.status;originalFailure=$child.failureCode;
  noPrivate=((ConvertTo-Json $result -Depth 8 -Compress) -notmatch 'PRIVATE_');
  hasFailure=($null -ne $result.PSObject.Properties['failureCode']);hasRetryCause=($null -ne $result.PSObject.Properties['retryCause'])}
});ConvertTo-Json -InputObject $rows -Depth 9 -Compress`);
  for(const row of rows){assert.equal(row.result.status,'already_signed');assert.equal(row.result.submissionAttempted,true);
    assert.equal(row.result.nativeGate,true);assert.equal(row.result.confirmationState,'confirmed');assert.equal(row.result.evidence.authoritative,true);
    assert.equal(Date.parse(row.result.evidence.confirmedAt),Date.parse(at));assert.equal(row.result.evidence.pagePath,'/index.php');
    assert.equal(row.reads,1);assert.equal(row.registers,1);assert.equal(row.inspects,1);assert.equal(row.actions,0);
    assert.deepEqual(row.events,['readonly','register','inspect']);assert.equal(row.repeatStatus,'already_signed');
    assert.equal(row.originalFailure,'submission_outcome_unknown');assert.equal(row.noPrivate,true);
    assert.equal(row.hasFailure,false);assert.equal(row.hasRetryCause,false);
  }
});

for(const shell of shells)test(`invalid opt-in, wrong child identity and non-submitted actions never start a post-action read (${shell})`,()=>{
  const rows=run(shell,`$rows=@(foreach($caseName in @('no_policy','not_reviewed','no_fallback','string_fallback','not_submitted','string_submitted','already_confirmed',
 'known_failure','wrong_child_profile','wrong_child_account','wrong_child_origin','wrong_guard_origin','main_guard','wrong_guard_profile')){
 Reset-Fixture;$script:scenario=$caseName
 switch($caseName){
 'no_policy'{$config.ptReadOnlyPolicies=$null}
 'not_reviewed'{$config.ptReadOnlyPolicies.'${origin}'.reviewed=$false}
 'no_fallback'{$config.ptReadOnlyPolicies.'${origin}'.nativeApiHeaderFallback=$false}
 'string_fallback'{$config.ptReadOnlyPolicies.'${origin}'.nativeApiHeaderFallback='true'}
 'not_submitted'{$child.submissionAttempted=$false}
 'string_submitted'{$child.submissionAttempted='true'}
 'already_confirmed'{$child.status='already_signed';$child.failureCode=$null}
 'known_failure'{$child.failureCode='two_factor_required'}
 'wrong_child_profile'{$child.profileBinding=('b'*64)}
 'wrong_child_account'{$child.accountKey='different'}
 'wrong_child_origin'{$child|Add-Member origin 'https://foreign.example'}
 'wrong_guard_origin'{$script:NativePtGuard.origin='https://foreign.example'}
 'main_guard'{$script:NativePtGuard.mainProfile=$true}
 'wrong_guard_profile'{$script:NativePtGuard.profile='D:\\fixture\\data\\another'}
 }
 $result=Invoke-FixturePostAction
 [pscustomobject]@{scenario=$caseName;same=[object]::ReferenceEquals($result,$child);reads=$reads;registers=$registers;inspects=$inspects;actions=$actions}
});ConvertTo-Json -InputObject $rows -Compress`);
  for(const row of rows){assert.equal(row.same,true,row.scenario);assert.equal(row.reads,0,row.scenario);assert.equal(row.registers,0);
    assert.equal(row.inspects,0);assert.equal(row.actions,0);}
});

for(const shell of shells)test(`a parent transport marker allows only a completely absent child identity and rejects existing wrong fields (${shell})`,()=>{
  const rows=run(shell,`$rows=@(foreach($caseName in @('marked','unmarked','string_marker','no_diagnostic','wrong_origin','empty_origin','wrong_profile','wrong_account','empty_profile','empty_account')){
 Reset-Fixture
 $script:child=[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;
  nativeChildResultUnavailable=$true;diagnosticStage='native_child_decode';nativeChildDiagnostic=[pscustomobject]@{stage='decode';code='invalid_json'}}
 switch($caseName){
  'unmarked'{$child.nativeChildResultUnavailable=$false}
  'string_marker'{$child.nativeChildResultUnavailable='true'}
  'no_diagnostic'{$child.nativeChildDiagnostic=$null}
  'wrong_origin'{$child|Add-Member origin 'https://foreign.example'}
  'empty_origin'{$child|Add-Member origin ''}
  'wrong_profile'{$child|Add-Member profileBinding ('b'*64)}
  'wrong_account'{$child|Add-Member accountKey 'different'}
  'empty_profile'{$child|Add-Member profileBinding ''}
  'empty_account'{$child|Add-Member accountKey ''}
 }
 $result=Invoke-FixturePostAction
 [pscustomobject]@{scenario=$caseName;status=$result.status;reads=$reads;registers=$registers;actions=$actions;
  sourceProfileAbsent=($null -eq $child.PSObject.Properties['profileBinding']);sourceAccountAbsent=($null -eq $child.PSObject.Properties['accountKey'])}
});ConvertTo-Json -InputObject $rows -Compress`);
  for(const row of rows){
    const allowed=row.scenario==='marked';
    assert.equal(row.status,allowed?'already_signed':'needs_attention',row.scenario);
    assert.equal(row.reads,allowed?1:0,row.scenario);assert.equal(row.registers,allowed?1:0);assert.equal(row.actions,0);
    if(allowed){assert.equal(row.sourceProfileAbsent,true);assert.equal(row.sourceAccountAbsent,true);}
  }
});

for(const shell of shells)test(`real PowerShell malformed or missing child stdout gets one passive read and never a second submit (${shell})`,()=>{
  const childScripts={
    invalid_json:"[Console]::WriteLine('{BROKEN PRIVATE_BODY}');exit 2",
    mixed_output:`[Console]::WriteLine('PRIVATE_STDOUT');[Console]::WriteLine('{"status":"already_signed"}');exit 2`,
    missing_output:'exit 2',
    double_json:`[Console]::WriteLine('{"status":"already_signed"}');[Console]::WriteLine('{"status":"already_signed"}');exit 2`,
  };
  const childCases=Object.entries(childScripts).map(([kind,body])=>`'${kind}' {'${Buffer.from(body,'utf16le').toString('base64')}'}`).join('\n');
  const rows=run(shell,`
$script:fixtureChildShell='${quote(shell)}'
function Get-Process{[pscustomobject]@{Path='Invoke-FixtureNativeChild'}}
function Invoke-FixtureNativeChild{
 $script:actions++;$script:events.Add('child-submit');$script:chromePresent=$true
 if($script:stdoutKind -eq 'transport_throw'){throw [InvalidOperationException]::new('PRIVATE transport failure')}
 $encoded=switch($script:stdoutKind){${childCases}}
 & $script:fixtureChildShell -NoProfile -NonInteractive -EncodedCommand $encoded
}
function Get-AutomationChromeProcesses{if($script:chromePresent){[pscustomobject]@{ProcessId=42;Count=1}}}
function Close-AutomationChrome{$script:events.Add('close');$script:chromePresent=$false}
$branch=$preflightAst.FindAll({param($node)$node -is [Management.Automation.Language.IfStatementAst] -and
 $node.Clauses[0].Item1.Extent.Text.Contains('$item.action') -and $node.Extent.Text.Contains('Invoke-NativePostActionReadback')},$true)|Select-Object -First 1
$body=$branch.Clauses[0].Item2.Extent.Text;$body=$body.Substring(1,$body.Length-2)
$body=$body.Replace('(Join-Path $PSScriptRoot ''Invoke-PlainWafAccessibility.ps1'')','''fixture-native-child''')
$rows=@(foreach($stdoutKind in @('invalid_json','mixed_output','missing_output','double_json','transport_throw')){foreach($outcome in @('confirmed','unsigned','save_denied')){
 Reset-Fixture;$script:stdoutKind=$stdoutKind
 $script:fixtureNow=[datetimeoffset]::UtcNow;$day=$fixtureNow.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
 foreach($value in @($readback,$readback.readbackReceipt,$confirmation)){$value.evidence.confirmedAt=$fixtureNow.ToString('o');$value.evidence.businessDate=$day}
 $readback.readbackReceipt.businessDate=$day;$readback.readbackReceipt.observedAt=$fixtureNow.ToString('o')
 if($outcome -eq 'unsigned'){$readback.status='not_signed';$readback.readbackReceipt.status='not_signed'}
 if($outcome -eq 'save_denied'){$registration.allow=$false;$registration.receiptAccepted=$false}
 $item=[pscustomobject]@{action='checkin';waitSeconds=35;windowMode='offscreen'};$autoClickTurnstile=@{};$preflightResults=@();$profilePath=$profile
 . ([scriptblock]::Create('foreach($once in @(1)){'+$body+'}'))
 $result=$preflightResults[0]
 $repeat=Invoke-NativePostActionReadback -Child $result -Origin $origin -Url $url -ProfilePath $profile -TimeoutSeconds 35 -Clock {$script:fixtureNow}
 [pscustomobject]@{stdoutKind=$stdoutKind;outcome=$outcome;status=$result.status;failure=$result.failureCode;submitted=$result.submissionAttempted;
  profile=$result.profileBinding;account=$result.accountKey;actions=$actions;reads=$reads;registers=$registers;inspects=$inspects;
  resultUnavailable=$result.nativeChildResultUnavailable;diagnostic=$result.nativeChildDiagnostic;recorded=@($diagnostics.ToArray());
  noPrivate=((ConvertTo-Json $result -Depth 8 -Compress) -notmatch 'PRIVATE_')}
}})
ConvertTo-Json -InputObject $rows -Depth 9 -Compress`);
  for(const row of rows){
    const confirmed=row.outcome==='confirmed';
    assert.equal(row.status,confirmed?'already_signed':'needs_attention',`${row.stdoutKind}/${row.outcome}`);
    assert.equal(row.submitted,true);assert.equal(row.actions,1,`${row.stdoutKind}/${row.outcome}`);assert.equal(row.reads,1);
    assert.equal(row.registers,row.outcome==='unsigned'?0:1);assert.equal(row.inspects,confirmed?1:0);
    assert.equal(row.resultUnavailable,true);assert.equal(row.noPrivate,true);
    const transport=row.stdoutKind==='transport_throw';
    assert.equal(row.diagnostic.stage,transport?'transport':'decode');assert.equal(row.diagnostic.exitCode,transport?null:2);assert.equal(row.recorded.length,1);
    assert.equal(row.diagnostic.stdoutCaptureComplete,!transport);
    assert.deepEqual(row.recorded[0],row.diagnostic);
    assert.equal(row.diagnostic.code,transport?'child_command_failed':row.stdoutKind==='missing_output'?'receipt_missing':row.stdoutKind==='mixed_output'?'invalid_receipt':'invalid_json');
    if(confirmed){assert.equal(row.profile,binding);assert.equal(row.account,'site-default');}
    else{assert.equal(row.failure,'submission_outcome_unknown');assert.equal(row.profile,null);assert.equal(row.account,null);}
  }
});

for(const shell of shells)test(`failed, stale, cross-account, redirected or submitted reads retain unknown and cannot register (${shell})`,()=>{
  const rows=run(shell,`$rows=@(foreach($caseName in @('read_throw','read_false','read_null','not_signed','login','waf','wrong_profile','wrong_account','wrong_origin','wrong_url',
 'nested_profile','nested_origin','read_submitted','nested_submitted','read_clicked','nested_clicked','no_receipt','untrusted','string_authority','old_day','stale','future','bad_timestamp','wrong_scope','wrong_mode','observed_stale','different_receipt_time')){
 Reset-Fixture;$script:scenario=$caseName
 switch($caseName){
 'not_signed'{$readback.status='not_signed';$readback.readbackReceipt.status='not_signed'}
 'login'{$readback.status='login_required'}
 'waf'{$readback.status='managed_challenge'}
 'wrong_profile'{$readback.profileBinding=('b'*64)}
 'wrong_account'{$readback.accountKey='different'}
 'wrong_origin'{$readback.origin='https://foreign.example'}
 'wrong_url'{$readback.url=$origin+'/attendance.php'}
 'nested_profile'{$readback.readbackReceipt.profileBinding=('b'*64)}
 'nested_origin'{$readback.readbackReceipt.origin='https://foreign.example'}
 'read_submitted'{$readback.submissionAttempted=$true}
 'nested_submitted'{$readback.readbackReceipt.submissionAttempted=$true}
 'read_clicked'{$readback|Add-Member clicked $true}
 'nested_clicked'{$readback.readbackReceipt|Add-Member checkinClickAttempted $true}
 'no_receipt'{$readback.readbackReceipt=$null}
 'untrusted'{$readback.evidence.authoritative=$false}
 'string_authority'{$readback.evidence.authoritative='true'}
 'old_day'{$readback.evidence.confirmedAt='2026-10-10T04:00:00Z';$readback.evidence.businessDate='2026-10-10'}
 'stale'{$readback.evidence.confirmedAt='2026-10-11T03:55:00Z'}
 'future'{$readback.evidence.confirmedAt='2026-10-11T04:00:11Z'}
 'bad_timestamp'{$readback.evidence.confirmedAt='invalid'}
 'wrong_scope'{$readback.readbackReceipt.evidence.evidenceScope='unreviewed'}
 'wrong_mode'{$readback.readbackReceipt.operationMode='legacy_checkin'}
 'observed_stale'{$readback.readbackReceipt.observedAt='2026-10-11T03:55:00Z'}
 'different_receipt_time'{$readback.readbackReceipt.evidence.confirmedAt='2026-10-11T04:00:01Z'}
 }
 $first=Invoke-FixturePostAction;$second=Invoke-FixturePostAction
 [pscustomobject]@{scenario=$caseName;status=$first.status;failure=$first.failureCode;submitted=$first.submissionAttempted;
  same=[object]::ReferenceEquals($first,$child);reads=$reads;registers=$registers;inspects=$inspects;actions=$actions}
});ConvertTo-Json -InputObject $rows -Compress`);
  for(const row of rows){assert.equal(row.status,'needs_attention',row.scenario);assert.equal(row.failure,'submission_outcome_unknown');
    assert.equal(row.submitted,true);assert.equal(row.same,true);assert.equal(row.reads,1);assert.equal(row.registers,0);
    assert.equal(row.inspects,0);assert.equal(row.actions,0);}
});

for(const shell of shells)test(`receipt registration or gate persistence failures never convert unknown to success (${shell})`,()=>{
  const rows=run(shell,`$rows=@(foreach($caseName in @('register_throw','register_denied','register_missing_ack','register_wrong_profile','register_submitted',
 'inspect_throw','inspect_missing','inspect_unknown','inspect_submitted','inspect_wrong_profile','inspect_wrong_account','inspect_wrong_origin','inspect_untrusted','inspect_old')){
 Reset-Fixture;$script:scenario=$caseName
 switch($caseName){
 'register_denied'{$registration.allow=$false}
 'register_missing_ack'{$registration.receiptAccepted=$false}
 'register_wrong_profile'{$registration.profileBinding=('b'*64)}
 'register_submitted'{$registration.submissionAttempted=$true}
 'inspect_missing'{$script:confirmation=$null}
 'inspect_unknown'{$confirmation.status='needs_attention'}
 'inspect_submitted'{$confirmation.submissionAttempted=$true}
 'inspect_wrong_profile'{$confirmation.profileBinding=('b'*64)}
 'inspect_wrong_account'{$confirmation.accountKey='different'}
 'inspect_wrong_origin'{$confirmation|Add-Member origin 'https://foreign.example'}
 'inspect_untrusted'{$confirmation.evidence.authoritative=$false}
 'inspect_old'{$confirmation.evidence.confirmedAt='2026-10-11T03:55:00Z'}
 }
 $result=Invoke-FixturePostAction
 [pscustomobject]@{scenario=$caseName;status=$result.status;failure=$result.failureCode;submitted=$result.submissionAttempted;
  reads=$reads;registers=$registers;inspects=$inspects;actions=$actions}
});ConvertTo-Json -InputObject $rows -Compress`);
  for(const row of rows){assert.equal(row.status,'needs_attention',row.scenario);assert.equal(row.failure,'submission_outcome_unknown');
    assert.equal(row.submitted,true);assert.equal(row.reads,1);assert.equal(row.registers,1);assert.equal(row.actions,0);
    assert.equal(row.inspects,row.scenario.startsWith('register')?0:1);}
});

for(const shell of shells)test(`actual action branch closes its child before one readonly confirmation and exits before another submit (${shell})`,()=>{
  const result=run(shell,`Reset-Fixture
$script:fixtureNow=[datetimeoffset]::UtcNow;$day=$fixtureNow.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
foreach($value in @($readback,$readback.readbackReceipt,$confirmation)){$value.evidence.confirmedAt=$fixtureNow.ToString('o');$value.evidence.businessDate=$day}
$readback.readbackReceipt.businessDate=$day;$readback.readbackReceipt.observedAt=$fixtureNow.ToString('o')
$item=[pscustomobject]@{action='checkin';waitSeconds=35;windowMode='offscreen'};$autoClickTurnstile=@{};$preflightResults=@()
$profilePath=$profile
function Get-Process{[pscustomobject]@{Path='Invoke-FixtureNativeChild'}}
function Invoke-FixtureNativeChild{
 if('-PerformCheckin' -notin $args){throw 'Missing mature child action'}
 $script:actions++;$script:events.Add('child-submit');$script:chromePresent=$true
 $script:child|ConvertTo-Json -Depth 6 -Compress
}
function Get-AutomationChromeProcesses{if($script:chromePresent){[pscustomobject]@{ProcessId=42;Count=1}}}
function Close-AutomationChrome{$script:events.Add('close');$script:chromePresent=$false}
$branch=$preflightAst.FindAll({param($node)$node -is [Management.Automation.Language.IfStatementAst] -and
 $node.Clauses[0].Item1.Extent.Text.Contains('$item.action') -and $node.Extent.Text.Contains('Invoke-PlainWafAccessibility.ps1') -and
 $node.Extent.Text.Contains('Invoke-NativePostActionReadback')},$true)|Select-Object -First 1
if(-not $branch){throw 'Action hook is missing'}
$body=$branch.Clauses[0].Item2.Extent.Text;$body=$body.Substring(1,$body.Length-2)
$body=$body.Replace('(Join-Path $PSScriptRoot ''Invoke-PlainWafAccessibility.ps1'')','''fixture-native-child''')
. ([scriptblock]::Create('foreach($once in @(1)){'+$body+'}'))
[pscustomobject]@{results=$preflightResults;events=@($events.ToArray());actions=$actions;reads=$reads;registers=$registers;inspects=$inspects;
 noPrivate=((ConvertTo-Json $preflightResults -Depth 8 -Compress) -notmatch 'PRIVATE_')}|ConvertTo-Json -Depth 9 -Compress`);
  assert.equal(result.results.length,1);assert.equal(result.results[0].status,'already_signed',JSON.stringify({events:result.events,reads:result.reads,registers:result.registers,inspects:result.inspects,actions:result.actions}));assert.equal(result.results[0].submissionAttempted,true);
  assert.deepEqual(result.events,['child-submit','close','readonly','register','inspect']);assert.equal(result.actions,1);
  assert.equal(result.reads,1);assert.equal(result.registers,1);assert.equal(result.inspects,1);assert.equal(result.noPrivate,true);
});

test('the production hook is after child cleanup and before nativeGate early exit without introducing another action',()=>{
  const start=source.indexOf("if ([string]$item.action -eq 'checkin') {"),hook=source.indexOf('$checkinInspection = Invoke-NativePostActionReadback',start);
  const cleanup=source.indexOf('finally { if ((Get-AutomationChromeProcesses).Count -gt 0) { Close-AutomationChrome } }',start);
  const early=source.indexOf('if ($checkinInspection.nativeGate -eq $true)',start);
  assert.ok(start>=0&&cleanup>start&&hook>cleanup&&early>hook);
  const fn=source.slice(source.indexOf('function Invoke-NativePostActionReadback'),source.indexOf('function Close-AutomationChrome'));
  assert.match(fn,/Invoke-MainChromeReadOnlyFallbackResult \$Origin \$TimeoutSeconds \$false/);
  assert.doesNotMatch(fn,/Start-NativePtWrite|PerformCheckin|Invoke-MainChromeFallbackResult|Notification|Notify|Telegram/);
});
