import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import net from 'node:net';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {piggoOrigin as origin,piggoCalendarUrl,piggoAttendanceUrl,piggoDay} from '../../src/piggo-calendar.mjs';

const execute=promisify(execFile);
const execution=fileURLToPath(new URL('../../',import.meta.url));
const observation=fileURLToPath(new URL('../../../observation/',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","''")+"'";
const itemId='10000000-0000-4000-8000-000000000001';
const vaultUserId='20000000-0000-4000-8000-000000000002';
const serverUrl='https://vault.example';
const loginFields={username:'synthetic-user',password:['wo16','synthetic','only'].join('-')};

// Only the launch/transport boundary is replaced. Recover-NativeLogin,
// Native-ChromeDebug, native-login, both lease validators, profile proof, the
// bookmark gate, form review, firewalls and the provider run their real code.
const launcher=`param([string[]]$Urls,[switch]$Offscreen,[switch]$EnablePasswordManager,
 [switch]$DeferPiggoNavigation,[int]$RemoteDebuggingPort,[string]$UserDataDirOverride)
$ErrorActionPreference='Stop'
$body=@{urls=@($Urls);offscreen=[bool]$Offscreen;passwordManager=[bool]$EnablePasswordManager;
 deferred=[bool]$DeferPiggoNavigation;port=$RemoteDebuggingPort;profile=$UserDataDirOverride}|ConvertTo-Json -Compress
$request=[Net.WebRequest]::Create($env:WO16_FIXTURE_URL+'/launch')
$request.Proxy=$null;$request.Method='POST';$request.ContentType='application/json';$request.Timeout=30000
$bytes=[Text.Encoding]::UTF8.GetBytes($body);$request.ContentLength=$bytes.Length
$stream=$request.GetRequestStream();try{$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
$response=$request.GetResponse();$response.Dispose()
`;

export async function loginChainFixture(t,{shell='pwsh.exe',passive='logged_out',idleUnlock=false,calendarMode='passive'}={}){
  const root=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),'piggo-login-chain-')));
  let context,fixtureServer;
  t.after(async()=>{
    await context?.close().catch(()=>{});
    if(fixtureServer){fixtureServer.closeAllConnections();await new Promise(resolve=>fixtureServer.close(resolve));}
    fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  const controller=path.join(root,'controller'),profile=path.join(root,'data','synthetic profile');
  for(const directory of ['scripts','config','tmp','data/bitwarden/client','tools/bitwarden-cli',
    'controller/config','controller/data','controller/src','unrelated-cwd'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  fs.cpSync(path.join(execution,'src'),path.join(root,'src'),{recursive:true});
  fs.cpSync(path.join(observation,'src'),path.join(controller,'src'),{recursive:true});
  fs.cpSync(path.join(observation,'public'),path.join(controller,'public'),{recursive:true});
  fs.copyFileSync(path.join(observation,'package.json'),path.join(controller,'package.json'));
  // Dependency resolution only; no real runtime/profile/config is linked.
  fs.symlinkSync(path.join(execution,'node_modules'),path.join(root,'node_modules'),'junction');
  for(const file of ['Recover-NativeLogin.ps1','Native-ChromeDebug.ps1','Get-BitwardenTotp.ps1','Resolve-Runtime.ps1'])
    fs.copyFileSync(path.join(execution,'scripts',file),path.join(root,'scripts',file));
  fs.writeFileSync(path.join(root,'scripts/Open-PlainLoginChrome.ps1'),launcher);
  const profileBinding=crypto.createHash('sha256').update(profile.toLowerCase()).digest('hex');
  const nonce=crypto.randomUUID(),route={enabled:true,itemName:'piggo.me',itemId,
    accountKey:'site-default',profileBinding,adapterId:'piggo-nexus-stepup-v1'};
  const config={nodeExecutable:process.execPath,powershellExecutable:shell,automationUserDataDir:profile,
    bookmarksPath:path.join(root,'synthetic-bookmarks.json'),mobileFolderIds:['10'],targetFolderNames:['PT'],
    nativeWafPreflightUrls:[{url:calendarMode==='submit'?piggoAttendanceUrl:piggoCalendarUrl,automationUserDataDir:profile,passiveOnly:calendarMode!=='submit'}],
    oauthExpectedAccountIds:{[origin]:'42'},
    ptReadOnlyPolicies:{[origin]:{reviewed:true,piggoCalendar:true,mode:'safe_history_page',url:piggoCalendarUrl,
      selector:'.cal-page',loginPath:'/login',actionPath:'/v1/web/calendar/attendance',
      nativeIsolatedChrome:true,nativeApiHeaderFallback:true,nativeApiExecution:true,proxyServer:'http://127.0.0.1:1'}},
    nativePtTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
      loginSource:'bitwarden',spaPasswordFormReviewed:true}},
    bitwardenTotp:{enabled:true,serverUrl,cliEntryPoint:path.join(root,'tools/bitwarden-cli/bw.js'),
      appDataDir:path.join(root,'data/bitwarden/client'),sessionFile:path.join(root,'data/bitwarden/session.dpapi'),
      routes:{[origin]:route}}};
  const save=()=>fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  fs.writeFileSync(config.bookmarksPath,JSON.stringify({roots:{other:{type:'folder',name:'fixture',id:'10',children:[
    {type:'folder',name:'PT',id:'11',children:[{type:'url',name:'synthetic',url:piggoCalendarUrl}]}]}}}));
  const write=(file,value)=>fs.writeFileSync(path.join(root,file),JSON.stringify(value));
  write('data/v2-integration.json',{executionEngine:'v1',v2ProjectRoot:controller});
  write('controller/config/runtime.local.json',{executionEngine:'v1',legacyRoot:root});
  write('controller/data/v2-run.lock',{nonce,pid:process.pid});
  write('tmp/run.lock',{nonce:crypto.randomUUID(),pid:process.pid});
  fs.writeFileSync(config.bitwardenTotp.cliEntryPoint,`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),data=process.env.BITWARDENCLI_APPDATA_DIR;
fs.appendFileSync(path.join(data,'calls.jsonl'),JSON.stringify({args,
 engineRootMatched:process.env.CHECKIN_V2_ENGINE_ROOT===${JSON.stringify(controller+path.sep)},
 engineLeaseMatched:process.env.CHECKIN_V2_ENGINE_LEASE===${JSON.stringify(nonce)},
 outerMarkerMatched:process.env.WO16_CHAIN_SENTINEL==='synthetic-outer',
 sessionMatched:process.env.BW_SESSION==='A'.repeat(40),nodeOptionsPresent:!!process.env.NODE_OPTIONS})+'\\n');
if(args[0]==='status')process.stdout.write(JSON.stringify({status:'unlocked',serverUrl:${JSON.stringify(serverUrl)},userId:${JSON.stringify(vaultUserId)}}));
else if(args[0]==='sync')process.stdout.write('synthetic sync');
else if(args[0]==='get'&&args[2]===${JSON.stringify(itemId)}&&['username','password'].includes(args[1]))
 process.stdout.write(${JSON.stringify(loginFields)}[args[1]]);
else process.exitCode=3;
`);
  const payload=path.join(root,'synthetic-payload.json');
  fs.writeFileSync(payload,JSON.stringify({schemaVersion:1,serverUrl,origin,itemName:route.itemName,itemId,vaultUserId,
    profileBinding,session:'A'.repeat(40),createdAtUtc:'2025-01-01T00:00:00Z'}));
  // Protect only this freshly generated synthetic payload; no password manager
  // or real enrollment/session is read, unlocked or contacted.
  const protect=`$ErrorActionPreference='Stop';$p=Get-Content -LiteralPath ${quote(payload)} -Raw|ConvertFrom-Json;
$p|Add-Member windowsSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$s=ConvertTo-SecureString ($p|ConvertTo-Json -Compress) -AsPlainText -Force
try{[IO.File]::WriteAllText(${quote(config.bitwardenTotp.sessionFile)},(@{schemaVersion=1;protection='CurrentUserDPAPI';
 protectedPayload=ConvertFrom-SecureString $s}|ConvertTo-Json -Compress))}finally{$s.Dispose()}`;
  await execute('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(protect,'utf16le').toString('base64')],
    {windowsHide:true,timeout:15000});
  fs.rmSync(payload);
  const requests=[],launches=[],errors=[];let authenticated=idleUnlock,unlocked=!idleUnlock,signed=calendarMode==='checked';
  const serve=async intercepted=>{
    const request=intercepted.request(),url=new URL(request.url()),method=request.method();
    requests.push({method,path:url.pathname});
    assert.equal(url.origin,origin,'the fixture never forwards a request');
    let status=200,contentType='application/json',body={};
    if(method==='GET'&&['/calendar','/login','/locked'].includes(url.pathname)){
      contentType='text/html';
      body='<meta charset="utf-8"><link rel="icon" href="data:,">'+(url.pathname==='/calendar'?
        `<main class="cal-page"><div class="cal-att"></div></main><script>
Promise.all([fetch('/v1/web/me'),fetch('/v1/web/calendar').then(r=>r.json())]).then(([,data])=>{
 if(data.detail?.attendance?.status!=='today')return;
 const button=document.createElement('button');button.className='cal-att-pill act';button.textContent='签到 · +10';
 button.onclick=async()=>{await fetch('/v1/web/calendar/attendance',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({ymd:data.selected})});button.remove();};document.querySelector('.cal-att').append(button);
});
</script>`:url.pathname==='/locked'?
        `<style>.username-a11y{display:none}</style><h1>页面已锁定</h1><p>空闲过久，请验证是你本人。</p>
<form class="step-up"><input class="username-a11y" type="text" name="username" autocomplete="username" readonly tabindex="-1" value="synthetic-bound-user">
<p>验证后继续使用。</p><label>当前密码<input class="cell-input" type="password" name="password" autocomplete="current-password webauthn" required placeholder="当前密码"></label>
<button class="passkey-btn" type="button">通行密钥</button><button class="btn" type="submit">解锁</button></form><script>
document.querySelector('form').onsubmit=async event=>{event.preventDefault();
 if(document.querySelector('[name=username]').value!=='synthetic-bound-user'||document.querySelector('[name=password]').value!==${JSON.stringify(loginFields.password)})throw Error('Synthetic fields changed');
 await fetch('/v1/web/me/lab-unlock/srp/challenge',{method:'POST',body:'{}'});
 await fetch('/v1/web/me/lab-unlock/srp',{method:'POST',headers:{'Content-Type':'application/json'},
 body:JSON.stringify({ticket:'synthetic-ticket',a:'synthetic-a',m1:'synthetic-proof'})});
 await fetch('/v1/web/me/lab-lock',{method:'POST'}).catch(()=>{});
};</script>`:
        `<main id="app"></main><script>
fetch('/v1/web/auth/guest-config').then(()=>{
document.querySelector('#app').innerHTML='<h1>用账号登录</h1><form><input type="text" name="username" autocomplete="username webauthn"><input type="password" name="password" autocomplete="current-password webauthn"><button>登录</button></form>';
document.querySelector('form').onsubmit=async event=>{event.preventDefault();
await fetch('/v1/web/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
 username:document.querySelector('[name=username]').value,password:document.querySelector('[name=password]').value})});
// A second POST must be stopped by the real login firewall.
await fetch('/v1/web/login',{method:'POST',body:'{}'}).catch(()=>{});
};});
</script>`);
    }else if(method==='GET'&&url.pathname==='/v1/web/auth/guest-config')body={captcha:false};
    else if(method==='GET'&&['/v1/web/me','/v1/web/calendar'].includes(url.pathname)){
      if(!authenticated){status=passive==='unavailable'?503:401;}
      else if(!unlocked){status=423;body={code:'idle_locked',msg:'synthetic',data:{}};}
      else if(url.pathname==='/v1/web/me')body={user:{id:42}};
      else{const today=piggoDay(new Date());body={cells:[],selected:today,detail:{ymd:today,is_today:true,attendance:{status:signed?'checked':'today'}}};}
    }else if(method==='POST'&&url.pathname==='/v1/web/login'){
      assert.deepEqual(request.postDataJSON(),loginFields);authenticated=true;
    }else if(method==='POST'&&url.pathname==='/v1/web/me/lab-unlock/srp/challenge'){
      assert.equal(idleUnlock,true);body={code:0,msg:'synthetic',data:{i:'synthetic-i',s:'synthetic-s',B:'synthetic-b',ticket:'synthetic-ticket'}};
    }else if(method==='POST'&&url.pathname==='/v1/web/me/lab-unlock/srp'){
      assert.equal(idleUnlock,true);assert.deepEqual(request.postDataJSON(),{ticket:'synthetic-ticket',a:'synthetic-a',m1:'synthetic-proof'});
      unlocked=true;body={code:0,msg:'synthetic',data:{m2:'synthetic-m2'}};
    }else if(method==='POST'&&url.pathname==='/v1/web/calendar/attendance'){
      assert.equal(calendarMode,'submit');assert.equal(authenticated&&unlocked,true);
      const today=piggoDay(new Date());assert.deepEqual(request.postDataJSON(),{ymd:today});signed=true;
      body={cells:[],selected:today,detail:{ymd:today,is_today:true,attendance:{status:'checked'}}};
    }else throw Error('Unexpected synthetic request');
    await intercepted.fulfill({status,contentType,headers:{date:new Date().toUTCString()},
      body:typeof body==='string'?body:JSON.stringify(body)});
  };
  const launchContext=async port=>{
    context=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:true,serviceWorkers:'block',
      proxy:{server:config.ptReadOnlyPolicies[origin].proxyServer},
      args:[`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1',
        '--host-resolver-rules=MAP * ~NOTFOUND','--disable-background-networking','--enable-automation']});
    assert.deepEqual(context.pages().map(page=>page.url()),['about:blank']);
    assert.ok(fs.existsSync(path.join(profile,'Local State')));
    await context.route('**/*',route=>serve(route).catch(async error=>{errors.push(error);await route.abort().catch(()=>{});}));
  };
  fixtureServer=http.createServer(async(request,response)=>{
    if(request.method!=='POST'||request.url!=='/launch'){response.writeHead(403).end();return;}
    try{
      let body='';for await(const part of request)body+=part;
      const launch=JSON.parse(body);launches.push(launch);
      assert.equal(launch.profile,profile);assert.equal(launch.deferred,true);
      assert.equal(launch.offscreen,true);assert.equal(launch.passwordManager,false);
      assert.deepEqual(launch.urls,[origin+'/login']);
      await launchContext(launch.port);
      response.writeHead(200).end();
    }catch(error){errors.push(error);response.writeHead(500).end();}
  });
  // The proxy is a closed boundary: even Chrome background requests/CONNECT
  // can only reach this loopback listener and are never forwarded elsewhere.
  fixtureServer.on('connect',(_request,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${fixtureServer.address().port}`;
  config.ptReadOnlyPolicies[origin].proxyServer=url;save();
  // run-v1-engine derives its root from new URL('../'), so the real value ends in a separator.
  const env={...process.env,CHECKIN_V2_ENGINE_ROOT:controller+path.sep,CHECKIN_V2_ENGINE_LEASE:nonce,
    WO16_CHAIN_SENTINEL:'synthetic-outer',WO16_FIXTURE_URL:url};
  for(const key of Object.keys(env))if(/^(?:BW_|PIGGO_BW_|BITWARDENCLI_APPDATA_DIR$|NODE_OPTIONS$|NODE_PATH$|CHECKIN_LEGACY_ROOT$)/i.test(key))delete env[key];
  const run=async(file,args=[],overrides={})=>{
    try{return {code:0,...await execute(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.join(root,'scripts',file),...args],{cwd:path.join(root,'unrelated-cwd'),env,windowsHide:true,encoding:'utf8',
      timeout:90000,maxBuffer:65536,...overrides})};}
    catch(error){if(typeof error.code!=='number')throw error;return {code:error.code,stdout:error.stdout,stderr:error.stderr};}
  };
  const calls=()=>{
    const file=path.join(config.bitwardenTotp.appDataDir,'calls.jsonl');
    return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse):[];
  };
  // Fallback for hosts that deny WMI: the same recovery branch gets a real
  // Chrome command-line/profile proof over CDP. The production WMI function
  // and native entrypoint are deliberately not patched or claimed covered.
  const runCore=async()=>{
    const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
    const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
    await launchContext(port);
    fs.writeFileSync(path.join(root,'src/wo16-offline-core.mjs'),`import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {recoverPiggoSpaLogin} from './piggo-login.mjs';
import fs from 'node:fs';
import {readNativePtApiHeaderInContext} from './native-pt-api.mjs';
import {validateEngineLease} from '../controller/src/legacy-engine.mjs';
import {runNativePtGate} from './native-pt-gate.mjs';
const {chromium}=createRequire(import.meta.url)('playwright-core');
const browser=await chromium.connectOverCDP('http://127.0.0.1:${port}');
const session=await browser.newBrowserCDPSession();
const profileProof=async()=>{const {arguments:args}=await session.send('Browser.getBrowserCommandLine');
 return args.includes('--user-data-dir='+${JSON.stringify(profile)})&&args.includes('--remote-debugging-port=${port}')&&browser.contexts().length===1;};
const passiveReads=[];
const readHeader=async options=>{const value=await readNativePtApiHeaderInContext(options);
 passiveReads.push({status:value.status,failureCode:value.failureCode,apiStage:value.nativeReadback?.apiStage});return value;};
try{assert.equal(validateEngineLease({root:${JSON.stringify(controller)},legacyRoot:${JSON.stringify(root)}}),true);
assert.equal(await profileProof(),true);
const bound=await runNativePtGate({root:${JSON.stringify(root)},origin:${JSON.stringify(origin)},url:${JSON.stringify(piggoCalendarUrl)},
 profile:${JSON.stringify(profile)},phase:'bind'});assert.equal(bound.managed,true);assert.equal(bound.allow,true);
const result=await recoverPiggoSpaLogin({root:${JSON.stringify(root)},profile:${JSON.stringify(profile)},
 page:browser.contexts()[0].pages()[0],profileProof,readHeader});
 fs.writeFileSync(${JSON.stringify(path.join(root,'tmp/passive-reads.json'))},JSON.stringify(passiveReads));
 console.log(JSON.stringify(result));if(result.status!=='logged_in')process.exitCode=2;
}finally{await browser.close();}
`);
    fs.writeFileSync(path.join(root,'scripts/Recover-OfflineFixture.ps1'),
      `& ${quote(process.execPath)} (Join-Path $PSScriptRoot '../src/wo16-offline-core.mjs')\nexit $LASTEXITCODE\n`);
    return run('Recover-OfflineFixture.ps1');
  };
  return {root,controller,profile,profileBinding,config,env,save,requests,launches,errors,calls,run,runCore,
    passiveReads:()=>JSON.parse(fs.readFileSync(path.join(root,'tmp/passive-reads.json'),'utf8')),
    loginArgs:['-Origin',origin,'-LoginUrl',origin+'/login','-UserDataDirOverride',profile],
    providerArgs:['-Root',root,'-Origin',origin,'-ProfileBinding',profileBinding,'-Mode','Login']};
}
