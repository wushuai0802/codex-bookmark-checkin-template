import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {unstablePowerShellPath,powerShellExecutablePresent,powerShellRuntimeHealth,configuredPowerShellRuntimeHealth,selectPowerShell} from '../src/powershell-runtime.mjs';

const env={ProgramFiles:'C:\\Program Files',LOCALAPPDATA:'C:\\Accounts\\example\\AppData\\Local',SystemRoot:'C:\\Windows',
  Path:'C:\\Tools\\.cache\\codex-runtimes\\native;D:\\Shared\\PowerShell'};
test('setup prefers installed PowerShell over private runtime entries on PATH or in answers',async()=>{
  const installed='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  assert.equal(await selectPowerShell({env,configured:'D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe',exists:()=>true}),installed);
  assert.equal(await selectPowerShell({env,exists:p=>!p.startsWith(env.ProgramFiles)}),
    path.win32.join(env.LOCALAPPDATA,'Microsoft','WindowsApps','pwsh.exe'));
  assert.equal(await selectPowerShell({env,exists:p=>p.startsWith('D:\\Shared')}),'D:\\Shared\\PowerShell\\pwsh.exe');
  await assert.rejects(selectPowerShell({env,exists:p=>unstablePowerShellPath(p)}),/stable PowerShell/);
});
test('runtime health rejects missing, relative and tool-private executables without exposing their paths',()=>{
  for(const value of ['D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe','D:\\Editor\\dependencies\\native\\pwsh.exe',
    'D:\\Editor\\.vscode\\extensions\\powershell\\pwsh.exe','pwsh.exe']) {
    const result=powerShellRuntimeHealth(value,{exists:()=>true});assert.equal(result.stable,false);
    assert.deepEqual(Object.keys(result),['present','stable']);
  }
  assert.deepEqual(powerShellRuntimeHealth('C:\\Program Files\\PowerShell\\7\\pwsh.exe',{exists:()=>false}),{present:false,stable:true});
  assert.deepEqual(powerShellRuntimeHealth('C:\\Program Files\\PowerShell\\7\\pwsh.exe',{exists:()=>true}),{present:true,stable:true});
});
test('a WindowsApps execution alias remains usable when stat denies access, but missing or cached targets do not',()=>{
  const alias=path.win32.join(env.LOCALAPPDATA,'Microsoft','WindowsApps','pwsh.exe');
  const target='C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_fixture\\pwsh.exe';
  const options={exists:p=>p===target,lstat:()=>({isSymbolicLink:()=>true}),readlink:()=>target};
  assert.equal(powerShellExecutablePresent(alias,options),true);
  assert.equal(powerShellExecutablePresent(alias,{...options,exists:()=>false}),false);
  assert.equal(powerShellExecutablePresent(alias,{...options,exists:()=>true,readlink:()=>target}),true);
  assert.equal(powerShellExecutablePresent(alias,{...options,exists:p=>p!==alias,readlink:()=> 'D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe'}),false);
  assert.equal(powerShellExecutablePresent(alias,{...options,exists:()=>true,readlink:()=> 'D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe'}),false);
  assert.equal(powerShellExecutablePresent('D:\\Missing\\pwsh.exe',options),false);
});
test('health CLI checks only the configured executable and emits booleans',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shell-health-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=path.join(root,'config.json');fs.writeFileSync(config,JSON.stringify({powershellExecutable:'D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe'}));
  const cli=fileURLToPath(new URL('../src/powershell-runtime.mjs',import.meta.url));
  assert.deepEqual(JSON.parse(execFileSync(process.execPath,[cli,config],{encoding:'utf8'})),{present:false,stable:false});
});
test('health also rejects an unstable active observation override when execution uses a stable shell',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'shell-override-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const directory of ['config','data','observer/config'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  const config=path.join(root,'config/config.json'),stable='C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  fs.writeFileSync(config,JSON.stringify({powershellExecutable:stable}));
  fs.writeFileSync(root+'/data/v2-integration.json',JSON.stringify({executionEngine:'v1',v2ProjectRoot:root+'/observer'}));
  fs.writeFileSync(root+'/observer/config/runtime.local.json',JSON.stringify({powershellExecutable:'D:\\Tools\\.cache\\codex-runtimes\\pwsh.exe'}));
  assert.deepEqual(configuredPowerShellRuntimeHealth(config,{exists:()=>true}),{present:true,stable:false});
  fs.writeFileSync(root+'/observer/config/runtime.local.json',JSON.stringify({powershellExecutable:stable}));
  assert.deepEqual(configuredPowerShellRuntimeHealth(config,{exists:()=>true}),{present:true,stable:true});
  assert.deepEqual(configuredPowerShellRuntimeHealth(config,{exists:()=>false}),{present:false,stable:true});
});
