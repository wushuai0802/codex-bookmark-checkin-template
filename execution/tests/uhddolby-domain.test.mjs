import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {ptReadPolicy} from '../src/pt-read-policy.mjs';
import {readHddolbyHeader} from '../src/hddolby-readonly.mjs';
import {withBitwardenLogin,bitwardenTotpSiteContracts} from '../src/bitwarden-totp.mjs';
import {inspectHhclubLogin} from '../src/hhclub-two-factor-login.mjs';

const origin='https://www.uhddolby.com',old='https://www.hddolby.com';
const now=new Date('2026-10-24T04:00:00Z');
test('the new domain has its own passive capability and keeps its existing vault item identity',async()=>{
  const policy=ptReadPolicy(origin);assert.equal(policy.url,origin+'/log.php');assert.equal(policy.hddolbyHeader,true);
  assert.equal(bitwardenTotpSiteContracts[origin].itemName,'www.hddolby.com');
  const visited=[];
  const context={request:{get:async url=>{visited.push(url);return {url:()=>url,status:()=>200,headers:()=>({date:now.toUTCString()}),text:async()=>url};}}};
  const result=await readHddolbyHeader(context,{origin,now,expectedAccountId:'7',extractHeader:async()=>({authenticated:true,userIds:['7'],
    logLinked:true,text:'鲸币 (签到已得20)',unsigned:false})});
  assert.equal(result.status,'already_signed');assert.equal(result.evidence.authoritative,true);
  assert.deepEqual(visited,[origin+'/index.php',origin+'/log.php']);
  const login=await readHddolbyHeader({request:{get:async url=>({url:()=>url,status:()=>302,headers:()=>({location:'/login.php'})})}},{origin,now});
  assert.equal(login.status,'login_required');assert.equal(login.submissionAttempted,false);
});

test('selected vault login fields stay inside an explicitly opted-in same-site consumer and are cleared afterwards',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-login-provider-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data/bitwarden/client'),{recursive:true});fs.mkdirSync(path.join(root,'tools/bitwarden-cli'),{recursive:true});
  const binding={accountKey:'site-default',adapterId:'hddolby-nexus-stepup-v1',profileBinding:'a'.repeat(64)};
  const config={bitwardenTotp:{enabled:true,serverUrl:'https://vault.example',periodSeconds:30,
    cliEntryPoint:path.join(root,'tools/bitwarden-cli/cli.js'),appDataDir:path.join(root,'data/bitwarden/client'),
    sessionFile:path.join(root,'data/bitwarden/session.dpapi'),routes:{[origin]:{enabled:true,...binding,itemId:crypto.randomUUID(),itemName:'www.hddolby.com'}}},
    siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,allowPasswordLogin:true,loginSource:'bitwarden'}}};
  const expected={username:['fixture','user'].join('_'),password:['fixture','only','value'].join('_')};let retained,calls=0;
  const execute=async(_file,args)=>{calls++;assert.equal(args.at(-1),'Login');return {stdout:JSON.stringify({ready:true,reason:'login_ready',...expected}),stderr:''};};
  const result=await withBitwardenLogin({root,origin,binding,config,execute,consume:async credential=>{assert.deepEqual(credential,expected);retained=credential;}});
  assert.deepEqual(result,{ready:true,reason:'login_consumed'});assert.deepEqual(retained,{username:'',password:''});assert.equal(calls,1);
  assert.equal(JSON.stringify(result).includes(expected.password),false);
  config.siteTwoFactorRecovery[origin].allowPasswordLogin=false;
  assert.equal((await withBitwardenLogin({root,origin,binding,config,execute,consume:async()=>{throw Error('unexpected');}})).ready,false);
  assert.equal(calls,1);
});

test('the mature Nexus inspector accepts the new domain 2fa/imagehash form without assuming HHCLUB secret fields',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage();
    await context.route('**/*',async route=>{
      if(route.request().url()!==origin+'/login.php'){await route.abort();return;}
      await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:
        '<form method="post" action="/takelogin.php"><input name="username" value="fixture_user">'+
        '<input type="password" name="password" value="synthetic"><input name="2fa">'+
        '<input name="imagestring"><input type="hidden" name="imagehash" value="fixture_hash">'+
        '<img width="120" height="30" src="/image.php?action=regimage&amp;imagehash=fixture_hash"><input type="submit"></form>'});
    });
    await page.goto(origin+'/login.php');
    const form=await inspectHhclubLogin(page,{origin});
    assert.equal(form.hiddenReady,true);assert.equal(form.passwordFilled,true);assert.equal(form.otpReady,true);
    assert.equal(form.captchaImageReady,true);assert.equal(form.submitReady,true);assert.equal(form.captchaFilled,false);
    assert.equal(await inspectHhclubLogin(page,{origin:'https://other.example'}),null);
    await context.close();
  }finally{await browser.close();}
});

test('the local migration moves one sealed destination while retaining item, Profile, other grants and the protected session',
  {skip:process.platform!=='win32'},async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-domain-migration-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    for(const folder of ['config','scripts','data/bitwarden/client','tools/bitwarden-cli','controller/data','controller/config'])fs.mkdirSync(path.join(root,folder),{recursive:true});
    const scripts=new URL('../scripts/',import.meta.url);
    for(const name of ['Manage-BitwardenTotp.ps1','Get-BitwardenTotp.ps1','Resolve-Runtime.ps1'])fs.copyFileSync(new URL(name,scripts),path.join(root,'scripts',name));
    const itemId=crypto.randomUUID(),vaultUserId=crypto.randomUUID(),profileBinding='a'.repeat(64);
    const authorization={origin:old,accountKey:'site-default',profileBinding,itemId,itemName:'www.hddolby.com',adapterId:'hddolby-nexus-stepup-v1'};
    const other={origin:'https://piggo.me',accountKey:'site-default',profileBinding:'b'.repeat(64),itemId:crypto.randomUUID(),itemName:'piggo.me',adapterId:'piggo-nexus-stepup-v1'};
    const cfg={nodeExecutable:process.execPath,bookmarksPath:path.join(root,'Bookmarks'),
      bitwardenTotp:{enabled:true,serverUrl:'https://vault.example',cliEntryPoint:path.join(root,'tools/bitwarden-cli/cli.js'),
        appDataDir:path.join(root,'data/bitwarden/client'),sessionFile:path.join(root,'data/bitwarden/session.dpapi'),routes:{[old]:{...authorization,enabled:true},[other.origin]:{...other,enabled:true}}},
      ptReadOnlyPolicies:{[old]:{reviewed:true,mode:'safe_history_page',url:old+'/log.php',selector:'#info_block',hddolbyHeader:true}},
      siteTwoFactorRecovery:{[old]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId:authorization.adapterId,expectedAccountId:'7',usernameHash:'c'.repeat(64)}},
      disabledAccountKeys:['paused-account'],savedLoginUrls:{}};
    for(const name of ['config.json','config.local.json'])fs.writeFileSync(path.join(root,'config',name),JSON.stringify(cfg));
    const fixtureUsername=['fixture','user'].join('_'),fixtureValue=['fixture','only','value'].join('_');
    fs.writeFileSync(path.join(root,'tools/bitwarden-cli/cli.js'),[
      'const a=process.argv.slice(2);',
      `if(a[0]==='status')console.log(JSON.stringify({status:'unlocked',serverUrl:'https://vault.example',userId:${JSON.stringify(vaultUserId)}}));`,
      `else if(a[0]==='get'&&a[1]==='username')console.log(${JSON.stringify(fixtureUsername)});`,
      `else if(a[0]==='get'&&a[1]==='password')console.log(${JSON.stringify(fixtureValue)});`,
      'else process.exit(2);'
    ].join('\n'));
    const catalog=path.join(root,'controller/data/catalog.json');fs.writeFileSync(catalog,JSON.stringify({scope:{folderId:'20',parentId:'10'}}));
    fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:path.join(root,'controller'),harvestPtGate:{catalogFile:catalog}}));
    fs.writeFileSync(cfg.bookmarksPath,JSON.stringify({roots:{bookmark_bar:{id:'1',children:[{id:'10',children:[{id:'20',children:[{type:'url',id:'30',url:origin+'/attendance.php'}]}]}]}}}));
    const payload={schemaVersion:2,serverUrl:cfg.bitwardenTotp.serverUrl,vaultUserId,session:'A'.repeat(48),createdAtUtc:now.toISOString(),authorizations:[authorization,other]};
    const encode=Buffer.from(JSON.stringify(payload)).toString('base64');
    const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const security="Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop;";
    const init=security+"$v=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHECKIN_MIGRATION_FIXTURE))|ConvertFrom-Json;$v|Add-Member windowsSid ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value);$s=ConvertTo-SecureString ($v|ConvertTo-Json -Compress -Depth 8) -AsPlainText -Force;[IO.File]::WriteAllText($env:CHECKIN_MIGRATION_SESSION,(@{schemaVersion=2;protection='CurrentUserDPAPI';protectedPayload=(ConvertFrom-SecureString $s)}|ConvertTo-Json -Compress));$s.Dispose()";
    await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',init],{windowsHide:true,env:{...process.env,CHECKIN_MIGRATION_FIXTURE:encode,CHECKIN_MIGRATION_SESSION:cfg.bitwardenTotp.sessionFile}});
    const backup=path.join(root,'backup'),{stdout}=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/Manage-BitwardenTotp.ps1'),'-Action','MigrateHddolbyDomain','-BackupRoot',backup],{windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(JSON.parse(stdout.trim()).migrated,true);
    const after=JSON.parse(fs.readFileSync(path.join(root,'config/config.json'),'utf8'));
    assert.equal(after.bitwardenTotp.routes[old],undefined);assert.equal(after.bitwardenTotp.routes[origin].itemId,itemId);
    assert.equal(after.bitwardenTotp.routes[origin].profileBinding,profileBinding);assert.deepEqual(after.bitwardenTotp.routes[other.origin],cfg.bitwardenTotp.routes[other.origin]);
    assert.equal(after.ptReadOnlyPolicies[origin].url,origin+'/log.php');assert.deepEqual(after.disabledAccountKeys,cfg.disabledAccountKeys);
    const decode=security+"$v=Get-Content -LiteralPath $env:CHECKIN_MIGRATION_SESSION -Raw|ConvertFrom-Json;$s=ConvertTo-SecureString $v.protectedPayload;$p=([Net.NetworkCredential]::new('',$s)).Password|ConvertFrom-Json;[pscustomobject]@{newOrigin=$p.authorizations[0].origin;sameSession=($p.session-eq ('A'*48));otherOrigin=$p.authorizations[1].origin}|ConvertTo-Json -Compress;$s.Dispose()";
    const checked=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-Command',decode],{windowsHide:true,encoding:'utf8',env:{...process.env,CHECKIN_MIGRATION_SESSION:cfg.bitwardenTotp.sessionFile}});
    assert.deepEqual(JSON.parse(checked.stdout.trim()),{newOrigin:origin,sameSession:true,otherOrigin:other.origin});
    assert.equal(fs.existsSync(path.join(backup,'session.dpapi.json')),true);
    const repeated=await promisify(execFile)(ps,['-NoProfile','-NonInteractive','-File',path.join(root,'scripts/Manage-BitwardenTotp.ps1'),'-Action','MigrateHddolbyDomain','-BackupRoot',backup],{windowsHide:true,encoding:'utf8',timeout:15000});
    assert.equal(JSON.parse(repeated.stdout.trim()).alreadyConfigured,true);
    const controller=path.join(root,'controller'),lease=crypto.randomUUID();
    fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
    fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({pid:process.pid,nonce:lease}));
    const previous=[process.env.CHECKIN_V2_ENGINE_ROOT,process.env.CHECKIN_V2_ENGINE_LEASE];
    process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=lease;
    try{
      let consumed=false;
      const result=await withBitwardenLogin({root,origin,config:after,binding:{accountKey:'site-default',profileBinding,adapterId:authorization.adapterId},
        consume:async credential=>{assert.equal(credential.username,fixtureUsername);assert.equal(credential.password,fixtureValue);consumed=true;}});
      assert.deepEqual(result,{ready:true,reason:'login_consumed'});assert.equal(consumed,true);assert.equal(JSON.stringify(result).includes(fixtureValue),false);
      delete process.env.CHECKIN_V2_ENGINE_LEASE;
      const blocked=await withBitwardenLogin({root,origin,config:after,binding:{accountKey:'site-default',profileBinding,adapterId:authorization.adapterId},consume:async()=>{throw Error('unexpected');}});
      assert.equal(blocked.ready,false);assert.equal(blocked.reason,'login_not_allowed');
    }finally{
      for(const [i,key] of ['CHECKIN_V2_ENGINE_ROOT','CHECKIN_V2_ENGINE_LEASE'].entries()){
        if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];
      }
    }
  });
