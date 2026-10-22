import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const run=promisify(execFile),scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
const shells=process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh'];
const quote=value=>String(value).replaceAll("'","''");
const jsonValue=value=>`([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json)`;
const harness=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${quote(path.join(scripts,'Native-PtChromeProxy.ps1'))}'
`;
async function fixture(shell,command,{exitCode=0}={}){
  let result;
  try{result=await run(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:30_000,maxBuffer:200_000});}
  catch(error){if(error.code!==exitCode&&!(exitCode===2&&error.code===1&&error.stdout?.trim().startsWith('{')))
    throw Error(`${shell}: ${error.stderr||error.message}`);result=error;}
  return JSON.parse(result.stdout.trim().replace(/^\uFEFF/,''));
}
function runtimeFixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-pt-proxy-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config'));
  const source=path.join(root,'main'),profile=path.join(root,'data','automation');
  fs.mkdirSync(path.join(source,'Default'),{recursive:true});fs.mkdirSync(profile,{recursive:true});
  const config={chromeExecutable:process.execPath,nodeExecutable:process.execPath,sourceUserDataDir:source,
    bookmarksPath:path.join(source,'Default','Bookmarks'),automationUserDataDir:profile,
    mainChromeFallbackUrls:['https://ourbits.club/attendance.php','https://audiences.me/attendance.php'],relatedCandidateUrls:{},
    nativePtProxyByOrigin:{'https://ourbits.club':'http://100.100.10.20:7893','https://audiences.me':'http://100.100.10.20:7893'}};
  return {root,source,profile,config,save:()=>fs.writeFileSync(path.join(root,'config','config.json'),JSON.stringify(config))};
}

test('native PT proxy accepts only canonical loopback, RFC1918 and Tailscale HTTP IP routes',async()=>{
  const accepted=['http://127.0.0.1:7890','http://127.9.8.7:8080/','http://[::1]:7890','http://10.0.0.1:3128',
    'http://172.16.0.1:80','http://172.31.255.255:65535','http://192.168.0.1:7893',
    'http://100.64.0.1:7893','http://100.127.255.254:7893','http://10.0.0.1'];
  const rejected=['https://10.0.0.1:7893','socks4://127.0.0.1:7890','http://proxy.example:7893',
    'http://localhost:7890','http://8.8.8.8:7893','http://100.63.255.255:7893','http://100.128.0.1:7893',
    'http://172.15.255.255:7893','http://172.32.0.1:7893','http://192.169.0.1:7893','http://169.254.0.1:7893',
    'http://0.0.0.0:7893','http://2130706433:7893','http://127.1:7893','http://0177.0.0.1:7893',
    'http://127.00.0.1:7893','http://10.256.0.1:7893','http://[::ffff:127.0.0.1]:7893',
    'http://user:pass@10.0.0.1:7893','http://10.0.0.1:7893/path','http://10.0.0.1:7893/?a=1',
    'http://10.0.0.1:7893/#fragment','http://10.0.0.1:0','http://10.0.0.1:65536','http://10.0.0.1:07893',
    'http://10.0.0.1:7893 --no-proxy-server',' http://10.0.0.1:7893','http://10.0.0.1:7893\n',null,123,['http://10.0.0.1:7893']];
  const command=harness+`$accepted=${jsonValue(accepted)};$rejected=${jsonValue(rejected)}
$good=@(foreach($value in $accepted){ConvertTo-NativePtChromeProxyServer $value})
$bad=@(foreach($value in $rejected){try{$null=ConvertTo-NativePtChromeProxyServer $value;'accepted'}catch{[string]$_.Exception.Data['NativePtProxyFailureCode']}})
[pscustomobject]@{good=$good;bad=$bad}|ConvertTo-Json -Depth 5 -Compress`;
  for(const shell of shells){const actual=await fixture(shell,command);assert.equal(actual.good.length,accepted.length,shell);
    assert.equal(actual.good.at(-1),'http://10.0.0.1:80');for(const [index,code] of actual.bad.entries())assert.equal(code,'native_proxy_configuration_invalid',`${shell}/rejected-${index}`);}
});

test('proxy configuration is exact-origin, registered and limited to one browser destination',async()=>{
  const command=harness+`$config=[pscustomobject]@{mainChromeFallbackUrls=@('https://ourbits.club/attendance.php');nativePtProxyByOrigin=[pscustomobject]@{'https://ourbits.club'='http://10.20.30.40:7893'}}
$rows=@(foreach($scenario in @('registered','other','alias','missing_registration','unreviewed','multiple_origins','null_value','array_value','no_proxy')){
 $c=$config;$origin='https://ourbits.club';$destinations=@($origin)
 if($scenario -eq 'other'){$origin='https://audiences.me';$destinations=@($origin)}
 if($scenario -eq 'alias'){$origin='https://www.ourbits.club';$destinations=@($origin)}
 if($scenario -eq 'missing_registration'){$c=[pscustomobject]@{nativePtProxyByOrigin=$config.nativePtProxyByOrigin}}
 if($scenario -eq 'unreviewed'){$origin='https://example.invalid';$destinations=@($origin);$c=[pscustomobject]@{mainChromeFallbackUrls=@($origin+'/attendance.php');nativePtProxyByOrigin=@{$origin='http://10.20.30.40:7893'}}}
 if($scenario -eq 'multiple_origins'){$destinations+=@('https://audiences.me')}
 if($scenario -in @('null_value','array_value')){$value=if($scenario -eq 'null_value'){$null}else{,@('http://10.20.30.40:7893')};$c=[pscustomobject]@{mainChromeFallbackUrls=@($origin+'/attendance.php');nativePtProxyByOrigin=@{$origin=$value}}}
 if($scenario -eq 'no_proxy'){$c=[pscustomobject]@{}}
 try{[pscustomobject]@{scenario=$scenario;proxy=(Resolve-NativePtChromeProxyForOrigins $c $destinations);code=''}}catch{[pscustomobject]@{scenario=$scenario;proxy='';code=[string]$_.Exception.Data['NativePtProxyFailureCode']}}
});ConvertTo-Json -InputObject $rows -Compress`;
  for(const shell of shells){const rows=await fixture(shell,command);for(const row of rows){
    if(row.scenario==='registered')assert.equal(row.proxy,'http://10.20.30.40:7893',shell);
    else if(['missing_registration','unreviewed','multiple_origins'].includes(row.scenario))assert.equal(row.code,'native_proxy_origin_not_registered',shell);
    else if(['null_value','array_value'].includes(row.scenario))assert.equal(row.code,'native_proxy_configuration_invalid',shell);
    else assert.deepEqual({proxy:row.proxy,code:row.code},{proxy:'',code:''},shell);
  }}
});

test('main Chrome refuses a different live root route while same-proxy and unrelated roots are allowed',async()=>{
  const command=harness+`$config=[pscustomobject]@{chromeExecutable='C:\\Program Files\\Chrome\\chrome.exe'}
$root='D:\\fixture main';$proxy='http://100.100.10.20:7893'
$default=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Google\\Chrome\\User Data'
$rows=@(foreach($scenario in @('no_process','same','same_quoted','same_split','different','missing','pac','direct','auto','bypass','other_root','renderer','default_missing','duplicate_proxy','duplicate_root','unreadable','unconfigured')){
 $expectedRoot=$root;$selectedProxy=$proxy
 $command='"C:\\Program Files\\Chrome\\chrome.exe" "--user-data-dir='+$root+'" --proxy-server='+$proxy
 if($scenario -eq 'same_quoted'){$command='chrome.exe --user-data-dir="'+$root+'" "--proxy-server='+$proxy+'"'}
 if($scenario -eq 'same_split'){$command='chrome.exe --user-data-dir "'+$root+'" --proxy-server "'+$proxy+'"'}
 if($scenario -eq 'different'){$command=$command.Replace($proxy,'http://127.0.0.1:7890')}
 if($scenario -eq 'missing'){$command='chrome.exe "--user-data-dir='+$root+'"'}
 if($scenario -eq 'pac'){$command+=' --proxy-pac-url=http://127.0.0.1/pac'}
 if($scenario -eq 'direct'){$command+=' --no-proxy-server'}
 if($scenario -eq 'auto'){$command+=' --proxy-auto-detect'}
 if($scenario -eq 'bypass'){$command+=' --proxy-bypass-list=*.club'}
 if($scenario -eq 'other_root'){$command=$command.Replace($root,'D:\\unrelated')}
 if($scenario -eq 'renderer'){$command+=' --type=renderer';$command=$command.Replace($proxy,'http://127.0.0.1:7890')}
 if($scenario -eq 'default_missing'){$expectedRoot=$default;$command='chrome.exe --profile-directory=Default'}
 if($scenario -eq 'duplicate_proxy'){$command+=' --proxy-server='+$proxy}
 if($scenario -eq 'duplicate_root'){$command+=' --user-data-dir=D:\\unrelated'}
 if($scenario -eq 'unreadable'){$command=''}
 if($scenario -eq 'unconfigured'){$selectedProxy='';$command=''}
 $processes=@([pscustomobject]@{Name='chrome.exe';ExecutablePath=$config.chromeExecutable;CommandLine=$command})
 if($scenario -eq 'no_process'){$processes=@()}
 try{Assert-NativePtMainChromeProxy -Config $config -ProfileRoot $expectedRoot -Origin 'https://ourbits.club' -ProxyServer $selectedProxy -Processes $processes;[pscustomobject]@{scenario=$scenario;code=''}}catch{[pscustomobject]@{scenario=$scenario;code=[string]$_.Exception.Data['NativePtProxyFailureCode']}}
});ConvertTo-Json -InputObject $rows -Compress`;
  const allowed=new Set(['no_process','same','same_quoted','same_split','other_root','renderer','unconfigured']);
  for(const shell of shells)for(const row of await fixture(shell,command))
    assert.equal(row.code,allowed.has(row.scenario)?'':'native_proxy_profile_conflict',`${shell}/${row.scenario}`);
});

test('actual main helper rejects a live conflicting Profile before any browser launch or write intent',async t=>{
  const f=runtimeFixture(t);f.save();
  const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-CimInstance { [pscustomobject]@{Name='chrome.exe';ExecutablePath='${quote(process.execPath)}';CommandLine='chrome.exe "--user-data-dir=${quote(f.source)}"'} }
function Start-Process {throw 'Unexpected browser startup'}
& '${quote(path.join(scripts,'Invoke-MainChromeCheckinAccessibility.ps1'))}' -Origin 'https://ourbits.club' -Url 'https://ourbits.club/attendance.php' -RuntimeRoot '${quote(f.root)}'`;
  for(const shell of shells){const result=await fixture(shell,command,{exitCode:2});
    assert.equal(result.failureCode,'native_readback_unavailable',shell);assert.equal(result.nativeProxyFailureCode,'native_proxy_profile_conflict',shell);
    assert.equal(result.submissionAttempted,false,shell);assert.equal(result.nativeReadback.code,'profile_binding_unavailable',shell);
    assert.equal(fs.existsSync(path.join(f.root,'data/native-pt-attempts.json')),false,shell);
  }
});

test('actual dedicated launcher applies the route, preserves offscreen flags and removes a conflicting direct bypass',async t=>{
  const f=runtimeFixture(t);const targetScripts=path.join(f.root,'scripts');fs.mkdirSync(targetScripts);
  for(const file of ['Open-PlainLoginChrome.ps1','Native-PtChromeProxy.ps1','CheckinContract.generated.ps1','Resolve-Runtime.ps1'])
    fs.copyFileSync(path.join(scripts,file),path.join(targetScripts,file));
  f.config.directConnectionOrigins=['https://audiences.me','https://example.invalid'];f.save();
  const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-CimInstance { @() }
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle);$global:TaskProxyCaptured=[pscustomobject]@{arguments=@($ArgumentList);windowStyle=[string]$WindowStyle}}
& '${quote(path.join(targetScripts,'Open-PlainLoginChrome.ps1'))}' -Urls 'https://audiences.me/index.php' -UserDataDirOverride '${quote(f.profile)}' -Offscreen | Out-Null
$global:TaskProxyCaptured | ConvertTo-Json -Depth 5 -Compress`;
  for(const shell of shells){const result=await fixture(shell,command);assert.equal(result.windowStyle,'Hidden',shell);
    assert.ok(result.arguments.includes('--proxy-server=http://100.100.10.20:7893'),shell);
    assert.ok(result.arguments.includes('--window-position=-32000,-32000'),shell);
    const selectedProfile=result.arguments.find(a=>a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length);
    assert.equal(fs.realpathSync.native(selectedProfile),fs.realpathSync.native(f.profile),shell);
    assert.equal(result.arguments.find(a=>a.startsWith('--proxy-bypass-list=')),'--proxy-bypass-list=example.invalid;*.example.invalid',shell);
    assert.equal(result.arguments.filter(a=>a.startsWith('--proxy-server=')).length,1,shell);
  }
});

test('unconfigured destinations retain their default route and the existing local API-profile proxy',async t=>{
  const f=runtimeFixture(t),targetScripts=path.join(f.root,'scripts');fs.mkdirSync(targetScripts);
  for(const file of ['Open-PlainLoginChrome.ps1','Native-PtChromeProxy.ps1','CheckinContract.generated.ps1','Resolve-Runtime.ps1'])
    fs.copyFileSync(path.join(scripts,file),path.join(targetScripts,file));
  delete f.config.nativePtProxyByOrigin;
  f.config.directConnectionOrigins=['https://audiences.me'];
  f.config.ptReadOnlyPolicies={'https://piggo.me':{nativeIsolatedChrome:true,nativeApiHeaderFallback:true,proxyServer:'http://127.0.0.1:7890'}};f.save();
  const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-CimInstance { @() }
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle);$global:TaskProxyCaptured=@($ArgumentList)}
$rows=@(foreach($origin in @('https://audiences.me','https://piggo.me')){
& '${quote(path.join(targetScripts,'Open-PlainLoginChrome.ps1'))}' -Urls ($origin+'/index.php') -UserDataDirOverride '${quote(f.profile)}' -Offscreen | Out-Null
[pscustomobject]@{origin=$origin;arguments=$global:TaskProxyCaptured}
});ConvertTo-Json -InputObject $rows -Depth 5 -Compress`;
  for(const shell of shells){const rows=await fixture(shell,command);
    assert.equal(rows[0].arguments.filter(a=>a.startsWith('--proxy-server=')).length,0,shell);
    assert.ok(rows[0].arguments.includes('--proxy-bypass-list=audiences.me;*.audiences.me'),shell);
    assert.ok(rows[1].arguments.includes('--proxy-server=http://127.0.0.1:7890'),shell);
  }
});

test('invalid proxy stops both actual native helpers before constructing a browser or recording a write',async t=>{
  const f=runtimeFixture(t);f.config.nativePtProxyByOrigin['https://ourbits.club']='http://8.8.8.8:7893';f.save();
  for(const shell of shells)for(const file of ['Invoke-PlainWafAccessibility.ps1','Invoke-MainChromeCheckinAccessibility.ps1']){
    const command=`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Start-Process {throw 'Unexpected browser startup'}
& '${quote(path.join(scripts,file))}' -Origin 'https://ourbits.club' -Url 'https://ourbits.club/attendance.php' -RuntimeRoot '${quote(f.root)}' ${file.includes('PlainWaf')?`-UserDataDirOverride '${quote(f.profile)}'`:''}`;
    const result=await fixture(shell,command,{exitCode:2});assert.equal(result.nativeProxyFailureCode,'native_proxy_configuration_invalid',`${shell}/${file}`);
    assert.equal(result.submissionAttempted,false,`${shell}/${file}`);assert.equal(fs.existsSync(path.join(f.root,'data/native-pt-attempts.json')),false);
  }
});
