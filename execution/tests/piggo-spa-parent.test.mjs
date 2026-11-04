import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url)),quote=value=>value.replaceAll("'","''");
for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
  test(`SPA parent preserves typed account attestation and selects only the calendar reader (${shell})`,()=>{
    const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
. '${quote(scripts+'Native-PtGuard.ps1')}'
function Invoke-NativePtGate {param($Phase,$Action,$Result) return $Result}
$script:NativePtGuard=@{managed=$true;origin='https://piggo.me'}
$receipt=[pscustomobject]@{origin='https://piggo.me';url='https://piggo.me/calendar';accountKey='site-default';profileBinding=('a'*64);
 status='not_signed';observedAt='2026-11-01T04:00:00Z';businessDate='2026-11-01';submissionAttempted=$false;
 operationMode='safe_history_page';readSafety='reviewed_passive';
 evidence=[pscustomobject]@{source='api';authoritative=$true;confirmedAt='2026-11-01T04:00:00Z';businessDate='2026-11-01';
 pagePath='/calendar';statusSignal='piggo_calendar_unsigned';evidenceScope='site_account_day'};
 inspection=[pscustomobject]@{piggoCalendarVerified=$true;accountMatched=$true;bodyText='PRIVATE_BODY'}}
$projected=Register-NativePtReadback $receipt
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$fn=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-MainChromeReadOnlyFallbackResult'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
function Resolve-CheckinNode {'Invoke-FakeReader'}
function Join-Path {'Read-NativePtHeader.mjs'}
function Invoke-FakeReader {$script:received=@($args);return '{"status":"unconfirmed","submissionAttempted":false,"nativeReadback":{"code":"readback_inconclusive"}}'}
$config=@{};$PSScriptRoot='fixture';$mainFallbackByOrigin=@{}
$piggo=Invoke-MainChromeReadOnlyFallbackResult 'https://piggo.me' 35 $false;$piggoArgs=$script:received
$other=Invoke-MainChromeReadOnlyFallbackResult 'https://tracker.example' 35 $false;$otherArgs=$script:received
[pscustomobject]@{receipt=$projected;piggoArgs=$piggoArgs;otherArgs=$otherArgs}|ConvertTo-Json -Depth 8 -Compress`;
    const result=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000}));
    assert.equal(result.receipt.inspection.piggoCalendarVerified,true);assert.equal(result.receipt.inspection.accountMatched,true);
    assert.equal(result.receipt.evidence.source,'api');assert.equal(result.receipt.evidence.pagePath,'/calendar');
    assert.equal(result.piggoArgs.includes('https://piggo.me/calendar'),true);
    assert.equal(result.piggoArgs.some(value=>value.includes('.php')),false);
    assert.equal(result.otherArgs.includes('https://tracker.example/index.php'),true);
    assert.equal(JSON.stringify(result).includes('PRIVATE_BODY'),false);
  });
}

const loginResult=(shell,reader,origin='https://piggo.me',calendar='$true')=>{
  const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$fn=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PiggoLoginRequiredResult'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$script:calls=0
function Invoke-FakeReader {$script:calls++;${reader}}
function Join-Path {'Read-NativePtHeader.mjs'}
$node='Invoke-FakeReader'
$config=[pscustomobject]@{ptReadOnlyPolicies=[pscustomobject]@{'https://piggo.me'=[pscustomobject]@{piggoCalendar=${calendar}}}}
$result=Get-PiggoLoginRequiredResult '${origin}'
[pscustomobject]@{result=$result;calls=$script:calls}|ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000}));
};
for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
  test(`a guarded PigGo reaches login recovery only on a read-only logged-out receipt (${shell})`,()=>{
    const out=loginResult(shell,`return '{"status":"login_required","failureCode":"login_required","submissionAttempted":false}'`);
    assert.equal(out.result.status,'login_required');assert.equal(out.result.inspectionStatus,'login_required');
    assert.equal(out.result.nativeGate,true);assert.equal(out.result.submissionAttempted,false);
    for(const reader of [`return '{"status":"not_signed","submissionAttempted":false}'`,`return '{"status":"already_signed","submissionAttempted":false}'`,
      `return '{"status":"login_required","submissionAttempted":true}'`,`return '{"status":"login_required"}'`,`return 'not json'`,`throw 'reader failed'`])
      assert.equal(loginResult(shell,reader).result,null,reader);
  });
  test(`other sites and an un-opted PigGo never run the extra read (${shell})`,()=>{
    const reader=`return '{"status":"login_required","submissionAttempted":false}'`;
    for(const out of [loginResult(shell,reader,'https://tracker.example'),loginResult(shell,reader,'https://piggo.me','$false')]){
      assert.equal(out.result,null);assert.equal(out.calls,0);
    }
  });
}

// Runs the real eligibility loop: an old intent stops PigGo there, before the per-item loop.
const eligibility=(shell,{origin='https://piggo.me',read,gate='unknown',useMain=false,policies=true})=>{
  const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$fn=$ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PiggoLoginRequiredResult'},$true)[0]
. ([scriptblock]::Create($fn.Extent.Text))
$loop=$ast.FindAll({param($node)$node -is [Management.Automation.Language.ForEachStatementAst] -and $node.Variable.VariablePath.UserPath -eq 'candidate'},$true)
if($loop.Count -ne 1){throw 'eligibility loop not found'}
$script:guardCalls=0;$script:readCalls=0;$script:registerCalls=0
function Initialize-NativePtGuard {$script:guardCalls++;${gate==='unknown'?"[pscustomobject]@{status='needs_attention';failureCode='submission_outcome_unknown';submissionAttempted=$true;retryable=$false;nativeGate=$true;reason='held'}":"$null"}}
function Invoke-MainChromeReadOnlyFallbackResult {$script:readCalls++;${read}}
function Register-NativePtReadback {$script:registerCalls++;[pscustomobject]@{allow=$false}}
function Test-NativeTwoFactorRecoveryOptIn {$false}
$node='must-not-run'
$config=[pscustomobject]@{bookmarksPath='fixture\\Bookmarks'${policies?";ptReadOnlyPolicies=[pscustomobject]@{'https://piggo.me'=[pscustomobject]@{piggoCalendar=$true}}":''}}
$mainFallbackByOrigin=@{};${useMain?"$mainFallbackByOrigin['"+origin+"']=[pscustomobject]@{url='"+origin+"/index.php'}":''}
$preflightResults=@()
$items=@([pscustomobject]@{url='${origin}/calendar';sourceOrigin='${origin}';action='preflight';passiveOnly=$false;profilePath='fixture\\profile';waitSeconds=120})
$eligibleItems=@()
. ([scriptblock]::Create($loop[0].Extent.Text))
[pscustomobject]@{results=@($preflightResults);eligible=@($eligibleItems).Count;guardCalls=$script:guardCalls;readCalls=$script:readCalls;registerCalls=$script:registerCalls}|ConvertTo-Json -Depth 5 -Compress`;
  return JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:15000}));
};
const loggedOut=`[pscustomobject]@{status='login_required';failureCode='login_required';submissionAttempted=$false;nativeReadback=[pscustomobject]@{code='login_required'}}`;
for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
  test(`an old intent sends a logged-out PigGo to login recovery from the eligibility loop (${shell})`,()=>{
    const out=eligibility(shell,{read:loggedOut});
    assert.equal(out.results.length,1);assert.equal(out.eligible,0);assert.equal(out.readCalls,1);assert.equal(out.registerCalls,0);
    const [row]=out.results;
    assert.equal(row.status,'login_required');assert.equal(row.inspectionStatus,'login_required');assert.equal(row.retryCause,'login_required');
    assert.equal(row.nativeGate,true);assert.equal(row.submissionAttempted,false);assert.equal(row.url,'https://piggo.me/calendar');
  });
  test(`an idle-locked PigGo passes the historical-intent eligibility branch with its fixed lock code (${shell})`,()=>{
    const out=eligibility(shell,{read:`[pscustomobject]@{status='login_required';failureCode='idle_locked';submissionAttempted=$false}`});
    assert.equal(out.results[0].status,'login_required');assert.equal(out.results[0].failureCode,'idle_locked');
    assert.equal(out.results[0].nativeReadback.apiStage,'idle_lock');assert.equal(out.results[0].submissionAttempted,false);
    assert.equal(out.readCalls,1);assert.equal(out.registerCalls,0);assert.equal(out.eligible,0);
  });
  test(`the eligibility loop keeps the unknown for anything but a clean logged-out PigGo read (${shell})`,()=>{
    for(const read of [`[pscustomobject]@{status='login_required';submissionAttempted=$true}`,`[pscustomobject]@{status='login_required'}`,
      `[pscustomobject]@{status='unconfirmed';submissionAttempted=$false}`,`[pscustomobject]@{status='managed_challenge';submissionAttempted=$false}`,'$null']){
      const out=eligibility(shell,{read});
      assert.equal(out.results.length,1,read);assert.equal(out.eligible,0,read);
      assert.equal(out.results[0].failureCode,'submission_outcome_unknown',read);assert.equal(out.results[0].submissionAttempted,true,read);
    }
    for(const out of [eligibility(shell,{origin:'https://tracker.example',read:loggedOut}),eligibility(shell,{read:loggedOut,policies:false}),eligibility(shell,{read:`[pscustomobject]@{status='not_signed';submissionAttempted=$false}`,policies:false})]){
      assert.equal(out.results[0].failureCode,'submission_outcome_unknown');assert.equal(out.results[0].submissionAttempted,true);
    }
  });
  test(`a guard that allows PigGo stays eligible without an extra read (${shell})`,()=>{
    const out=eligibility(shell,{gate:'allow',read:loggedOut});
    assert.equal(out.results.length,0);assert.equal(out.eligible,1);assert.equal(out.readCalls,0);
  });
}

// Acceptance comparison against an explicit base revision; the normal suite has no Git-history dependency.
test('other-site receipt predicates remain byte-for-byte identical to the work-order base',{skip:!process.env.PIGGO_BASELINE_REVISION},()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const original=file=>execFileSync('git',['show',process.env.PIGGO_BASELINE_REVISION+':execution/src/'+file],{cwd:root,encoding:'utf8'}).replaceAll('\r\n','\n');
  const current=file=>fs.readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replaceAll('\r\n','\n');
  const between=(source,start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const gate=current('native-pt-gate.mjs').replace(
    "  if(target.origin===piggoOrigin)return policy?.reviewed===true&&policy.piggoCalendar===true\n    ?acceptedPiggoCalendarReceipt(value,binding,now):null;\n",'');
  assert.equal(between(gate,'function acceptedReadback(','export function nativePtDecision('),
    between(original('native-pt-gate.mjs'),'function acceptedReadback(','export function nativePtDecision('));
  assert.equal(between(current('native-pt-gate.mjs'),'export function nativePtDecision(','function checkLease('),
    between(original('native-pt-gate.mjs'),'export function nativePtDecision(','function checkLease('));
  const reader=current('native-pt-read.mjs').replace(
    "  if(origin===piggoOrigin){\n    const receipt=acceptedPiggoCalendarReceipt(value,{accountKey:value.accountKey,profileBinding:value.profileBinding},now);\n    return url===piggoCalendarUrl?receipt?.evidence??null:null;\n  }\n",'');
  assert.equal(between(reader,'function receiptEvidence(','export function nativePtReadFailure('),
    between(original('native-pt-read.mjs'),'function receiptEvidence(','export function nativePtReadFailure('));
});
