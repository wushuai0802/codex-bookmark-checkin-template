import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import test from 'node:test';

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

for(const shell of shells)test(`Ourbits reads the smallest owned account Group without inventing a signed control (${shell})`,async()=>{
  const rows=await run(shell,`
Add-Type @'
namespace CheckinFixture.Automation {
  public class ControlType {
    public string ProgrammaticName;
    public ControlType(string name) { ProgrammaticName="ControlType."+name; }
    public static ControlType Edit=new ControlType("Edit");
  }
  public class CurrentInfo { public string Name; public ControlType ControlType; public int NativeWindowHandle; public bool IsPassword; }
  public class AutomationElement {
    public CurrentInfo Current=new CurrentInfo();
    public AutomationElement Parent;
    public AutomationElement[] Descendants=new AutomationElement[0];
    public AutomationElement[] FindAll(TreeScope scope,Condition condition) { return Descendants; }
  }
  public enum TreeScope { Descendants }
  public class Condition { public static Condition TrueCondition=new Condition(); }
  public class TreeWalker {
    public static TreeWalker ControlViewWalker=new TreeWalker();
    public AutomationElement GetParent(AutomationElement element) { return element.Parent; }
  }
}
'@
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Invoke-MainChromeCheckinAccessibility.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Native reader syntax error'}
foreach($name in @('Get-WindowPageElements','Get-NativeOurbitsAccountHeader','Read-PageSnapshot','Test-EquivalentOrigin')){
  $definition=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)|Select-Object -First 1
  . ([scriptblock]::Create($definition.Extent.Text.Replace('[System.Windows.Automation.','[CheckinFixture.Automation.')))
}
function New-Node([string]$Name,[string]$Type){
  $node=[CheckinFixture.Automation.AutomationElement]::new()
  $node.Current.Name=$Name;$node.Current.ControlType=[CheckinFixture.Automation.ControlType]::new($Type)
  return $node
}
function Get-WindowElements { $script:elements }
function Get-CurrentUri { [uri]$script:currentUrl }
$now=[datetimeoffset]'2026-10-11T08:00:00Z'
$rows=@(foreach($scenario in @('signed','attendance_header','unsigned_account','separate_reward','larger_group_reward','history','duplicate_reward','duplicate_logout',
    'unsigned_link','unsigned_button','incomplete_stats','password','challenge','old_date','oversized','outside_document',
    'unowned_window','wrong_origin','wrong_target','wrong_target_path','query','foreign_path','toolbar_only')){
  $originValue='https://ourbits.club';$targetUri=[uri]'https://ourbits.club/index.php';$script:currentUrl=$targetUri.AbsoluteUri
  $taskHandle=[IntPtr]42;$window=New-Node 'Chrome task' 'Window';$window.Current.NativeWindowHandle=42
  $document=New-Node ('site fixture content '*10) 'Document'
  $text='PRIVATE_ACCOUNT_TEXT 上传 1 TB 下载 2 TB 分享率 1.5 魔力 100 (签到已得10)'
  if($scenario -in @('unsigned_account','separate_reward','larger_group_reward')){$text='上传 1 TB 下载 2 TB 分享率 1.5 魔力 100'}
  if($scenario -eq 'history'){$text=$text.Replace('签到已得','昨日 签到已得')}
  if($scenario -eq 'duplicate_reward'){$text+=' (签到已得20)'}
  if($scenario -eq 'incomplete_stats'){$text=$text.Replace('分享率','统计值')}
  if($scenario -eq 'challenge'){$text+=' 安全验证'}
  if($scenario -eq 'old_date'){$text+=' 2025-10-01'}
  if($scenario -eq 'oversized'){$text+=' '+('container '*200)}
  $group=New-Node $text 'Group';$group.Parent=$document
  $logout=New-Node '退出' 'Hyperlink';$logout.Parent=$group
  $children=@($logout)
  if($scenario -eq 'duplicate_logout'){$second=New-Node '退出' 'Hyperlink';$second.Parent=$group;$children+=$second}
  if($scenario -in @('unsigned_account','unsigned_link')){$entry=New-Node '签到' 'Hyperlink';$entry.Parent=$group;$children+=$entry}
  if($scenario -eq 'unsigned_button'){$entry=New-Node '签到' 'Button';$entry.Parent=$group;$children+=$entry}
  if($scenario -eq 'password'){$password=New-Node '输入框' 'Edit';$password.Current.IsPassword=$true;$password.Parent=$group;$children+=$password}
  $group.Descendants=$children
  $pageElements=@($group)+$children
  if($scenario -eq 'separate_reward'){$pageElements+=(New-Node '其他资料 签到已得999' 'Text')}
  if($scenario -eq 'larger_group_reward'){
    $larger=New-Node ($text+' (签到已得999)') 'Group';$larger.Parent=$document;$group.Parent=$larger
    $larger.Descendants=@($group)+$children;$pageElements=@($larger)+$pageElements
  }
  if($scenario -eq 'outside_document'){
    $pageElements=$children
    $group.Parent=$window
  }
  if($scenario -eq 'unowned_window'){$window.Current.NativeWindowHandle=43}
  if($scenario -eq 'wrong_origin'){$originValue='https://other.example';$targetUri=[uri]'https://other.example/index.php';$script:currentUrl=$targetUri.AbsoluteUri}
  if($scenario -eq 'wrong_target'){$targetUri=[uri]'https://other.example/index.php'}
  if($scenario -eq 'wrong_target_path'){$targetUri=[uri]'https://ourbits.club/forums.php'}
  if($scenario -eq 'query'){$script:currentUrl+='?day=2025-10-01'}
  if($scenario -eq 'foreign_path'){$script:currentUrl='https://ourbits.club/forums.php'}
  if($scenario -eq 'attendance_header'){$script:currentUrl='https://ourbits.club/attendance.php';$targetUri=[uri]$script:currentUrl}
  $document.Descendants=$pageElements;$script:elements=@($document)+$pageElements
  if($scenario -eq 'toolbar_only'){$script:elements=$pageElements}
  $snapshot=Read-PageSnapshot $window
  $evidence=Get-ConfirmedNativePageEvidence $snapshot $targetUri.AbsoluteUri $false $now
  $unsignedEvidence=Get-ConfirmedNativeUnsignedEvidence $snapshot $targetUri.AbsoluteUri $now
  [pscustomobject]@{scenario=$scenario;authenticated=$snapshot.authenticated;daily=$snapshot.ourbitsDailyHeaderVerified;
    rewardCount=$snapshot.ourbitsHeaderRewardCount;unsignedCount=$snapshot.ourbitsHeaderUnsignedControlCount;
    signedControlCount=$snapshot.signedControlCount;successControl=$snapshot.successControl;
    evidence=$evidence;unsignedEvidence=$unsignedEvidence;complete=(Test-NativePageCompletion $snapshot $originValue $evidence $now)}
})
ConvertTo-Json -InputObject $rows -Depth 8 -Compress`);
  for(const row of rows){
    const signed=['signed','attendance_header'].includes(row.scenario);
    assert.equal(row.evidence?.authoritative===true,signed,row.scenario);
    assert.equal(row.complete,signed,row.scenario);
    assert.equal(row.unsignedEvidence?.authoritative===true,row.scenario==='unsigned_account',row.scenario);
    assert.equal(row.signedControlCount,0,row.scenario);
    assert.equal(row.successControl,'',row.scenario);
    if(signed){assert.equal(row.authenticated,true);assert.equal(row.daily,true);assert.equal(row.rewardCount,1);}
  }
  assert.equal(rows.find(row=>row.scenario==='unsigned_button').unsignedCount,1);
  assert.equal(rows.find(row=>row.scenario==='separate_reward').authenticated,true);
  assert.equal(rows.find(row=>row.scenario==='larger_group_reward').rewardCount,0);
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_ACCOUNT_TEXT|签到已得999/);
});

for(const shell of shells)test(`Ourbits scoped evidence rejects incomplete, untyped, contradictory and old attestations (${shell})`,async()=>{
  const base={currentUrl:'https://ourbits.club/index.php',sameOrigin:true,pageContentAvailable:true,siteBodyLoaded:true,
    authenticated:true,waf:false,securityVerification:false,loginRoute:false,signedControlCount:0,unsignedControlCount:0,
    successControl:'',unsignedControl:'',ourbitsDailyHeaderVerified:true,ourbitsHeaderContextClear:true,
    ourbitsHeaderLogoutCount:1,ourbitsHeaderStatsCount:4,ourbitsHeaderRewardCount:1,ourbitsHeaderUnsignedControlCount:0};
  const changes=[{ourbitsDailyHeaderVerified:false},{ourbitsDailyHeaderVerified:'true'},
    {ourbitsHeaderContextClear:false},{ourbitsHeaderContextClear:'true'},
    {ourbitsHeaderLogoutCount:2},{ourbitsHeaderLogoutCount:'1'},{ourbitsHeaderStatsCount:3},
    {ourbitsHeaderRewardCount:0},{ourbitsHeaderRewardCount:2},{ourbitsHeaderRewardCount:'1'},
    {ourbitsHeaderUnsignedControlCount:1},{ourbitsHeaderUnsignedControlCount:'0'},
    {authenticated:false},{siteBodyLoaded:false},{pageContentAvailable:false},{sameOrigin:false},
    {waf:true},{securityVerification:true},{loginRoute:true},{browserFailureCode:'network_error'},
    {signedControlCount:1},{unsignedControlCount:1},{successControl:'已签到'},{unsignedControl:'签到'},
    {currentUrl:'https://www.ourbits.club/index.php'},{currentUrl:'https://ourbits.club/index.php?day=2025-10-01'},
    {currentUrl:'https://other.example/index.php'},{currentUrl:'https://ourbits.club/forums.php'}];
  const cases=[{snapshot:base,expected:true},...changes.map(change=>({snapshot:{...base,...change},expected:false}))];
  const rows=await run(shell,`
$now=[datetimeoffset]'2026-10-11T08:00:00Z'
$base='${quote(JSON.stringify(base))}' | ConvertFrom-Json
$changes='${quote(JSON.stringify(changes))}' | ConvertFrom-Json
$cases=@([pscustomobject]@{snapshot=$base})+@(foreach($change in $changes){
  $snapshot=$base.PSObject.Copy()
  foreach($property in $change.PSObject.Properties){
    if($snapshot.PSObject.Properties[$property.Name]){$snapshot.($property.Name)=$property.Value}
    else{$snapshot|Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value}
  }
  [pscustomobject]@{snapshot=$snapshot}
})
$rows=@(foreach($case in $cases){
  $evidence=Get-ConfirmedNativePageEvidence $case.snapshot 'https://ourbits.club/index.php' $false $now
  [pscustomobject]@{proof=($null -ne $evidence);complete=(Test-NativePageCompletion $case.snapshot 'https://ourbits.club' $evidence $now)}
})
$valid=Get-ConfirmedNativePageEvidence $cases[0].snapshot 'https://ourbits.club/index.php' $false $now
$stale=$valid.PSObject.Copy();$stale.confirmedAt=$now.AddMinutes(-6).ToString('o')
$future=$valid.PSObject.Copy();$future.confirmedAt=$now.AddSeconds(1).ToString('o')
$oldDay=$valid.PSObject.Copy();$oldDay.businessDate='2026-10-10'
[pscustomobject]@{rows=$rows;stale=(Test-NativePageCompletion $cases[0].snapshot 'https://ourbits.club' $stale $now);
  future=(Test-NativePageCompletion $cases[0].snapshot 'https://ourbits.club' $future $now);
  oldDay=(Test-NativePageCompletion $cases[0].snapshot 'https://ourbits.club' $oldDay $now)}|ConvertTo-Json -Depth 8 -Compress`);
  cases.forEach((entry,index)=>assert.deepEqual(rows.rows[index],{proof:entry.expected,complete:entry.expected},`case ${index}`));
  assert.equal(rows.stale,false);assert.equal(rows.future,false);assert.equal(rows.oldDay,false);
});
