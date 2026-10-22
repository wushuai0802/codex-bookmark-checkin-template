import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

// Execute the actual parent AST and a tiny synthetic child process. No browser,
// real vault, saved credentials, controller lease or check-in endpoint is used.
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const quote=value=>String(value).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const origin='https://piggo.me', binding='a'.repeat(64);

function run(t,shell,command) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-2fa-parent-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  fs.mkdirSync(path.join(root,'data','profile'),{recursive:true});
  fs.writeFileSync(path.join(root,'scripts','Recover-NativePtTwoFactor.mjs'),`
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input);if(request.origin!=='${origin}'||process.argv[2]!=='--root'||process.argv[3]!==root)throw Error('fixture request');
const settings=JSON.parse(fs.readFileSync(path.join(root,'settings.json'),'utf8'));
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({event:'recover',binding:request.expectedProfileBinding,
  typedOtp:typeof request.nativeDiagnostic.nativeSecurityDiagnostic.otpInputPresent==='boolean'})+'\\n');
fs.appendFileSync(path.join(root,'events.jsonl'),JSON.stringify('recover')+'\\n');
if(settings.transport==='mixed')process.stdout.write('PRIVATE_SYNTHETIC_STDOUT\\n');
if(settings.transport==='missing'){}else{process.stdout.write(JSON.stringify(settings.response)+'\\n');}
if(settings.transport==='double')process.stdout.write(JSON.stringify(settings.response)+'\\n');
if(settings.transport!=='valid')process.stderr.write('PRIVATE_SYNTHETIC_STDERR');
`);
  const harness=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$script:root='${quote(root)}';$script:fixtureScripts=Join-Path $root 'scripts';$script:node='${quote(process.execPath)}'
. '${quote(path.join(scripts,'Native-PtGuard.ps1'))}'
$tokens=$null;$errors=$null
$script:parentAst=[Management.Automation.Language.Parser]::ParseFile('${quote(path.join(scripts,'Prepare-NativeWafSession.ps1'))}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Parent syntax invalid'}
foreach($definition in $parentAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){
 . ([scriptblock]::Create($definition.Extent.Text.Replace('$PSScriptRoot','$script:fixtureScripts')))
}
function Add-FixtureEvent([string]$Value){
 [IO.File]::AppendAllText((Join-Path $root 'events.jsonl'),(($Value|ConvertTo-Json -Compress)+[Environment]::NewLine))
}
function Reset-Fixture {
 foreach($name in @('events.jsonl','calls.jsonl')){if(Test-Path -LiteralPath (Join-Path $root $name)){Remove-Item -LiteralPath (Join-Path $root $name)}}
 $script:profile=Join-Path $root 'data/profile';$script:profilePath=$profile
 $script:origin='${origin}';$script:url=$origin+'/attendance.php'
 $script:config=[pscustomobject]@{powershellExecutable='Invoke-FixtureProbe';nativePtTwoFactorRecovery=[pscustomobject]@{
 '${origin}'=[pscustomobject]@{enabled=$true;reviewed=$true;provider='bitwarden'}}}
 $script:NativePtGuard=@{managed=$true;mainProfile=$false;root=$root;origin=$origin;url=$url;profile=$profile;
  profileBinding=('a'*64);accountKey='site-default';readOnly=$false}
 $script:child=[pscustomobject]@{origin=$origin;url=$url;status='needs_attention';accountKey='site-default';profileBinding=('a'*64);
  failureCode='submission_outcome_unknown';underlyingFailureCode='two_factor_required';submissionAttempted=$true;retryable=$false;
  nativeSecurityDiagnostic=[pscustomobject]@{verificationRoute=$false;otpInputPresent=$true;scopedOtpInputPresent=$true;
   passwordInputPresent=$false;sameOrigin=$true;pageContentAvailable=$true;waf=$false;matchedRules=@('scoped_secondary_input')}}
 $script:now=[datetimeoffset]::UtcNow;$script:at=$now.AddSeconds(-1).ToString('o');$script:day=$now.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')
 $script:receipt=[pscustomobject]@{origin=$origin;url=$origin+'/index.php';status='not_signed';accountKey='site-default';
  profileBinding=('a'*64);businessDate=$day;observedAt=$at;submissionAttempted=$false;operationMode='safe_history_page';readSafety='reviewed_passive';
  evidence=[pscustomobject]@{source='page_text';authoritative=$true;confirmedAt=$at;businessDate=$day;pagePath='/index.php';
   statusSignal='nexus_daily_header_unsigned';evidenceScope='site_account_day'};
  inspection=[pscustomobject]@{currentUrl=$origin+'/index.php';sameOrigin=$true;authenticated=$true;pageContentAvailable=$true;
   siteBodyLoaded=$true;waf=$false;loginRoute=$false;securityVerification=$false;successControl='';unsignedControl='签到';
   signedControlCount=0;unsignedControlCount=1}}
 $script:reopened=($receipt|ConvertTo-Json -Depth 9 -Compress)|ConvertFrom-Json
 $reopened|Add-Member -NotePropertyName nativeSecurityDiagnostic -NotePropertyValue ([pscustomobject]@{verificationRoute=$false;otpInputPresent=$false;
  scopedOtpInputPresent=$false;passwordInputPresent=$false;sameOrigin=$true;pageContentAvailable=$true;waf=$false;matchedRules=@()})
 $script:meta=[pscustomobject]@{attempted=$true;accepted=$true;reason='authentication_accepted'}
 $script:registration=[pscustomobject]@{allow=$true;receiptAccepted=$true;submissionAttempted=$false;
  profileBinding=('a'*64);accountKey='site-default'}
 $script:fixtureDecision=$null;$script:transport='valid';$script:registers=0;$script:inspects=0;$script:mature=0;$script:probes=0
 $script:chromepresent=$false;$script:entryGate=$false;$script:nativeTwoFactorRecoveryInvoked=$null
 $script:guardRejectReceipt=$false;$script:earlySignedProbe=$false
 $script:initialUnknown=[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;profileBinding=('a'*64);accountKey='site-default'}
 $script:fakeSettings=[pscustomobject]@{transport='valid';response=$null}
}
function Save-FixtureResponse {
 $script:fakeSettings.transport=$script:transport
 $script:fakeSettings.response=[pscustomobject]@{nativeTwoFactorRecovery=$meta;readbackReceipt=$receipt}
 [IO.File]::WriteAllText((Join-Path $root 'settings.json'),(ConvertTo-Json $fakeSettings -Depth 9 -Compress),[Text.UTF8Encoding]::new($false))
}
function Register-NativePtReadback($Result){
 $script:registers++;Add-FixtureEvent 'register'
 # The real gate's URL/day/freshness/proof validation is covered by its suite.
 # Simulate its rejection ack here, then prove the parent honors that decision.
 if($script:guardRejectReceipt){return [pscustomobject]@{allow=$false;receiptAccepted=$false;submissionAttempted=$false;
  profileBinding=('a'*64);accountKey='site-default'}}
 return $script:registration
}
function Initialize-NativePtGuard {param($Root,$Origin,$Url,$ProfilePath,[switch]$MainProfile,[switch]$ReadOnly)
 $script:inspects++;Add-FixtureEvent 'inspect'
 if($script:entryGate -and $script:inspects -eq 1){return $script:initialUnknown}
 return $script:fixtureDecision
}
function Get-Process {param($Id);[pscustomobject]@{Path='Invoke-FixtureMature'}}
function Get-AutomationChromeProcesses{if($script:chromepresent){[pscustomobject]@{ProcessId=12345;Count=1}}}
function Close-AutomationChrome{Add-FixtureEvent 'close';$script:chromepresent=$false}
function Invoke-FixtureMature {
 $script:mature++;Add-FixtureEvent ('mature-'+$mature);$script:chromepresent=$true;$global:LASTEXITCODE=0
 if($script:mature -eq 1 -or $script:repeatChallenge){return (ConvertTo-Json $child -Depth 9 -Compress)}
 $evidence=[pscustomobject]@{source='page_text';authoritative=$true;confirmedAt=$at;businessDate=$day;pagePath='/attendance.php';statusSignal='same_day_page_text'}
 return (ConvertTo-Json ([pscustomobject]@{origin=$origin;url=$url;status='signed';accountKey='site-default';profileBinding=('a'*64);
  nativeGate=$true;submissionAttempted=$true;evidence=$evidence}) -Depth 8 -Compress)
}
function Invoke-FixtureProbe {
 $script:probes++;Add-FixtureEvent 'probe-readonly';$global:LASTEXITCODE=0
 if($script:earlySignedProbe){return (ConvertTo-Json $receipt -Depth 9 -Compress)}
 if($script:nativeTwoFactorRecoveryInvoked -and $script:nativeTwoFactorRecoveryInvoked.ContainsKey('${origin}')){
  return (ConvertTo-Json $reopened -Depth 9 -Compress)
 }
 return (ConvertTo-Json $child -Depth 9 -Compress)
}
function Invoke-MainChromeReadOnlyFallbackResult {param($Origin,$TimeoutSeconds,$UseMain)
 Add-FixtureEvent 'initial-readonly';return [pscustomobject]@{status='needs_attention';failureCode='two_factor_required';submissionAttempted=$false}
}
function Invoke-ParentFixture {
 Save-FixtureResponse
 Invoke-NativeTwoFactorRecovery -Child $child -Origin $origin -Url $url -ProfilePath $profile -TimeoutSeconds 35
}
function Get-FixtureCalls {
 if(Test-Path -LiteralPath (Join-Path $root 'calls.jsonl')){@([IO.File]::ReadAllLines((Join-Path $root 'calls.jsonl'))|ForEach-Object{$_|ConvertFrom-Json})}
}
function Get-FixtureEvents {
 if(Test-Path -LiteralPath (Join-Path $root 'events.jsonl')){@([IO.File]::ReadAllLines((Join-Path $root 'events.jsonl'))|ForEach-Object{$_|ConvertFrom-Json})}
}
`;
  try {
    const output=execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(harness+command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:90_000,
      maxBuffer:500_000,stdio:['ignore','pipe','pipe']});
    return JSON.parse(output.trim().replace(/^\uFEFF/,''));
  } catch(error) { throw new Error(`${shell} synthetic parent fixture failed: ${String(error.stderr??'').slice(0,1200)}`); }
}

for(const shell of shells)test(`parent real 2FA permits one bounded resume only after fresh persisted not-signed receipt (${shell})`,t=>{
  const row=run(t,shell,`Reset-Fixture
 $first=Invoke-ParentFixture;$second=Invoke-ParentFixture
 [pscustomobject]@{first=$first;second=$second;calls=@(Get-FixtureCalls);events=@(Get-FixtureEvents);
  registers=$registers;inspects=$inspects;originalStatus=$child.status;originalFailure=$child.failureCode;
  originalSubmitted=$child.submissionAttempted;originalUnderlying=$child.underlyingFailureCode}|ConvertTo-Json -Depth 10 -Compress`);
  assert.equal(row.first.handled,true);assert.equal(row.first.resumeAllowed,true,JSON.stringify(row));
  assert.equal(row.second.handled,false);assert.equal(row.second.resumeAllowed,false);
  assert.equal(row.calls.length,1);assert.equal(row.calls[0].typedOtp,true);
  assert.deepEqual(row.events,['recover','probe-readonly','register','inspect']);
  assert.equal(row.registers,1);assert.equal(row.inspects,1);
  assert.equal(row.originalFailure,'submission_outcome_unknown');assert.equal(row.originalStatus,'needs_attention');
  assert.equal(row.originalSubmitted,true);assert.equal(row.originalUnderlying,'two_factor_required');
});

for(const shell of shells)test(`parent confirmed receipt preserves original real submission and never resumes mature check-in (${shell})`,t=>{
  const row=run(t,shell,`Reset-Fixture
 $receipt.status='already_signed';$receipt.evidence.statusSignal='nexus_daily_header_signed';$receipt.inspection.signedControlCount=1;$receipt.inspection.unsignedControlCount=0
 $script:fixtureDecision=[pscustomobject]@{status='already_signed';accountKey='site-default';profileBinding=('a'*64);submissionAttempted=$false;evidence=$receipt.evidence}
 $result=Invoke-ParentFixture
 [pscustomobject]@{result=$result;calls=@(Get-FixtureCalls);originalFailure=$child.failureCode;originalSubmitted=$child.submissionAttempted}|ConvertTo-Json -Depth 9 -Compress`);
  assert.equal(row.result.resumeAllowed,false);assert.equal(row.result.result.status,'already_signed');
  assert.equal(row.result.result.submissionAttempted,true);
  assert.equal(row.result.result.profileBinding,binding);assert.equal(row.result.result.evidence.authoritative,true);
  assert.equal(row.originalFailure,'submission_outcome_unknown');assert.equal(row.originalSubmitted,true);
  assert.equal(row.calls.length,1);
});

for(const shell of shells)test(`parent disabled, other sites and untyped or missing actual 2FA never invoke a helper (${shell})`,t=>{
  const rows=run(t,shell,`$rows=@(foreach($case in @('disabled','unreviewed','string_enabled','string_reviewed','wrong_provider','other_site',
 'missing_fact','string_fact','no_otp','no_scoped_otp','password','waf','different_page','no_content','wrong_account','not_2fa')){
 Reset-Fixture
 switch($case){
 'disabled'{$config.nativePtTwoFactorRecovery.'${origin}'.enabled=$false}
 'unreviewed'{$config.nativePtTwoFactorRecovery.'${origin}'.reviewed=$false}
 'string_enabled'{$config.nativePtTwoFactorRecovery.'${origin}'.enabled='true'}
 'string_reviewed'{$config.nativePtTwoFactorRecovery.'${origin}'.reviewed='true'}
 'wrong_provider'{$config.nativePtTwoFactorRecovery.'${origin}'.provider='other'}
 'other_site'{$script:origin='https://other.example'}
 'missing_fact'{$child.nativeSecurityDiagnostic=$null}
 'string_fact'{$child.nativeSecurityDiagnostic.otpInputPresent='true'}
 'no_otp'{$child.nativeSecurityDiagnostic.otpInputPresent=$false}
 'no_scoped_otp'{$child.nativeSecurityDiagnostic.scopedOtpInputPresent=$false}
 'password'{$child.nativeSecurityDiagnostic.passwordInputPresent=$true}
 'waf'{$child.nativeSecurityDiagnostic.waf=$true}
 'different_page'{$child.nativeSecurityDiagnostic.sameOrigin=$false}
 'no_content'{$child.nativeSecurityDiagnostic.pageContentAvailable=$false}
 'wrong_account'{$child.accountKey='different'}
 'not_2fa'{$child.underlyingFailureCode='network_error'}
 }
 $result=Invoke-ParentFixture
 [pscustomobject]@{case=$case;resume=$result.resumeAllowed;handled=$result.handled;calls=@(Get-FixtureCalls).Count;registers=$registers;inspects=$inspects;
  submitted=$child.submissionAttempted;failure=$child.failureCode}
 });ConvertTo-Json -InputObject $rows -Compress`);
  for(const row of rows){assert.equal(row.resume,false,row.case);assert.equal(row.handled,false,row.case);
    assert.equal(row.calls,0,row.case);assert.equal(row.registers,0,row.case);assert.equal(row.inspects,0,row.case);
    assert.equal(row.submitted,true);assert.equal(row.failure,'submission_outcome_unknown');}
});

for(const shell of shells)test(`parent failed, mixed output or invalid receipt cannot authorize resumed submission (${shell})`,t=>{
  const rows=run(t,shell,`$rows=@(foreach($case in @('meta_rejected','untyped_meta','bad_reason','mixed','double','missing','wrong_profile','wrong_account','wrong_origin','wrong_url',
 'submitted_receipt','string_submitted','string_authority','old_day','stale','future','wrong_scope','wrong_mode','waf','unauthenticated',
 'save_denied','save_unaccepted','save_wrong_profile','save_wrong_account','save_submitted','save_string_allow','blocked_gate','unsigned_gate_success',
 'reopen_challenge','reopen_unloaded','reopen_waf','reopen_wrong_profile','reopen_string_verification','reopen_untyped_security')){
 Reset-Fixture
 $script:guardRejectReceipt=$case -cin @('wrong_url','old_day','stale','future','wrong_scope','wrong_mode','waf','unauthenticated')
 switch($case){
 'meta_rejected'{$meta.accepted=$false;$meta.reason='authentication_rejected'}
 'untyped_meta'{$meta.accepted='true'}
 'bad_reason'{$meta.reason='PRIVATE SYNTHETIC VALUE'}
 'mixed'{$script:transport='mixed'}
 'double'{$script:transport='double'}
 'missing'{$script:transport='missing'}
 'wrong_profile'{$receipt.profileBinding=('b'*64)}
 'wrong_account'{$receipt.accountKey='different'}
 'wrong_origin'{$receipt.origin='https://other.example'}
 'wrong_url'{$receipt.url=$origin+'/attendance.php'}
 'submitted_receipt'{$receipt.submissionAttempted=$true}
 'string_submitted'{$receipt.submissionAttempted='false'}
 'string_authority'{$receipt.evidence.authoritative='true'}
 'old_day'{$receipt.businessDate='2000-01-01';$receipt.evidence.businessDate='2000-01-01'}
 'stale'{$receipt.observedAt=$now.AddMinutes(-5).ToString('o');$receipt.evidence.confirmedAt=$receipt.observedAt}
 'future'{$receipt.observedAt=$now.AddMinutes(5).ToString('o');$receipt.evidence.confirmedAt=$receipt.observedAt}
 'wrong_scope'{$receipt.evidence.evidenceScope='unreviewed'}
 'wrong_mode'{$receipt.operationMode='legacy_checkin'}
 'waf'{$receipt.inspection.waf=$true}
 'unauthenticated'{$receipt.inspection.authenticated=$false}
 'save_denied'{$registration.allow=$false}
 'save_unaccepted'{$registration.receiptAccepted=$false}
 'save_wrong_profile'{$registration.profileBinding=('b'*64)}
 'save_wrong_account'{$registration.accountKey='different'}
 'save_submitted'{$registration.submissionAttempted=$true}
 'save_string_allow'{$registration.allow='true'}
 'blocked_gate'{$script:fixtureDecision=[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true}}
 'unsigned_gate_success'{$script:fixtureDecision=[pscustomobject]@{status='signed';submissionAttempted=$false;evidence=[pscustomobject]@{authoritative=$false}}}
 'reopen_challenge'{$reopened.nativeSecurityDiagnostic.otpInputPresent=$true;$reopened.nativeSecurityDiagnostic.scopedOtpInputPresent=$true}
 'reopen_unloaded'{$reopened.inspection.siteBodyLoaded=$false}
 'reopen_waf'{$reopened.inspection.waf=$true}
 'reopen_wrong_profile'{$reopened.profileBinding=('b'*64)}
 'reopen_string_verification'{$reopened.inspection.securityVerification='false'}
 'reopen_untyped_security'{$reopened.nativeSecurityDiagnostic.otpInputPresent='false'}
 }
 $result=Invoke-ParentFixture
 [pscustomobject]@{case=$case;resume=$result.resumeAllowed;result=$result.result;calls=@(Get-FixtureCalls).Count;
  originalFailure=$child.failureCode;originalSubmitted=$child.submissionAttempted}
 });ConvertTo-Json -InputObject $rows -Depth 10 -Compress`);
  for(const row of rows){assert.equal(row.resume,false,row.case);assert.equal(row.calls,1,row.case);
    assert.equal(row.result.status,'needs_attention',row.case);assert.equal(row.result.failureCode,'submission_outcome_unknown',row.case);
    assert.equal(row.originalFailure,'submission_outcome_unknown',row.case);assert.equal(row.originalSubmitted,true,row.case);
    assert.ok(!JSON.stringify(row.result).includes('PRIVATE'),row.case);}
});

for(const shell of shells)test(`actual parent native loop closes Chrome before recovery and resumes maturity at most once (${shell})`,t=>{
  const rows=run(t,shell,`$loop=$parentAst.FindAll({param($node)$node -is [Management.Automation.Language.ForStatementAst] -and
 $node.Extent.Text.Contains('$nativeAttempt') -and $node.Extent.Text.Contains('Invoke-NativeTwoFactorRecovery')},$true)|Select-Object -First 1
 if(-not $loop){throw 'Actual native attempt loop missing'}
 $rows=@(foreach($case in @('resume_signed','repeat_challenge','rejected','already_signed')){
 Reset-Fixture;$script:repeatChallenge=$case -eq 'repeat_challenge'
 if($case -eq 'rejected'){$meta.accepted=$false}
 if($case -eq 'already_signed'){
  $receipt.status='already_signed';$receipt.evidence.statusSignal='nexus_daily_header_signed';$receipt.inspection.signedControlCount=1;$receipt.inspection.unsignedControlCount=0
  $script:fixtureDecision=[pscustomobject]@{status='already_signed';submissionAttempted=$false;accountKey='site-default';profileBinding=('a'*64);evidence=$receipt.evidence}
 }
 Save-FixtureResponse
 $item=[pscustomobject]@{action='checkin';waitSeconds=35;windowMode='offscreen'};$autoClickTurnstile=@{}
 . ([scriptblock]::Create($loop.Extent.Text.Replace('$PSScriptRoot','$script:fixtureScripts')))
 [pscustomobject]@{case=$case;mature=$mature;calls=@(Get-FixtureCalls).Count;events=@(Get-FixtureEvents);result=$checkinInspection;chromePresent=$chromepresent}
 });ConvertTo-Json -InputObject $rows -Depth 10 -Compress`);
  for(const row of rows){const resumed=['resume_signed','repeat_challenge'].includes(row.case);
    assert.equal(row.mature,resumed?2:1,row.case);assert.equal(row.calls,1,row.case);assert.equal(row.chromePresent,false,row.case);
    assert.deepEqual(row.events.slice(0,3),['mature-1','close','recover'],row.case);
    if(resumed)assert.deepEqual(row.events.slice(-2),['mature-2','close'],row.case);
    if(row.case==='resume_signed')assert.equal(row.result.status,'signed');
    if(row.case==='already_signed'){assert.equal(row.result.status,'already_signed');assert.equal(row.result.submissionAttempted,true);}
    if(row.case==='repeat_challenge'||row.case==='rejected')assert.equal(row.result.failureCode,'submission_outcome_unknown');
  }
});

for(const shell of shells)test(`actual early candidate gate recovers real 2FA while preserving unknown when recovery fails (${shell})`,t=>{
  const rows=run(t,shell,`$branch=$parentAst.FindAll({param($node)$node -is [Management.Automation.Language.ForEachStatementAst] -and
 $node.Extent.Text.StartsWith('foreach ($candidate in $items)') -and $node.Extent.Text.Contains('Invoke-NativeTwoFactorRecovery')},$true)|Select-Object -First 1
 if(-not $branch){throw 'Actual early candidate loop missing'}
 $rows=@(foreach($case in @('resume','rejected')){
 Reset-Fixture;$script:entryGate=$true
 if($case -eq 'rejected'){$meta.accepted=$false}
 Save-FixtureResponse
 $items=@([pscustomobject]@{url=$url;action='checkin';profilePath=$profile;waitSeconds=35;windowMode='offscreen'})
 $mainFallbackByOrigin=@{};$eligibleItems=@();$preflightResults=@()
 . ([scriptblock]::Create($branch.Extent.Text.Replace('$PSScriptRoot','$script:fixtureScripts')))
 [pscustomobject]@{case=$case;eligible=$eligibleItems.Count;resultCount=$preflightResults.Count;result=$preflightResults;
  calls=@(Get-FixtureCalls).Count;probes=$probes;mature=$mature;events=@(Get-FixtureEvents)}
 });ConvertTo-Json -InputObject $rows -Depth 10 -Compress`);
  for(const row of rows){assert.equal(row.calls,1,row.case);assert.equal(row.probes,row.case==='resume'?2:1,row.case);assert.equal(row.mature,0,row.case);
    assert.equal(row.eligible,row.case==='resume'?1:0,row.case);assert.equal(row.resultCount,row.case==='resume'?0:1,row.case);
    if(row.case==='rejected'){assert.equal(row.result[0].failureCode,'submission_outcome_unknown');assert.equal(row.result[0].submissionAttempted,true);}
  }
});

for(const shell of shells)test(`early signed probe closes only after guard registration and inspection, without invoking 2FA (${shell})`,t=>{
  const rows=run(t,shell,`$branch=$parentAst.FindAll({param($node)$node -is [Management.Automation.Language.ForEachStatementAst] -and
 $node.Extent.Text.StartsWith('foreach ($candidate in $items)') -and $node.Extent.Text.Contains('Invoke-NativeTwoFactorRecovery')},$true)|Select-Object -First 1
 $rows=@(foreach($case in @('signed','save_denied','inspect_unknown')){
 Reset-Fixture;$script:entryGate=$true;$script:earlySignedProbe=$true
 $receipt.status='already_signed';$receipt.evidence.statusSignal='nexus_daily_header_signed'
 $receipt.inspection.signedControlCount=1;$receipt.inspection.unsignedControlCount=0
 $script:fixtureDecision=[pscustomobject]@{status='already_signed';accountKey='site-default';profileBinding=('a'*64);
  submissionAttempted=$false;evidence=$receipt.evidence}
 if($case -eq 'save_denied'){$registration.allow=$false;$registration.receiptAccepted=$false}
 if($case -eq 'inspect_unknown'){$script:fixtureDecision=$script:initialUnknown}
 Save-FixtureResponse
 $items=@([pscustomobject]@{url=$url;action='checkin';profilePath=$profile;waitSeconds=35;windowMode='offscreen'})
 $mainFallbackByOrigin=@{};$eligibleItems=@();$preflightResults=@()
 . ([scriptblock]::Create($branch.Extent.Text.Replace('$PSScriptRoot','$script:fixtureScripts')))
 [pscustomobject]@{case=$case;eligible=$eligibleItems.Count;results=$preflightResults;calls=@(Get-FixtureCalls).Count;
  probes=$probes;mature=$mature;registers=$registers;inspects=$inspects;originalFailure=$initialUnknown.failureCode;originalSubmitted=$initialUnknown.submissionAttempted}
 });ConvertTo-Json -InputObject $rows -Depth 10 -Compress`);
  for(const row of rows){assert.equal(row.calls,0,row.case);assert.equal(row.mature,0,row.case);assert.equal(row.probes,1,row.case);
    assert.equal(row.eligible,0,row.case);assert.equal(row.registers,1,row.case);assert.equal(row.results.length,1,row.case);
    assert.equal(row.results[0].status,row.case==='signed'?'already_signed':'needs_attention',row.case);
    assert.equal(row.inspects,row.case==='save_denied'?1:2,row.case);
    assert.equal(row.originalFailure,'submission_outcome_unknown');assert.equal(row.originalSubmitted,true);
  }
});
