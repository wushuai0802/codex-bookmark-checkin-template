import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'node:test';
import {execLoginHelper,killLoginHelperTree,loginHelperTimeout} from '../src/login-helper-process.mjs';

const execute=promisify(execFile);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const temporary=t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'wo18-helper-'));
  t.after(()=>{
    for(const name of ['pids.json','node.pid','chrome.pid']){
      const file=path.join(root,name);if(!fs.existsSync(file))continue;
      const raw=fs.readFileSync(file,'utf8'),pids=name==='pids.json'?JSON.parse(raw):[Number(raw)];
      for(const pid of pids)if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}
    }
    fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });return root;
};

test('native helper timeouts retain the 60 second cleanup margin and PT duration',()=>{
  assert.equal(loginHelperTimeout('https://piggo.me'),300000);
  assert.equal(loginHelperTimeout('https://tracker.example'),180000);
});

test('Windows tree kill is exact-PID, hidden, bounded and injectable',async()=>{
  let call;
  await killLoginHelperTree(123,{platform:'win32',execute:async(...args)=>{call=args;}});
  assert.deepEqual(call,['taskkill.exe',['/PID','123','/T','/F'],{windowsHide:true,timeout:10000}]);
  await assert.rejects(()=>killLoginHelperTree(undefined),/PID/);
});

test('successful helpers retain stdout/stderr and never invoke tree termination',async()=>{
  const output={stdout:'synthetic',stderr:'synthetic warning'};
  assert.deepEqual(await execLoginHelper('fake',[],{timeout:25},{execute:async(_file,_args,options)=>{
    assert.equal(options.timeout,0);return output;
  },killTree:()=>assert.fail('unexpected kill')}),output);
});

test('native PigGo entrypoint exits after emitting its result even if CDP disconnect never settles',async t=>{
  const root=temporary(t),execution=fileURLToPath(new URL('../',import.meta.url));
  fs.cpSync(path.join(execution,'src'),path.join(root,'src'),{recursive:true});
  fs.symlinkSync(path.join(execution,'node_modules'),path.join(root,'node_modules'),'junction');
  fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/config.json'),'{}');
  const hooks=path.join(root,'hooks.mjs');
  fs.writeFileSync(hooks,`import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(url===new URL('./src/native-cdp.mjs',import.meta.url).href)return {format:'module',shortCircuit:true,source:
  'export async function connectOverCdpWithRetry(){setInterval(()=>{},1000);return {contexts:()=>[{pages:()=>[{url:()=>"about:blank"}]}],close:()=>new Promise(()=>{})};}'};
 if(url===new URL('./src/piggo-login.mjs',import.meta.url).href)return {format:'module',shortCircuit:true,source:
  'export async function recoverPiggoSpaLogin(){return {status:"logged_in",nativeTwoFactorRecovery:{accepted:true}};}'};
 return next(url,context);
}});`);
  const output=await execute(process.execPath,['--import',pathToFileURL(hooks).href,path.join(root,'src/native-login.mjs'),
    '12345','https://piggo.me',path.join(root,'synthetic-profile')],{windowsHide:true,timeout:12000});
  assert.equal(JSON.parse(output.stdout).status,'logged_in');assert.equal(output.stderr,'');
});

test('timeout kills the helper and its descendant before returning, despite partial output',async t=>{
  const root=temporary(t),pidFile=path.join(root,'pids.json'),script=path.join(root,'helper.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));
console.log('synthetic partial');setInterval(()=>{},1000);
`);
  t.after(async()=>{if(fs.existsSync(pidFile))for(const pid of JSON.parse(fs.readFileSync(pidFile)))
    if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}});
  const started=performance.now();
  let killError;
  await assert.rejects(execLoginHelper(process.execPath,[script],{timeout:1500,windowsHide:true},{killTree:async pid=>{
    try{await killLoginHelperTree(pid);}catch(error){killError=error;throw error;}
  }}),error=>{
    assert.equal(error.code,'ETIMEDOUT');return true;
  });
  assert.ok(performance.now()-started<15000);
  const pids=JSON.parse(fs.readFileSync(pidFile));assert.equal(pids.length,2);
  if(process.platform==='win32'&&killError?.code===1){
    t.skip('Windows taskkill /T denied by this host; injected PID/tree contract is covered separately');return;
  }
  assert.equal(killError,undefined,killError?.stderr);
  for(let tries=0;tries<40&&pids.some(alive);tries++)await pause(50);
  for(const pid of pids)assert.equal(alive(pid),false,'synthetic descendant still alive');
});

for(const shell of ['powershell.exe','pwsh.exe'])test(`PigGo inner timeout drains both streams, ends node and runs Chrome finally (${shell})`,
  {skip:process.platform!=='win32'?'Windows wrapper required':false,timeout:25000},async t=>{
    const root=temporary(t);
    for(const folder of ['src','scripts','config','data/profile'])fs.mkdirSync(path.join(root,folder),{recursive:true});
    // Execute the real wrapper with a shortened constant. The only mocked
    // boundaries are launching/enumerating a synthetic Chrome-shaped process.
    const wrapper=fs.readFileSync(new URL('../scripts/Recover-NativeLogin.ps1',import.meta.url),'utf8');
    assert.ok(wrapper.includes('$TimeoutMs = 240000'));
    fs.writeFileSync(path.join(root,'scripts/Recover-NativeLogin.ps1'),wrapper.replace('$TimeoutMs = 240000','$TimeoutMs = 1000'));
    fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({nodeExecutable:process.execPath,automationUserDataDir:path.join(root,'data/profile')}));
    fs.copyFileSync(new URL('../scripts/Resolve-Runtime.ps1',import.meta.url),path.join(root,'scripts/Resolve-Runtime.ps1'));
    fs.writeFileSync(path.join(root,'src/native-login.mjs'),`import fs from 'node:fs';import {fileURLToPath} from 'node:url';
fs.writeFileSync(fileURLToPath(new URL('../node.pid',import.meta.url)),String(process.pid));
process.stdout.write('synthetic-output\\n'+'x'.repeat(200000));process.stderr.write('y'.repeat(200000));setInterval(()=>{},1000);
`);
    fs.writeFileSync(path.join(root,'src/fake-chrome.mjs'),'setInterval(()=>{},1000);');
    fs.writeFileSync(path.join(root,'scripts/Native-ChromeDebug.ps1'),`
function Reset-NativeChromeDebugPort { }
function Get-NativeChromeDebugPort { 12345 }
function Wait-NativeChromeDebugPort { 12345 }
function Get-CimInstance {
 param($ClassName,$Filter)
 $file=Join-Path $root 'chrome.pid'
 if(Test-Path -LiteralPath $file){[pscustomobject]@{ProcessId=[int](Get-Content -LiteralPath $file);ParentProcessId=$PID;CommandLine=$profilePath}}
}
`);
    fs.writeFileSync(path.join(root,'scripts/Open-PlainLoginChrome.ps1'),`
param($Urls,[switch]$Offscreen,[switch]$EnablePasswordManager,[switch]$DeferPiggoNavigation,$RemoteDebuggingPort,$UserDataDirOverride)
$fake=Join-Path $PSScriptRoot '../src/fake-chrome.mjs'
$p=Start-Process -FilePath $node -ArgumentList ('"'+$fake+'"') -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText((Join-Path $root 'chrome.pid'),[string]$p.Id)
`);
    t.after(()=>{for(const name of ['node.pid','chrome.pid']){const file=path.join(root,name);
      if(fs.existsSync(file)){const pid=Number(fs.readFileSync(file,'utf8'));if(alive(pid))try{process.kill(pid,'SIGKILL');}catch{}}}});
    let failure;
    try{await execute(shell,['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/Recover-NativeLogin.ps1'),
      '-Origin','https://piggo.me'],{windowsHide:true,timeout:20000,maxBuffer:1024*1024});}
    catch(error){failure=error;}
    assert.ok(failure);assert.equal(typeof failure.code,'number');
    assert.match(failure.stdout,/synthetic-output/);assert.ok(failure.stdout.length>=200000);
    assert.match(failure.stderr,/timed out/);
    for(const name of ['node.pid','chrome.pid'])assert.equal(alive(Number(fs.readFileSync(path.join(root,name),'utf8'))),false,name);
  });
