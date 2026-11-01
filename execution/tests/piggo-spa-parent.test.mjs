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
