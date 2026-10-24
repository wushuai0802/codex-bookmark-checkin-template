import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {inspectNativePtHeader,nativePtReadFailure,runNativeReadProcess,asciiNativePtReadReceipt,safeNativeReadback} from '../src/native-pt-read.mjs';

const origin='https://audiences.me',now=new Date('2026-10-07T00:15:00Z');
const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-readback-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(path.join(root,'main/Default'),{recursive:true});
  fs.writeFileSync(path.join(root,'main/Local State'),'fixture only');
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({sourceUserDataDir:path.join(root,'main'),
    bookmarksPath:path.join(root,'main/Default/Bookmarks'),powershellExecutable:process.platform==='win32'?'pwsh.exe':'pwsh'}));
  return {root,origin,url:origin+'/index.php',clock:()=>now};
}
function receipt(args,overrides={}){
  const profile=path.join(args.root,'main/Default'),key=process.platform==='win32'?profile.toLowerCase():profile;
  return {status:'already_signed',submissionAttempted:false,clicked:false,reason:'鍘熺敓绛惧埌',
    accountKey:'site-default',profileBinding:crypto.createHash('sha256').update(key).digest('hex'),
    evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-07',
      pagePath:'/index.php',statusSignal:'nexus_daily_header_signed'},
    inspection:{currentUrl:origin+'/index.php',sameOrigin:true,authenticated:false,waf:false,loginRoute:false,securityVerification:false,
      signedControlCount:0,unsignedControlCount:0,successControl:'',unsignedControl:'',success:true,audiencesDailyHeaderVerified:true,
      pageContentAvailable:true,siteBodyLoaded:true,successText:'synthetic daily signal',bodyText:'PRIVATE BODY must never leave transport'},...overrides};
}

test('the shared read entrypoint requires a passive reviewed URL and exact main-profile binding before spawn',async t=>{
  const args=fixture(t);let calls=0;
  for(const url of [origin+'/attendance.php',origin+'/index.php?token=private','https://other.example/index.php'])
    await assert.rejects(()=>inspectNativePtHeader({...args,url,execute:async()=>{calls++;}}),e=>e.code==='request_rejected');
  const config=JSON.parse(fs.readFileSync(path.join(args.root,'config/config.json')));
  fs.writeFileSync(path.join(args.root,'config/config.json'),JSON.stringify({...config,bookmarksPath:path.join(args.root,'other/Default/Bookmarks')}));
  await assert.rejects(()=>inspectNativePtHeader({...args,execute:async()=>{calls++;}}),e=>e.code==='profile_binding_unavailable');
  assert.equal(calls,0);
});

test('CLI envelopes are ASCII and stage diagnostics contain only enum codes and bounded safe facts',()=>{
  const original={reason:'只读诊断 😀',status:'unconfirmed'};
  const encoded=asciiNativePtReadReceipt(original);assert.doesNotMatch(encoded,/[^\x00-\x7f]/);
  assert.deepEqual(JSON.parse(encoded),original);
  const safe=safeNativeReadback({stage:'PRIVATE',code:'secret=123',exitCode:'private',durationMs:9999999,
    stderrPresent:true,stderrBytes:9999999,bodyText:'PRIVATE BODY',stderr:'PRIVATE STDERR',sameOrigin:true});
  assert.equal(safe.stage,'preflight');assert.equal(safe.code,'request_rejected');assert.equal(safe.exitCode,null);
  assert.equal(safe.durationMs,600000);assert.equal(safe.stderrBytes,200000);assert.equal(safe.sameOrigin,true);
  assert.doesNotMatch(JSON.stringify(safe),/PRIVATE|secret|bodyText/);
});

test('valid JSON with a mojibake reason remains a same-day bound authoritative read, not a decode failure',async t=>{
  const args=fixture(t);
  const result=await inspectNativePtHeader({...args,execute:async(file,argv,options)=>{
    assert.ok(argv.includes('-ReadOnly'));assert.ok(argv.includes('-LifecyclePath'));assert.ok(argv.includes('-LifecycleToken'));
    assert.equal(argv[argv.indexOf('-Url')+1],origin+'/index.php');assert.equal(options.encoding,'utf8');
    assert.equal(options.timeout,75_000);assert.equal(options.windowsHide,true);
    return {stdout:'\uFEFF'+JSON.stringify(receipt(args)),stderr:'PRIVATE STDERR token=secret',exitCode:0};
  }});
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  assert.equal(result.nativeReadback.code,'receipt_accepted');assert.equal(result.nativeReadback.stderrPresent,true);
  const key=path.join(args.root,'main/Default');
  assert.equal(result.profileBinding,crypto.createHash('sha256').update(process.platform==='win32'?key.toLowerCase():key).digest('hex'));
  assert.equal(result.accountKey,'site-default');assert.equal(result.evidence.authoritative,true);
  const diagnostic=fs.readFileSync(path.join(args.root,'logs/native-pt-readback.jsonl'),'utf8');
  assert.doesNotMatch(JSON.stringify(result)+diagnostic,/PRIVATE|secret|bodyText/);
  const {readbackReceipt,...publicResult}=result;
  assert.doesNotMatch(JSON.stringify(publicResult)+diagnostic,/currentUrl/);
  assert.equal(readbackReceipt.profileBinding,result.profileBinding);assert.equal(readbackReceipt.accountKey,'site-default');
  assert.equal(readbackReceipt.inspection.currentUrl,args.url);
  assert.deepEqual(Object.keys(readbackReceipt.inspection).sort(),[
    'currentUrl','sameOrigin','authenticated','waf','loginRoute','siteBodyLoaded','pageContentAvailable',
    'hasDailySignal','hasSignedControl','securityVerification','signedControlCount','unsignedControlCount',
    'successControl','unsignedControl','success','successText','audiencesDailyHeaderVerified',
  ].sort());
  assert.deepEqual(fs.readdirSync(path.join(args.root,'tmp')),[]);
});

function unsignedReceipt(args){
  const value=receipt(args);
  return {...value,status:'not_signed',evidence:{...value.evidence,statusSignal:'nexus_daily_header_unsigned'},
    inspection:{...value.inspection,authenticated:true,signedControlCount:0,unsignedControlCount:1,
      unsignedControl:'签到',successControl:'',success:false,successText:'',audiencesDailyHeaderVerified:false}};
}

test('successful positive and negative child receipts require both exact real profile and account bindings',async t=>{
  const args=fixture(t);
  for(const base of [receipt(args,{status:'signed'}),receipt(args),unsignedReceipt(args)]){
    const valid=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(base),stderr:'',exitCode:0})});
    assert.equal(valid.status,base.status);assert.equal(valid.evidence.authoritative,true);
    assert.equal(valid.readbackReceipt.profileBinding,base.profileBinding);assert.equal(valid.readbackReceipt.accountKey,base.accountKey);
    for(const change of [{profileBinding:undefined},{accountKey:undefined},{profileBinding:'b'.repeat(64)},
      {accountKey:'other-site-account'},{profileBinding:undefined,accountKey:undefined}]){
      const value={...base,...change};
      const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(value),stderr:'',exitCode:0})});
      assert.equal(result.status,'unconfirmed');assert.equal(result.failureCode,'authoritative_status_unavailable');
      assert.equal(result.nativeReadback.code,'authoritative_evidence_rejected');assert.equal(result.submissionAttempted,false);
      assert.equal(result.evidence,undefined);assert.equal(result.readbackReceipt,undefined);
      assert.equal(result.profileBinding,receipt(args).profileBinding);assert.equal(result.accountKey,'site-default');
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE|other-site-account/);
    }
  }
});

test('reviewed home redirects retain bound positive evidence while negative proofs require index.php',async t=>{
  const args=fixture(t),positive=receipt(args);
  for(const currentUrl of [origin+'/','https://www.audiences.me/']){
    const value={...positive,evidence:{...positive.evidence,pagePath:'/'},inspection:{...positive.inspection,currentUrl}};
    const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(value),stderr:'',exitCode:0})});
    assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);
    assert.equal(result.readbackReceipt.evidence.pagePath,'/');assert.equal(result.readbackReceipt.inspection.currentUrl,currentUrl);
  }
  const negative=unsignedReceipt(args);
  const value={...negative,evidence:{...negative.evidence,pagePath:'/'},inspection:{...negative.inspection,currentUrl:origin+'/'}};
  const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(value),stderr:'',exitCode:0})});
  assert.equal(result.status,'unconfirmed');assert.equal(result.nativeReadback.code,'authoritative_evidence_rejected');
  assert.equal(result.evidence,undefined);assert.equal(result.readbackReceipt,undefined);
});

test('Ourbits scoped static reward requires complete typed account-header facts before authority crosses the transport',async t=>{
  const args={...fixture(t),origin:'https://ourbits.club',url:'https://ourbits.club/index.php'};
  const base=receipt(args),child={...base,inspection:{...base.inspection,currentUrl:args.url,authenticated:true,
    signedControlCount:0,unsignedControlCount:0,successControl:'',unsignedControl:'',
    ourbitsDailyHeaderVerified:true,ourbitsHeaderContextClear:true,ourbitsHeaderLogoutCount:1,
    ourbitsHeaderStatsCount:4,ourbitsHeaderRewardCount:1,ourbitsHeaderUnsignedControlCount:0}};
  const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(child),stderr:'',exitCode:0})});
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);assert.equal(result.submissionAttempted,false);
  assert.equal(result.readbackReceipt.inspection.ourbitsDailyHeaderVerified,true);
  assert.equal(result.readbackReceipt.inspection.ourbitsHeaderStatsCount,4);
  for(const change of [{authenticated:false},{siteBodyLoaded:false},{ourbitsDailyHeaderVerified:'true'},
    {ourbitsHeaderContextClear:false},{ourbitsHeaderLogoutCount:2},{ourbitsHeaderStatsCount:'4'},
    {ourbitsHeaderRewardCount:0},{ourbitsHeaderRewardCount:2},{ourbitsHeaderUnsignedControlCount:1},
    {unsignedControlCount:1,unsignedControl:'签到'},{successControl:'已签到'}]){
    const invalid={...child,inspection:{...child.inspection,...change}};
    const rejected=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(invalid),stderr:'',exitCode:0})});
    assert.equal(rejected.status,'unconfirmed');assert.equal(rejected.evidence,undefined);assert.equal(rejected.readbackReceipt,undefined);
    assert.equal(rejected.submissionAttempted,false);
  }
});

test('WAF, login, window, stale evidence and cross-origin results retain safe diagnostic rejection codes',async t=>{
  const args=fixture(t);
  for(const [value,code,status] of [
    [receipt(args,{status:'managed_challenge',evidence:null,inspection:{sameOrigin:true,waf:true}}),'waf_present','managed_challenge'],
    [receipt(args,{status:'login_required',evidence:null,inspection:{sameOrigin:true,loginRoute:true}}),'login_required','login_required'],
    [receipt(args,{status:'unconfirmed',failureCode:'window_not_created',evidence:null,inspection:{}}),'window_not_created','unconfirmed'],
    [receipt(args,{evidence:{...receipt(args).evidence,businessDate:'2026-10-06'}}),'authoritative_evidence_rejected','unconfirmed'],
    [receipt(args,{inspection:{...receipt(args).inspection,currentUrl:'https://other.example/index.php'}}),'authoritative_evidence_rejected','unconfirmed'],
  ]){
    const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(value),stderr:'',exitCode:2})});
    assert.equal(result.nativeReadback.code,code);assert.equal(result.nativeReadback.exitCode,2);assert.equal(result.status,status);
    if(code==='login_required')assert.equal(result.failureCode,'login_required');
    assert.equal(result.submissionAttempted,false);assert.equal(result.evidence,undefined);
  }
});

test('a blocked private proxy route remains a safe preflight failure instead of missing daily evidence',async t=>{
  const args=fixture(t);
  for(const nativeProxyFailureCode of ['native_proxy_configuration_invalid','native_proxy_origin_not_registered','native_proxy_profile_conflict']){
    const child={status:'unconfirmed',failureCode:'native_readback_unavailable',nativeProxyFailureCode,
      submissionAttempted:false,reason:'PRIVATE route token=secret',
      nativeReadback:{stage:'preflight',code:'profile_binding_unavailable'},
      evidence:receipt(args).evidence};
    const result=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify(child),stderr:'PRIVATE STDERR',exitCode:2})});
    assert.equal(result.status,'unconfirmed');assert.equal(result.submissionAttempted,false);
    assert.equal(result.failureCode,nativeProxyFailureCode==='native_proxy_profile_conflict'?'browser_route_conflict':'native_readback_unavailable');
    assert.equal(result.nativeReadback.stage,'preflight');
    assert.equal(result.nativeReadback.code,'profile_binding_unavailable');assert.equal(result.evidence,undefined);
    assert.equal(result.readbackReceipt,undefined);assert.equal(result.profileBinding,receipt(args).profileBinding);
    if(nativeProxyFailureCode==='native_proxy_profile_conflict')assert.match(result.reason,/Chrome/);
    assert.doesNotMatch(JSON.stringify(result)+fs.readFileSync(path.join(args.root,'logs/native-pt-readback.jsonl'),'utf8'),/PRIVATE|secret|native_proxy_/);
  }
  const unknown=await inspectNativePtHeader({...args,execute:async()=>({stdout:JSON.stringify({status:'unconfirmed',
    failureCode:'native_readback_unavailable',nativeProxyFailureCode:'PRIVATE',submissionAttempted:false,
    nativeReadback:{stage:'preflight',code:'PRIVATE'},reason:'PRIVATE'}),stderr:'',exitCode:2})});
  assert.equal(unknown.nativeReadback.stage,'readback');assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE/);
});

test('malformed output, timeout and a reported write cannot become successful read receipts or leak stderr',async t=>{
  const args=fixture(t);
  for(const [execute,stage,code,possible] of [
    [async()=>({stdout:'{bad PRIVATE BODY',stderr:'secret=123',exitCode:2}),'decode','invalid_json',false],
    [async()=>{throw Object.assign(Error('private transport message'),{killed:true,code:'ETIMEDOUT',stdout:JSON.stringify(receipt(args)),stderr:'secret=123',cleanupCode:'closed'});},'timeout','process_deadline',false],
    [async()=>({stdout:JSON.stringify(receipt(args,{submissionAttempted:true})),stderr:'',exitCode:0}),'guard','submission_reported',true],
    [async()=>({stdout:JSON.stringify(receipt(args,{submissionAttempted:undefined})),stderr:'',exitCode:0}),'guard','readonly_not_proven',false],
  ]){
    await assert.rejects(()=>inspectNativePtHeader({...args,execute}),error=>{
      assert.equal(error.nativeReadback.stage,stage);assert.equal(error.code,code);
      const result=nativePtReadFailure(error);assert.equal(result.submissionAttempted,possible);
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret|private transport/);return true;
    });
  }
});

test('a real disposable helper deadline is bounded and cleanup receives only its owned process identity',async()=>{
  let cleanupRequest;
  const started=Date.now();
  await assert.rejects(()=>runNativeReadProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{
    encoding:'utf8',windowsHide:true,timeout:100,root:'fixture',lifecyclePath:'fixture/window.json',
    cleanup:async request=>{cleanupRequest=request;return {code:'already_closed'};},
  }),error=>error.killed===true&&error.code==='ETIMEDOUT'&&error.cleanupCode==='already_closed');
  assert.ok(Number.isInteger(cleanupRequest.pid));assert.equal(cleanupRequest.lifecyclePath,'fixture/window.json');
  assert.ok(Date.now()-started<5000);
});

test('PowerShell 5.1/7 preflight fixtures preserve successful and non-success shared envelopes without browser actions',t=>{
  const quote=value=>String(value).replaceAll("'","''");
  const args=fixture(t);
  const envelopes=[{...receipt(args),nativeReadback:{stage:'completed',code:'receipt_accepted',exitCode:0,durationMs:1,stderrPresent:false,stderrBytes:0}},
    {status:'managed_challenge',submissionAttempted:false,nativeReadback:{stage:'readback',code:'waf_present',exitCode:2,durationMs:2,stderrPresent:true,stderrBytes:10}},
    {status:'login_required',submissionAttempted:false,nativeReadback:{stage:'readback',code:'login_required',exitCode:2,durationMs:2,stderrPresent:false,stderrBytes:0}},
    nativePtReadFailure({nativeReadback:{stage:'timeout',code:'process_deadline',exitCode:null,durationMs:75000,stderrPresent:false,stderrBytes:0}})];
  const command=`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile('${quote(scripts+'Prepare-NativeWafSession.ps1')}',[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse failed'}
$function=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-MainChromeReadOnlyFallbackResult'},$true)[0]
. ([scriptblock]::Create($function.Extent.Text))
function Resolve-CheckinNode { 'Invoke-FakeReadEntry' }
function Join-Path { 'fixture-read-entry.mjs' }
function Invoke-FakeReadEntry { $script:received=@($args);$script:envelope }
$config=@{};$PSScriptRoot='fixture';$mainFallbackByOrigin=@{'${origin}'=[pscustomobject]@{url='${origin}/attendance.php'}}
$envelopes='${quote(JSON.stringify(envelopes))}' | ConvertFrom-Json
$rows=@(foreach($entry in $envelopes){$script:envelope=ConvertTo-Json -InputObject $entry -Depth 8 -Compress
$value=Invoke-MainChromeReadOnlyFallbackResult '${origin}' 90
[pscustomobject]@{status=$value.status;code=$value.nativeReadback.code;submitted=$value.submissionAttempted;account=$value.accountKey;binding=$value.profileBinding;args=$script:received}})
$script:envelope='{bad'
$invalid=Invoke-MainChromeReadOnlyFallbackResult '${origin}' 90
[pscustomobject]@{rows=$rows;invalid=$invalid.nativeReadback.code} | ConvertTo-Json -Depth 8 -Compress`;
  for(const shell of process.platform==='win32'?['powershell.exe','pwsh.exe']:['pwsh']){
    const result=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',timeout:60000}));
    assert.deepEqual(result.rows.map(row=>row.status),['already_signed','managed_challenge','login_required','unconfirmed']);
    assert.deepEqual(result.rows.map(row=>row.code),['receipt_accepted','waf_present','login_required','process_deadline']);
    for(const row of result.rows){assert.equal(row.submitted,false);assert.ok(row.args.includes(origin+'/index.php'));assert.equal(row.args.includes('-ReadOnly'),false);}
    assert.equal(result.rows[0].account,'site-default');assert.equal(result.rows[0].binding,receipt(args).profileBinding);
    assert.equal(result.invalid,'entrypoint_unavailable');
  }
});

test('timeout cleanup never kills a browser tree and task-window cleanup requires a unique HWND property',async()=>{
  const source=fs.readFileSync(scripts+'Cleanup-NativePtRead.ps1','utf8');
  assert.match(source,/Name -notin @\('powershell.exe','pwsh.exe','node.exe','conhost.exe'\)/);
  const executable=source.split(/\r?\n/).filter(line=>!line.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(executable,/Stop-Process[^\r\n]*-Name|taskkill\.exe|\/T\b/);
  assert.match(source,/GetProp\(\$handle,\('CheckinNativeReadOwner_'\+\$record.token\)\)/);
  const helper=fs.readFileSync(scripts+'Invoke-MainChromeCheckinAccessibility.ps1','utf8');
  assert.match(helper,/if \(\$ReadOnly -and \$LifecyclePath\)/);assert.match(helper,/SetProp\(\$handle/);
  assert.match(helper,/Register-NativeTaskWindow \$ownedStartupWindow[\s\S]*?RenderOffscreen\(\$taskHandle/);
});
