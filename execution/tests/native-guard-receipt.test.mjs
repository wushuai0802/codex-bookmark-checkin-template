import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const quote=value=>String(value).replaceAll("'","''");
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const preamble=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(scripts+'Native-PtGuard.ps1')}'
`;
function run(shell,command){
  return JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(preamble+command,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30000}));
}

for(const shell of shells)test(`JSON-decoded readback dates retain their exact instant across the Node boundary (${shell})`,()=>{
  const command=`$payload='{"confirmedAt":"2026-10-11T07:16:40.123Z"}' | ConvertFrom-Json
[pscustomobject]@{converted=(Convert-NativeReceiptTimestamp $payload.confirmedAt)} | ConvertTo-Json -Compress`;
  const result=run(shell,command);
  assert.equal(Date.parse(result.converted),Date.parse('2026-10-11T07:16:40.123Z'));
  assert.match(result.converted,/^2026-10-11T/);
});

for(const shell of shells)test(`managed native completion never reports success after a rejected or failed durable finish (${shell})`,()=>{
  const rows=run(shell,`
function Invoke-NativePtGate {
  if($script:scenario -eq 'throws'){throw 'fixture'}
  if($script:scenario -eq 'empty'){return $null}
  [pscustomobject]@{allow=($script:scenario -eq 'confirmed');confirmed=($script:scenario -eq 'confirmed');
    confirmationState=if($script:scenario -eq 'confirmed'){'confirmed'}else{'rejected'};
    profileBinding=('a'*64);accountKey='site-default'}
}
$rows=@(foreach($scenario in @('confirmed','rejected','throws','empty')){
  $script:scenario=$scenario
  $script:NativePtGuard=@{managed=$true;attempted=$true;readOnly=$false;profileBinding=('a'*64);accountKey='site-default'}
  $at=[datetimeoffset]::UtcNow
  $value=[pscustomobject]@{status='signed';evidence=[pscustomobject]@{source='page_text';authoritative=$true;
    confirmedAt=$at.ToString('o');businessDate=$at.ToOffset([timespan]::FromHours(8)).ToString('yyyy-MM-dd')}}
  $result=$value|Complete-NativePtResult
  [pscustomobject]@{scenario=$scenario;status=$result.status;failureCode=$result.failureCode;retryable=$result.retryable;
    submissionAttempted=$result.submissionAttempted;confirmationState=$result.confirmationState;
    bound=($result.profileBinding -ceq ('a'*64) -and $result.accountKey -ceq 'site-default');hasEvidence=($null -ne $result.evidence)}
})
ConvertTo-Json -InputObject $rows -Depth 5 -Compress`);
  assert.equal(rows[0].status,'signed');assert.equal(rows[0].hasEvidence,true);
  for(const row of rows.slice(1)){
    assert.equal(row.status,'needs_attention');assert.equal(row.failureCode,'submission_outcome_unknown');
    assert.equal(row.retryable,false);assert.equal(row.submissionAttempted,true);
    assert.equal(row.confirmationState,'not_persisted');assert.equal(row.hasEvidence,false);assert.equal(row.bound,true);
  }
});

for(const shell of shells)test(`read-only initialization obtains the actual gate binding and attaches it without any write phase (${shell})`,()=>{
  const result=run(shell,`
function Get-Content { '{}' }
function Invoke-NativePtGate([string]$Phase) {
  $script:phases += $Phase
  [pscustomobject]@{managed=$true;allow=$true;profileBinding=('a'*64);accountKey='site-default'}
}
$script:phases=@()
$null=Initialize-NativePtGuard -Root '${quote(scripts+'..')}' -Origin 'https://native.example' -Url 'https://native.example/index.php' -ProfilePath 'fixture' -ReadOnly
$value=[pscustomobject]@{status='not_signed';submissionAttempted=$false;evidence=[pscustomobject]@{authoritative=$true}}
$result=$value|Complete-NativePtResult
[pscustomobject]@{phases=@($script:phases);status=$result.status;submissionAttempted=$result.submissionAttempted;
  binding=$result.profileBinding;account=$result.accountKey;mode=$result.operationMode;safety=$result.readSafety;scope=$result.evidence.evidenceScope}|ConvertTo-Json -Depth 5 -Compress`);
  assert.deepEqual(result.phases,['bind']);assert.equal(result.status,'not_signed');
  assert.equal(result.submissionAttempted,false);assert.equal(result.binding,'a'.repeat(64));assert.equal(result.account,'site-default');
  assert.equal(result.mode,'safe_history_page');assert.equal(result.safety,'reviewed_passive');assert.equal(result.scope,'site_account_day');
});

for(const shell of shells)test(`readback registration projects the child identity without inventing the current profile or transmitting page text (${shell})`,()=>{
  const result=run(shell,`
$script:NativePtGuard=@{managed=$true;profileBinding=('a'*64);accountKey='site-default';origin='https://native.example'}
function Invoke-NativePtGate([string]$Phase,[string]$Action,$Result) { $script:captured=$Result;[pscustomobject]@{allow=$false;receiptAccepted=$false;phase=$Phase} }
$source=[pscustomobject]@{origin='https://native.example';url='https://native.example/index.php';status='not_signed';
  accountKey='site-default';profileBinding=('b'*64);submissionAttempted=$false;
  operationMode='safe_history_page';readSafety='reviewed_passive';
  evidence=[pscustomobject]@{source='page_text';authoritative=$true;confirmedAt='2026-10-02T03:00:00Z';businessDate='2026-10-02';pagePath='/index.php';statusSignal='nexus_daily_header_unsigned';evidenceScope='site_account_day'};
  inspection=[pscustomobject]@{currentUrl='https://native.example/index.php';sameOrigin=$true;bodyText='PRIVATE_FIXTURE_TEXT';
    pageContentAvailable=$true;siteBodyLoaded=$true;authenticated=$true;waf=$false;securityVerification=$false;loginRoute=$false;
    signedControlCount=0;unsignedControlCount=1;unsignedControl='签到';successControl='';success=$false;successText=$false}}
$registered=Register-NativePtReadback ([pscustomobject]@{readbackReceipt=$source})
[pscustomobject]@{phase=$registered.phase;binding=$script:captured.profileBinding;account=$script:captured.accountKey;
  noPageText=(-not ((ConvertTo-Json -InputObject $script:captured -Depth 8 -Compress).Contains('PRIVATE_FIXTURE_TEXT')));
  submitted=$script:captured.submissionAttempted;unsignedControl=$script:captured.inspection.unsignedControl;
  successText=$script:captured.inspection.successText;successTextBoolean=($script:captured.inspection.successText -is [bool])}|ConvertTo-Json -Depth 5 -Compress`);
  assert.equal(result.phase,'readback');assert.equal(result.binding,'b'.repeat(64));assert.equal(result.account,'site-default');
  assert.equal(result.noPageText,true);assert.equal(result.submitted,false);assert.equal(result.unsignedControl,'签到');
  assert.equal(result.successText,false);assert.equal(result.successTextBoolean,true);
});

for(const shell of shells)test(`Ourbits scoped readback projects only typed facts and preserves invalid strings for rejection (${shell})`,()=>{
  const rows=run(shell,`
function Invoke-NativePtGate([string]$Phase,[string]$Action,$Result) { $script:captured=$Result;[pscustomobject]@{allow=$false} }
$rows=@(foreach($origin in @('https://ourbits.club','https://other.example')){
  $script:NativePtGuard=@{managed=$true;origin=$origin}
  foreach($typed in @($true,$false)){
    $inspection=[pscustomobject]@{currentUrl=($origin+'/index.php');bodyText='PRIVATE_ACCOUNT_TEXT';
      ourbitsDailyHeaderVerified=if($typed){$true}else{'true'};ourbitsHeaderContextClear=$true;
      ourbitsHeaderLogoutCount=1;ourbitsHeaderStatsCount=4;ourbitsHeaderRewardCount=if($typed){1}else{'1'};
      ourbitsHeaderUnsignedControlCount=0;ourbitsHeaderText='PRIVATE_ACCOUNT_TEXT';accountId='PRIVATE_ID'}
    $source=[pscustomobject]@{origin=$origin;inspection=$inspection;evidence=[pscustomobject]@{confirmedAt='2026-10-11T08:00:00Z'}}
    $null=Register-NativePtReadback $source
    [pscustomobject]@{origin=$origin;typed=$typed;inspection=$script:captured.inspection;
      noPrivate=((ConvertTo-Json $script:captured -Depth 8 -Compress) -notmatch 'PRIVATE_')}
  }
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`);
  for(const row of rows){
    assert.equal(row.noPrivate,true);
    if(row.origin==='https://other.example'){assert.equal('ourbitsDailyHeaderVerified' in row.inspection,false);continue;}
    assert.equal(row.inspection.ourbitsDailyHeaderVerified,row.typed?true:'true');
    assert.equal(row.inspection.ourbitsHeaderRewardCount,row.typed?1:'1');
    assert.equal(row.inspection.ourbitsHeaderContextClear,true);assert.equal(row.inspection.ourbitsHeaderStatsCount,4);
    assert.equal(row.inspection.ourbitsHeaderUnsignedControlCount,0);
  }
});
