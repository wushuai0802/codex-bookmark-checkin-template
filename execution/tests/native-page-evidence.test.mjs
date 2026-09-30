import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import test from 'node:test';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {loginHelperOutcome} from '../src/login-recovery.mjs';

const execFileAsync=promisify(execFile);
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));

test('native evidence is created only from same-site daily or action-confirmed page signals',async()=>{
  const base={currentUrl:'https://pt.example/attendance.php',bodyText:'抱歉，您今天已经签到过了',
    success:true,sameOrigin:true,waf:false,securityVerification:false,loginRoute:false};
  const cases=[
    {snapshot:base,expected:true},
    {snapshot:{...base,bodyText:'今日已簽到'},expected:true},
    {snapshot:{...base,bodyText:'今日已簽到',success:false},expected:true},
    {snapshot:{...base,bodyText:'签到成功'},clicked:true,expected:true},
    {snapshot:{...base,currentUrl:'https://www.pt.example/attendance.php'},expected:true},
    {snapshot:{...base,bodyText:'签到成功'},expected:false},
    {snapshot:{...base,bodyText:'签到成功'},formalVisit:true,expected:true},
    {snapshot:{...base,bodyText:'欢迎回来，累计签到 100 次'},expected:false},
    {snapshot:{...base,bodyText:'昨天已签到'},expected:false},
    {snapshot:{...base,bodyText:'今日尚未签到'},expected:false},
    {snapshot:{...base,currentUrl:'https://other.example/attendance.php'},expected:false},
    {snapshot:{...base,currentUrl:'https://pt.example/forums.php'},expected:false},
    {snapshot:{...base,currentUrl:'https://pt.example/login.php'},expected:false},
    {snapshot:{...base,currentUrl:'http://pt.example/attendance.php'},expected:false},
    {snapshot:{...base,sameOrigin:false},expected:false},
    {snapshot:{...base,waf:true},expected:false},
    {snapshot:{...base,securityVerification:true},expected:false},
    {snapshot:{...base,loginRoute:true},expected:false},
    {snapshot:{...base,bodyText:'truncated page',successText:'今日已签到'},expected:true},
    {snapshot:{...base,currentUrl:'https://ourbits.club/index.php',bodyText:'首页',authenticated:true,successControl:'已签到'},url:'https://ourbits.club/index.php',expected:true,signal:'nexus_daily_header_signed'},
    {snapshot:{...base,currentUrl:'https://piggo.me/index.php',bodyText:'首页',authenticated:true,successControl:'签到已得25'},url:'https://piggo.me/index.php',expected:false},
    {snapshot:{...base,currentUrl:'https://ourbits.club/index.php',authenticated:false,successControl:'已签到'},url:'https://ourbits.club/index.php',expected:false},
    {snapshot:{...base,currentUrl:'https://pt.example/index.php',authenticated:true,successControl:'已签到'},url:'https://pt.example/index.php',expected:false},
    {snapshot:{...base,currentUrl:'https://ourbits.club/index.php',authenticated:true,successControl:'历史签到已得250'},url:'https://ourbits.club/index.php',expected:false},
    {snapshot:{...base,currentUrl:'https://ourbits.club/attendance.php',bodyText:'您已签到，请勿重复提交'},url:'https://ourbits.club/attendance.php',formalVisit:true,expected:true},
    {snapshot:{...base,currentUrl:'https://ourbits.club/attendance.php',bodyText:'昨天已签到'},url:'https://ourbits.club/attendance.php',formalVisit:true,expected:false},
    {snapshot:{...base,currentUrl:'https://ourbits.club/attendance.php',bodyText:'2026-09-28 已签到'},url:'https://ourbits.club/attendance.php',formalVisit:true,expected:false},
  ];
  const quoted=value=>String(value).replaceAll("'","''");
  const command=`$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
. '${quoted(scripts+'ResultContract.ps1')}'
$cases='${quoted(JSON.stringify(cases))}' | ConvertFrom-Json
$legacy=[pscustomobject]@{success=$true;sameOrigin=$true;waf=$false;securityVerification=$false;loginRoute=$false}
if(-not (Test-NativePageCompletion $legacy 'https://service.example' $null)){throw 'non-PT completion behavior changed'}
if(Test-NativePageCompletion $legacy 'https://ourbits.club' $null){throw 'PT completion without evidence was accepted'}
$rows=@(foreach($c in $cases){
  $target=if($c.url){$c.url}else{'https://pt.example/attendance.php'}
  $proof=Get-ConfirmedNativePageEvidence $c.snapshot $target ([bool]$c.clicked) ([datetimeoffset]'2026-09-29T02:00:00Z') ([bool]$c.formalVisit)
  [pscustomobject]@{evidence=$proof}
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`;
  for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
  const {stdout}=await execFileAsync(shell,
    ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {encoding:'utf8',timeout:20000});
  const results=JSON.parse(stdout.trim());
  assert.equal(results.length,cases.length);
  cases.forEach((item,index)=>{
    const evidence=results[index].evidence;
    assert.equal(evidence?.authoritative===true,item.expected,`case ${index}`);
    if(!item.expected)return;
    assert.equal(evidence.businessDate,'2026-09-29');
    assert.equal(evidence.source,'page_text');
    assert.equal(evidence.statusSignal,item.signal??'same_day_page_text');
    assert.equal('bodyText' in evidence,false);
    const recovered=loginHelperOutcome(JSON.stringify({status:'logged_in',dailyCheckin:{status:'already_signed',evidence}}));
    assert.equal(recovered.dailyCheckin.evidence.authoritative,true);
    assert.equal(recovered.dailyCheckin.evidence.businessDate,'2026-09-29');
  });
  }
});

test('native producers and all confirmed preflight branches preserve structured evidence',async()=>{
  for(const file of ['Invoke-MainChromeCheckinAccessibility.ps1','Invoke-PlainWafAccessibility.ps1']){
    const source=await fs.readFile(scripts+file,'utf8');
    assert.ok(source.includes("Join-Path $PSScriptRoot 'ResultContract.ps1'"));
    assert.ok(source.includes('$pageEvidence = Get-ConfirmedNativePageEvidence $last $Url'));
    assert.ok(source.includes('evidence = $pageEvidence'));
  }
  const preflight=await fs.readFile(scripts+'Prepare-NativeWafSession.ps1','utf8');
  assert.equal(preflight.split('evidence = if ($mainConfirmed) { $mainInspection.evidence }').length-1,2);
  assert.ok(preflight.includes('evidence = if ($confirmed) { $checkinInspection.evidence }'));
  assert.ok(preflight.includes('evidence = if ($explicitlyConfirmed) { $passiveInspection.evidence }'));
});
