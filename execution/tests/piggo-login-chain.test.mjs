import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {loginHelperOutcome,parseLoginHelperResult} from '../src/login-recovery.mjs';
import {loginChainFixture} from './helpers/piggo-login-chain-fixture.mjs';

const chrome=process.platform==='win32'&&[
  path.join(process.env.ProgramFiles??'', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)']??'', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA??'', 'Google/Chrome/Application/chrome.exe'),
].some(file=>path.isAbsolute(file)&&fs.existsSync(file));
const skip=process.platform!=='win32'?'Windows native process/profile proof and DPAPI are required':
  !chrome?'Installed Chrome is required for the offline native CDP chain':false;
const wmi=process.platform==='win32'?spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',
  "$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$PID);if(-not $p){exit 1}"],
  {windowsHide:true,encoding:'utf8',timeout:15000}).status===0:false;

for(const shell of ['powershell.exe','pwsh.exe'])test(`offline native login chain preserves its lease through the real provider (${shell})`,
  {skip:skip||(!wmi?'Windows process enumeration (WMI/CIM) is unavailable; the core CDP chain is tested separately':false),timeout:120000},async t=>{
    const f=await loginChainFixture(t,{shell});
    const out=await f.run('Recover-NativeLogin.ps1',f.loginArgs);
    assert.deepEqual(f.errors,[]);
    const result=parseLoginHelperResult(out.stdout);
    assert.equal(out.code,0,JSON.stringify({result,stderr:out.stderr}));
    assert.equal(result.status,'logged_in');assert.equal(result.nativeTwoFactorRecovery.accepted,true);
    assert.equal(result.nativeTwoFactorRecovery.reason,'authentication_accepted');
    assert.equal(f.launches.length,1);
    assert.equal(f.requests.filter(row=>row.method==='POST').length,1);
    assert.equal(f.requests.find(row=>row.method==='POST').path,'/v1/web/login');
    assert.ok(f.requests.some(row=>row.path==='/v1/web/me'));
    const calls=f.calls();
    assert.deepEqual(calls.filter(row=>row.args[0]==='get').map(row=>row.args.slice(0,2)),
      [['get','username'],['get','password']]);
    assert.ok(calls.every(row=>row.engineRootMatched&&row.engineLeaseMatched&&row.outerMarkerMatched&&row.sessionMatched&&!row.nodeOptionsPresent));
    assert.equal(calls.filter(row=>row.args[0]==='sync').length,1);
    const journal=JSON.parse(fs.readFileSync(path.join(f.root,'data/bitwarden/recovery-state.json'),'utf8'));
    assert.equal(journal.attempts.length,1);assert.equal(journal.attempts[0].state,'accepted');
    assert.equal(fs.existsSync(path.join(f.root,'tmp/piggo-password-login.lock')),false);
    const audit=JSON.parse(fs.readFileSync(path.join(f.root,'data/native-pt-attempts.json'),'utf8'));
    assert.equal(audit.attempts.length,0);assert.ok(audit.readbacks.length>=1);
    assert.ok(audit.readbacks.every(row=>row.profileBinding===f.profileBinding&&row.status==='not_signed'));
    assert.equal(loginHelperOutcome(out.stdout).succeeded,true);
    assert.doesNotMatch(out.stdout+out.stderr,/synthetic-user|wo16-synthetic-only/);
  });

for(const shell of ['powershell.exe','pwsh.exe'])test(`offline core chain starts on about:blank and reaches the real credential helper with its inherited lease (${shell})`,
  {skip,timeout:120000},async t=>{
    const f=await loginChainFixture(t,{shell}),out=await f.runCore();
    assert.deepEqual(f.errors,[]);
    const result=parseLoginHelperResult(out.stdout);
    assert.equal(out.code,0,JSON.stringify({result,stderr:out.stderr}));
    assert.equal(result.nativeTwoFactorRecovery.reason,'authentication_accepted');
    assert.deepEqual(f.passiveReads()[0],{status:'login_required',failureCode:'login_required',apiStage:'authentication'});
    assert.equal(f.requests.filter(row=>row.method==='POST').length,1);
    const calls=f.calls();
    assert.deepEqual(calls.filter(row=>row.args[0]==='get').map(row=>row.args.slice(0,2)),
      [['get','username'],['get','password']]);
    assert.ok(calls.every(row=>row.engineRootMatched&&row.engineLeaseMatched&&row.outerMarkerMatched&&row.sessionMatched&&!row.nodeOptionsPresent));
    assert.doesNotMatch(out.stdout+out.stderr,/synthetic-user|wo16-synthetic-only/);
  });

test('an unavailable real passive probe reports its codes and never prepares credentials',
  {skip,timeout:120000},async t=>{
    const f=await loginChainFixture(t,{passive:'unavailable'}),out=await f.runCore();
    assert.deepEqual(f.errors,[]);assert.equal(out.code,2);
    assert.deepEqual(f.passiveReads(),[{status:'unconfirmed',failureCode:'authoritative_status_unavailable',apiStage:'http_status'}]);
    const outcome=loginHelperOutcome(out.stdout);
    assert.equal(outcome.recoveryReason,'passive_proof_unavailable');assert.equal(outcome.passiveStatus,'unconfirmed');
    assert.equal(outcome.passiveFailure,'authoritative_status_unavailable');assert.equal(outcome.passiveStage,'http_status');
    assert.equal(outcome.failureCode,'two_factor_required');assert.equal(outcome.retryable,false);
    assert.deepEqual(f.calls(),[]);assert.equal(f.requests.filter(row=>row.method!=='GET').length,0);
    assert.equal(fs.existsSync(path.join(f.root,'data/bitwarden/recovery-state.json')),false);
  });

for(const shell of ['powershell.exe','pwsh.exe'])test(`offline provider refuses absent lease environment before calling the fake CLI (${shell})`,
  {skip:process.platform!=='win32'?'Windows DPAPI provider is required':false,timeout:30000},async t=>{
    const f=await loginChainFixture(t,{shell}),env={...f.env};
    delete env.CHECKIN_V2_ENGINE_ROOT;delete env.CHECKIN_V2_ENGINE_LEASE;
    const out=await f.run('Get-BitwardenTotp.ps1',f.providerArgs,{env});
    assert.equal(out.code,0,out.stderr);assert.deepEqual(JSON.parse(out.stdout),{ready:false,reason:'login_not_allowed'});
    assert.deepEqual(f.calls(),[]);assert.deepEqual(f.requests,[]);
  });

for(const calendarMode of ['passive','submit','checked'])test(`offline core chain unlocks the real StepUpGate and completes its calendar in one context: ${calendarMode}`,
  {skip,timeout:120000},async t=>{
    const f=await loginChainFixture(t,{idleUnlock:true,calendarMode}),out=await f.runCore();
    assert.deepEqual(f.errors,[]);assert.equal(out.code,0,out.stderr);
    const result=parseLoginHelperResult(out.stdout);
    assert.equal(result.nativeTwoFactorRecovery.recoveryMode,'idle_unlock');assert.equal(result.nativeTwoFactorRecovery.accepted,true);
    assert.deepEqual(f.passiveReads()[0],{status:'login_required',failureCode:'idle_locked',apiStage:'idle_lock'});
    assert.deepEqual(f.requests.filter(row=>row.method==='POST').map(row=>row.path),[
      '/v1/web/me/lab-unlock/srp/challenge','/v1/web/me/lab-unlock/srp',
      ...(calendarMode==='submit'?['/v1/web/calendar/attendance']:[])]);
    assert.equal(result.dailyCheckin.status,{passive:'not_signed',submit:'signed',checked:'already_signed'}[calendarMode]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'data/bitwarden/recovery-state.json'))).attempts[0].state,'accepted');
    const audit=JSON.parse(fs.readFileSync(path.join(f.root,'data/native-pt-attempts.json')));
    assert.equal(audit.attempts.length,calendarMode==='submit'?1:0);
    if(calendarMode==='submit')assert.equal(audit.attempts[0].state,'confirmed');
    assert.doesNotMatch(out.stdout+out.stderr,/synthetic-user|wo16-synthetic-only|synthetic-bound-user|synthetic-m2/);
  });
