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
import {runHddolbyNativeFlow} from '../src/hddolby-native-flow.mjs';
import {recoverPtLogin,runHddolbyNative} from '../src/pt-login-recovery.mjs';
import {runPtSupplement} from '../src/pt-supplement.mjs';

const origin='https://www.uhddolby.com',old='https://www.hddolby.com';
const now=new Date('2026-10-24T04:00:00Z');

test('native attendance requires the existing parent intent and fresh unsigned proof, then uses the mature runner once',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-native-intent-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const controller=path.join(root,'controller'),id=crypto.randomUUID(),profileBinding='a'.repeat(64);
  for(const relative of ['data','controller/data','controller/outputs'])fs.mkdirSync(path.join(root,relative),{recursive:true});
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({v2ProjectRoot:controller}));
  fs.writeFileSync(path.join(controller,'data/harvest-fallback.lock'),JSON.stringify({pid:process.pid,nonce:'fixture-lease'}));
  const previous=process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=id;
  t.after(()=>{if(previous===undefined)delete process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID;else process.env.CHECKIN_PT_FALLBACK_ATTEMPT_ID=previous;});
  for(const issue of ['valid','missing_intent','wrong_worker','missing_unsigned','already_signed']){
    fs.writeFileSync(path.join(controller,'outputs/harvest-fallback-attempts-2026-10-24.json'),JSON.stringify({attempts:[{
      attemptId:issue==='missing_intent'?crypto.randomUUID():id,origin,accountKey:'site-default',state:'in_progress',
      workerPid:process.pid,workerNonce:issue==='wrong_worker'?'other':'fixture-lease',startedAt:now.toISOString(),
      recoveryEvidence:{profileBinding,evidence:{confirmedAt:now.toISOString()}}}]}));
    let submits=0,reads=0;
    const context={route:async()=>{},unroute:async()=>{}},page={url:()=>origin+'/index.php',context:()=>context};
    const args={root,page,mode:'Checkin',clock:()=>now,profileProof:async()=>true,
      config:{siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
        adapterId:'hddolby-nexus-stepup-v1',expectedAccountId:'7'}}},
      scope:async()=>({binding:{profileBinding},assertCurrent:async()=>true,release:async()=>{}}),
      readUnsigned:()=>issue==='missing_unsigned'?null:{origin,status:'not_signed',submissionAttempted:false,evidence:{
        source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-24',pagePath:'/log.php',statusSignal:'hddolby_account_header_unsigned'}},
      publishUnsigned:async({receipt})=>{assert.equal(receipt.status,'not_signed');assert.equal(receipt.submissionAttempted,false);},
      readHeader:async()=>{const signed=reads++>0||issue==='already_signed';return {status:signed?'already_signed':'not_signed',
        submissionAttempted:false,evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-24',
          pagePath:'/log.php',statusSignal:signed?'hddolby_account_header_signed':'hddolby_account_header_unsigned'}};},
      runTarget:async(actual,target,cfg)=>{submits++;assert.equal(actual,context);assert.deepEqual(target.candidates,[origin+'/attendance.php']);
        assert.equal(cfg.ptFallbackRecheck,true);return {status:'signed',submissionAttempted:true};}};
    if(['valid','already_signed'].includes(issue)){
      const value=await runHddolbyNativeFlow(args);assert.equal(value.status,issue==='valid'?'signed':'already_signed');
      assert.equal(value.submissionAttempted,issue==='valid');
    }else {const value=await runHddolbyNativeFlow(args);assert.equal(value.submissionAttempted,false);assert.equal(value.nativeFlow.code,'parent_intent_unavailable');}
    assert.equal(submits,issue==='valid'?1:0);
  }
});

test('PT supplement keeps native read, authentication-only recovery and formal attendance separate',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'uhdd-native-supplement-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile=path.join(root,'data/profile');
  for(const relative of ['config','data/profile'])fs.mkdirSync(path.join(root,relative),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'{}');
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:profile,
    siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,
      adapterId:'hddolby-nexus-stepup-v1',expectedAccountId:'7'}}}));
  fs.writeFileSync(path.join(root,'data/last-valid-bookmark-plan.json'),JSON.stringify({targets:[]}));
  const catalogFile=path.join(root,'catalog.json');fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const catalogHash=crypto.createHash('sha256').update(fs.readFileSync(catalogFile)).digest('hex');
  for(const variant of ['readonly','login-only','formal','already','login-required']){
    const calls=[];let logins=0,submissions=0;
    const value=await runPtSupplement({root,origin,catalogFile,catalogHash,now,readOnly:variant==='readonly',
      verifyBeforeSubmit:variant!=='readonly',loginRecoveryOnly:variant==='login-only',
      launch:async()=>{throw Error('Native session must not be replaced by a different browser context');},
      acquire:async()=>({}),release:async()=>{},
      recoverLogin:async()=>{logins++;return {handled:true,status:'logged_in'};},
      runHddolbyNative:async({mode})=>{calls.push(mode);
        if(variant==='login-required'&&calls.length===1)return {status:'login_required',submissionAttempted:false};
        const submitted=mode==='Checkin'&&variant!=='already',signed=submitted||variant==='already';if(submitted)submissions++;
        return {status:signed?'already_signed':'not_signed',submissionAttempted:submitted,
          evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-24',pagePath:'/log.php',
            statusSignal:signed?'hddolby_account_header_signed':'hddolby_account_header_unsigned'}};}});
    assert.equal(logins,variant==='login-required'?1:0);
    assert.equal(submissions,['formal','login-required'].includes(variant)?1:0);
    assert.deepEqual(calls,variant==='login-required'?['Checkin','Checkin']:['readonly','login-only'].includes(variant)?['ReadOnly']:['Checkin']);
    assert.equal(value.submissionAttempted,['formal','login-required'].includes(variant));
  }
});

test('the native read uses only its own browser session and never launches login or attendance',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const context=await browser.newContext(),page=await context.newPage(),requests=[];
    await context.route('**/*',route=>{
      requests.push(route.request().url());
      const body=route.request().url()===origin+'/login.php'
        ?'<form method="post" action="/takelogin.php"><input name="username"><input type="password" name="password">'+
          '<input name="2fa"><input name="imagestring"><input type="hidden" name="imagehash" value="fixture_hash">'+
          '<img width="120" height="30" src="/image.php?action=regimage&amp;imagehash=fixture_hash"><input type="submit"></form>'
        :'<div id="info_block"><a href="userdetails.php?id=7">Fixture</a><a href="logout.php">退出</a> (签到已得20)</div>'+
          '<a href="usercp.php">控制面板</a><a href="log.php">日志</a>';
      return route.fulfill({status:200,headers:{date:now.toUTCString(),'content-type':'text/html; charset=utf-8'},body});
    });
    await page.goto(origin+'/index.php');
    const args={root:'fixture',config:{siteTwoFactorRecovery:{[origin]:{
      enabled:true,reviewed:true,provider:'bitwarden',allowPasswordLogin:true,adapterId:'hddolby-nexus-stepup-v1',expectedAccountId:'7'}}},
      page,mode:'ReadOnly',clock:()=>now,profileProof:async()=>true,
      scope:async()=>({binding:{profileBinding:'a'.repeat(64)},assertCurrent:async()=>true,release:async()=>{}}),
      runTarget:async()=>{throw Error('A passive probe must never check in');}};
    const value=await runHddolbyNativeFlow(args);
    assert.equal(value.status,'already_signed');assert.equal(value.submissionAttempted,false);assert.equal(value.evidence.authoritative,true);
    assert.ok(requests.every(url=>[origin+'/index.php',origin+'/log.php'].includes(url)));
    assert.equal(JSON.stringify(value).includes('Fixture'),false);
    await page.goto(origin+'/login.php');requests.length=0;
    const settled=await runHddolbyNativeFlow(args);
    assert.equal(settled.status,'already_signed');assert.equal(settled.submissionAttempted,false);
    assert.ok(requests.every(url=>[origin+'/index.php',origin+'/log.php'].includes(url)));
    await context.close();
  }finally{await browser.close();}
});

test('native receipt projection rejects stale, wrong-profile and submitting read-only helpers without exposing raw output',async()=>{
  for(const issue of ['valid','profile','stale','submitted','signal']){
    const binding={accountKey:'site-default',profileBinding:'a'.repeat(64)};
    const root=path.resolve('synthetic-root'),profile=path.join(root,'data/profile');
    const payload={origin,status:'already_signed',accountKey:'site-default',profileBinding:binding.profileBinding,
      observedAt:now.toISOString(),businessDate:'2026-10-24',submissionAttempted:false,
      operationMode:'safe_history_page',readSafety:'reviewed_passive',privateFixture:'DO_NOT_PROPAGATE',
      evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-10-24',
        pagePath:'/log.php',statusSignal:'hddolby_account_header_signed'}};
    if(issue==='profile')payload.profileBinding='b'.repeat(64);
    if(issue==='stale')payload.observedAt='2026-10-23T04:00:00Z';
    if(issue==='submitted')payload.submissionAttempted=true;
    if(issue==='signal')payload.evidence.statusSignal='unreviewed';
    const result=await runHddolbyNative({root,origin,profile,mode:'ReadOnly',clock:()=>now,
      config:{savedLoginUrls:{[origin]:origin+'/login.php'},siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,
        provider:'bitwarden',adapterId:'hddolby-nexus-stepup-v1',allowPasswordLogin:true}}},
      scope:async()=>({binding,assertCurrent:async()=>true,release:async()=>{}}),
      execute:async(_shell,args)=>{assert.ok(args.includes('ReadOnly'));return {stdout:JSON.stringify(payload),stderr:'DO_NOT_PROPAGATE'};}});
    assert.equal(result.status,issue==='valid'?'already_signed':'needs_attention');
    assert.doesNotMatch(JSON.stringify(result),/DO_NOT_PROPAGATE|privateFixture|stdout|stderr/);
  }
});
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
