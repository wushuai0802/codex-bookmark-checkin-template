import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {bitwardenTotpConfiguration,bitwardenTotpSiteContracts,prepareBitwardenTotp,withBitwardenTotp} from '../src/bitwarden-totp.mjs';

// Synthetic fixtures only: no production client, vault, Chrome, account or seed.
const origin='https://piggo.me', binding='a'.repeat(64), server='https://vault.example.test:8443';
const itemId='10000000-0000-4000-8000-000000000001', vaultUserId='20000000-0000-4000-8000-000000000002';
const otp='246810', privateMarker='SYNTHETIC_VAULT_PRIVATE_VALUE';
const fixtureRoot=path.join(os.tmpdir(),'checkin-bw-fixture');
const supportedSites=[
  {origin,itemName:'piggo.me',adapterId:'piggo-nexus-stepup-v1',itemId,profileBinding:binding},
  {origin:'https://www.hddolby.com',itemName:'www.hddolby.com',adapterId:'hddolby-nexus-stepup-v1',
    itemId:'10000000-0000-4000-8000-000000000003',profileBinding:'b'.repeat(64)},
  {origin:'https://hhanclub.net',itemName:'hhanclub.net',adapterId:'hhclub-nexus-login-v1',
    itemId:'10000000-0000-4000-8000-000000000004',profileBinding:'c'.repeat(64)},
];
const authorization=site=>({origin:site.origin,accountKey:'site-default',profileBinding:site.profileBinding,
  itemId:site.itemId,itemName:site.itemName,adapterId:site.adapterId});
const routeFor=site=>({enabled:true,...authorization(site)});
const siteBinding=site=>({accountKey:'site-default',profileBinding:site.profileBinding,adapterId:site.adapterId});
function configuration(root=fixtureRoot) {
  return {bitwardenTotp:{enabled:true,serverUrl:server,periodSeconds:30,
    cliEntryPoint:path.join(root,'tools','bitwarden-cli','build','bw.js'),
    appDataDir:path.join(root,'data','bitwarden','piggo','client'),
    sessionFile:path.join(root,'data','bitwarden','piggo','session.json'),
    routes:{[origin]:{enabled:true,itemName:'piggo.me',itemId,profileBinding:binding}}}};
}
function setup(overrides={}) {
  const calls=[], config=configuration();
  const args={root:fixtureRoot,origin,binding,config,clock:()=>10_000,
    consume:()=>{},execute:async(file,args,options)=>{
      calls.push({file,args,options});
      return {stdout:JSON.stringify(args.includes('Prepare') ? {ready:true,reason:'prepared'}
        : {ready:true,reason:'totp_ready',code:otp,validUntilMs:30_000}),stderr:privateMarker};
    },...overrides};
  return {args,calls};
}
function publicOnly(result) {
  assert.deepEqual(Object.keys(result).sort(),['ready','reason']);
  const serialized=JSON.stringify(result);
  for (const value of [otp,privateMarker,server,vaultUserId,itemId]) assert.ok(!serialized.includes(value));
}

test('configuration is disabled by default and limited to the reviewed site/account binding',()=>{
  assert.deepEqual(bitwardenTotpConfiguration({},fixtureRoot,origin,binding),{ready:false,reason:'disabled'});
  assert.equal(bitwardenTotpConfiguration(configuration(),fixtureRoot,'https://other.example',binding).reason,'origin_not_allowed');
  assert.equal(bitwardenTotpConfiguration(configuration(),fixtureRoot,origin,'b'.repeat(64)).reason,'profile_mismatch');
  assert.equal(bitwardenTotpConfiguration(configuration(),fixtureRoot,origin,{accountKey:'wrong',profileBinding:binding}).reason,'profile_mismatch');
  const valid=bitwardenTotpConfiguration(configuration(),fixtureRoot,origin,{accountKey:'site-default',profileBinding:binding});
  assert.equal(valid.ready,true);
  assert.equal(valid.itemId,itemId);
});

test('configuration refuses repository, external paths, credentials URLs, noncanonical items and unsafe helpers',()=>{
  const repository=fileURLToPath(new URL('../../',import.meta.url));
  assert.equal(bitwardenTotpConfiguration(configuration(repository),repository,origin,binding).ready,false);
  for (const change of [
    {serverUrl:'http://vault.example.test'}, {serverUrl:'https://name:password@vault.example.test'},
    {serverUrl:`${server}?key=value`}, {serverUrl:`${server}/api`}, {serverUrl:origin},
    {cliEntryPoint:path.join(fixtureRoot,'src','bw.js')},
    {appDataDir:path.join(fixtureRoot,'data','bitwarden-other','client')},
    {sessionFile:path.join(fixtureRoot,'data','session.json')}, {cliEntryPoint:'bw.js'},
    {appDataDir:'relative'}, {periodSeconds:60}, {periodSeconds:'30'},
  ]) {
    const config=configuration(); Object.assign(config.bitwardenTotp,change);
    assert.equal(bitwardenTotpConfiguration(config,fixtureRoot,origin,binding).reason,'invalid_configuration');
  }
  for (const change of [{itemName:'other'},{itemId:'piggo.me'},{itemId:undefined},{enabled:'true'}]) {
    const config=configuration(); Object.assign(config.bitwardenTotp.routes[origin],change);
    assert.equal(bitwardenTotpConfiguration(config,fixtureRoot,origin,binding).ready,false);
  }
  const config=configuration(); config.powershellExecutable='cmd.exe';
  assert.equal(bitwardenTotpConfiguration(config,fixtureRoot,origin,binding).ready,false);
});

test('additional reviewed adapters require the exact caller and configured account/protocol tuple',()=>{
  assert.deepEqual(Object.keys(bitwardenTotpSiteContracts),[
    ...supportedSites.slice(0,2).map(site=>site.origin),'https://www.uhddolby.com',supportedSites[2].origin,
  ]);
  assert.deepEqual(bitwardenTotpSiteContracts['https://www.uhddolby.com'],bitwardenTotpSiteContracts['https://www.hddolby.com']);
  const config=configuration();
  for(const site of supportedSites)config.bitwardenTotp.routes[site.origin]=routeFor(site);
  for(const site of supportedSites.slice(1)){
    const valid=bitwardenTotpConfiguration(config,fixtureRoot,site.origin,siteBinding(site));
    assert.equal(valid.ready,true);assert.equal(valid.adapterId,site.adapterId);assert.equal(valid.itemId,site.itemId);
    for(const caller of [site.profileBinding,{profileBinding:site.profileBinding},
      {...siteBinding(site),adapterId:'piggo-nexus-stepup-v1'},{...siteBinding(site),accountKey:'other'}]){
      assert.equal(bitwardenTotpConfiguration(config,fixtureRoot,site.origin,caller).reason,'profile_mismatch');
    }
    for(const change of [{itemName:'piggo.me'},{adapterId:undefined},{accountKey:undefined},{adapterId:'unreviewed'}]){
      const changed=structuredClone(config);Object.assign(changed.bitwardenTotp.routes[site.origin],change);
      assert.equal(bitwardenTotpConfiguration(changed,fixtureRoot,site.origin,siteBinding(site)).ready,false);
    }
  }
  assert.equal(bitwardenTotpConfiguration(config,fixtureRoot,'https://github.com',siteBinding(supportedSites[0])).reason,'origin_not_allowed');
});

test('additional adapters forward only their exact non-secret binding to the protected helper',async()=>{
  for(const site of supportedSites.slice(1)){
    const config=configuration();config.bitwardenTotp.routes[site.origin]=routeFor(site);
    const {args,calls}=setup({config,origin:site.origin,binding:siteBinding(site)});
    assert.deepEqual(await prepareBitwardenTotp(args),{ready:true,reason:'prepared'});
    const forwarded=calls[0].args;
    assert.equal(forwarded[forwarded.indexOf('-AccountKey')+1],'site-default');
    assert.equal(forwarded[forwarded.indexOf('-AdapterId')+1],site.adapterId);
    assert.equal(forwarded[forwarded.indexOf('-ProfileBinding')+1],site.profileBinding);
    assert.ok(!forwarded.includes(itemId));assert.ok(!forwarded.includes(site.itemId));
  }
});

test('additional adapters reserve twelve seconds and recover at most one TOTP rotation',async()=>{
  for(const site of supportedSites.slice(1)){
    const config=configuration();config.bitwardenTotp.routes[site.origin]=routeFor(site);
    let now=19_000,reads=0;const sleeps=[],seen=[];
    const {args}=setup({config,origin:site.origin,binding:siteBinding(site),clock:()=>now,
      sleep:async ms=>{sleeps.push(ms);now+=ms;},consume:code=>seen.push(code),execute:async()=>{
        reads++;return {stdout:JSON.stringify({ready:true,reason:'totp_ready',code:otp,validUntilMs:60_000})};
      }});
    assert.deepEqual(await withBitwardenTotp(args),{ready:true,reason:'totp_consumed'});
    assert.deepEqual(sleeps,[11_250]);assert.equal(reads,1);assert.deepEqual(seen,[otp]);
    const policy=bitwardenTotpConfiguration(config,fixtureRoot,site.origin,siteBinding(site));
    assert.equal(policy.minimumValidityMs,12_000);
  }
  assert.equal(bitwardenTotpConfiguration(configuration(),fixtureRoot,origin,binding).minimumValidityMs,6_000);
});

test('a new adapter discards a code that loses its twelve-second validity margin during the helper call',async()=>{
  const site=supportedSites[1],config=configuration();config.bitwardenTotp.routes[site.origin]=routeFor(site);
  let now=14_000,reads=0;const seen=[];
  const {args}=setup({config,origin:site.origin,binding:siteBinding(site),clock:()=>now,
    sleep:async ms=>{now+=ms;},consume:code=>seen.push(code),execute:async()=>{
      reads++;if(reads===1)now=20_000;
      return {stdout:JSON.stringify({ready:true,reason:'totp_ready',code:reads===1?otp:'135790',validUntilMs:reads===1?30_000:60_000})};
    }});
  assert.deepEqual(await withBitwardenTotp(args),{ready:true,reason:'totp_consumed'});
  assert.equal(reads,2);assert.deepEqual(seen,['135790']);
});

test('Prepare calls only the metadata/cache helper and clears inherited vault secrets',async()=>{
  process.env.BW_SESSION=privateMarker;
  process.env.BW_PASSWORD=privateMarker;
  const {args,calls}=setup();
  const result=await prepareBitwardenTotp(args);
  assert.deepEqual(result,{ready:true,reason:'prepared'});
  assert.equal(calls.length,1);
  assert.ok(calls[0].args.includes('Prepare'));
  assert.ok(!calls[0].args.includes('--session'));
  assert.equal(calls[0].options.env.BW_SESSION,undefined);
  assert.equal(calls[0].options.env.BW_PASSWORD,undefined);
  assert.equal(process.env.BW_SESSION,undefined);
  assert.equal(process.env.BW_PASSWORD,undefined);
  assert.equal(calls[0].options.windowsHide,true);
  publicOnly(result);
});

test('disabled or mismatched scope never calls a provider',async()=>{
  for (const change of [{origin:'https://other.example'},{binding:'b'.repeat(64)},{config:{}}]) {
    const {args,calls}=setup(change);
    const result=await withBitwardenTotp(args);
    assert.equal(result.ready,false);
    assert.equal(calls.length,0);
    publicOnly(result);
  }
});

test('TOTP is delivered in memory while code, validUntil and consumer return stay private',async()=>{
  let received;
  const {args,calls}=setup({consume:(code,metadata)=>{received={code,...metadata};return {code,privateMarker};}});
  const result=await withBitwardenTotp(args);
  assert.deepEqual(received,{code:otp,validUntilMs:30_000});
  assert.deepEqual(result,{ready:true,reason:'totp_consumed'});
  assert.equal(calls.length,1);
  publicOnly(result);
});

for (const reason of ['session_missing','session_invalid','session_unavailable','vault_locked','vault_unauthenticated',
  'server_mismatch','vault_sync_failed','provider_busy','cli_status_failed','totp_read_failed']) {
  test(`${reason} stops recovery without leaking raw CLI diagnostics`,async()=>{
    const {args}=setup({execute:async()=>({stdout:JSON.stringify({ready:false,reason,code:otp,session:privateMarker}),stderr:privateMarker}),
      consume:()=>assert.fail('unavailable providers must never consume')});
    const result=await withBitwardenTotp(args);
    assert.deepEqual(result,{ready:false,reason}); publicOnly(result);
  });
}

test('raw helper failures and malformed JSON cannot leave the provider',async()=>{
  for (const execute of [
    async()=>{throw Object.assign(new Error(privateMarker),{stdout:otp,stderr:privateMarker});},
    async()=>({stdout:privateMarker,stderr:otp}),
    async()=>({stdout:JSON.stringify({ready:false,reason:privateMarker,code:otp})}),
    async()=>({stdout:JSON.stringify({ready:true,reason:'prepared',code:otp})}),
  ]) {
    const {args}=setup({execute});
    const result=await prepareBitwardenTotp(args); assert.equal(result.ready,false); publicOnly(result);
  }
});

test('invalid codes and invalid expiry never reach a consumer',async()=>{
  for (const code of ['', '12345', '1234567', '123 456', `${otp}\n123456`, privateMarker]) {
    const {args}=setup({execute:async()=>({stdout:JSON.stringify({ready:true,reason:'totp_ready',code,validUntilMs:30_000})}),
      consume:()=>assert.fail('invalid code consumed')});
    const result=await withBitwardenTotp(args); assert.equal(result.reason,'totp_invalid'); publicOnly(result);
  }
  let calls=0;
  const {args}=setup({execute:async()=>{calls++;return {stdout:JSON.stringify({ready:true,reason:'totp_ready',code:otp,validUntilMs:60_000})};},
    consume:()=>assert.fail('wrong period consumed')});
  assert.equal((await withBitwardenTotp(args)).reason,'totp_near_rotation');
  assert.equal(calls,2);
});

test('consumer exceptions are sanitized',async()=>{
  const {args}=setup({consume:code=>{throw new Error(`${code} ${privateMarker}`);}});
  const result=await withBitwardenTotp(args);
  assert.deepEqual(result,{ready:false,reason:'totp_consumer_failed'}); publicOnly(result);
});

test('boundary wait is bounded to one rotation and also accepts a Date clock',async()=>{
  let now=29_000; const sleeps=[];
  const {args,calls}=setup({clock:()=>new Date(now),sleep:async ms=>{sleeps.push(ms);now+=ms;},
    execute:async()=>({stdout:JSON.stringify({ready:true,reason:'totp_ready',code:otp,validUntilMs:60_000})})});
  assert.equal((await withBitwardenTotp(args)).ready,true);
  assert.deepEqual(sleeps,[1250]); assert.equal(calls.length,0);
});

test('a crossing read is reread once and only the fresh code reaches the consumer',async()=>{
  let now=23_000, calls=0; const seen=[];
  const {args}=setup({clock:()=>now,consume:code=>seen.push(code),execute:async()=>{
    calls++; now=30_100;
    return {stdout:JSON.stringify({ready:true,reason:'totp_ready',code:calls===1?otp:'135790',validUntilMs:calls===1?30_000:60_000})};
  }});
  assert.equal((await withBitwardenTotp(args)).ready,true); assert.equal(calls,2); assert.deepEqual(seen,['135790']);
});

test('repeated crossing and a sleep that does not advance time stop without loops',async()=>{
  let now=23_000, calls=0;
  const {args}=setup({clock:()=>now,execute:async()=>{
    calls++; const oldExpiry=(Math.floor(now/30_000)+1)*30_000; now=oldExpiry+100;
    return {stdout:JSON.stringify({ready:true,reason:'totp_ready',code:otp,validUntilMs:oldExpiry})};
  }});
  assert.equal((await withBitwardenTotp(args)).reason,'totp_near_rotation'); assert.equal(calls,2);
  let sleeps=0;
  const fixture=setup({clock:()=>29_000,sleep:async()=>{sleeps++;}});
  assert.equal((await withBitwardenTotp(fixture.args)).reason,'totp_near_rotation');
  assert.equal(sleeps,1); assert.equal(fixture.calls.length,0);
});

test('invalid, backward and failing clocks never deliver a TOTP',async()=>{
  for (const clock of [()=>NaN,()=>-1,()=>{throw new Error(privateMarker);}]) {
    const {args,calls}=setup({clock});
    assert.equal((await withBitwardenTotp(args)).reason,'clock_invalid'); assert.equal(calls.length,0);
  }
  let ticks=0;
  const {args}=setup({clock:()=>ticks++===0?10_000:9_000});
  assert.equal((await withBitwardenTotp(args)).reason,'clock_unstable');
});

test('a failed boundary wait returns a safe reason and no provider call',async()=>{
  const {args,calls}=setup({clock:()=>29_000,sleep:async()=>{throw new Error(`${otp} ${privateMarker}`);}});
  const result=await withBitwardenTotp(args);
  assert.deepEqual(result,{ready:false,reason:'totp_wait_failed'});assert.equal(calls.length,0);publicOnly(result);
});

test('a near-rotation helper result is retried once without exposing an old code',async()=>{
  let now=23_000,calls=0;const seen=[];
  const {args}=setup({clock:()=>now,consume:code=>seen.push(code),execute:async()=>{
    calls++;now=30_100;
    return {stdout:JSON.stringify(calls===1?{ready:false,reason:'totp_near_rotation',code:otp}:
      {ready:true,reason:'totp_ready',code:'135790',validUntilMs:60_000})};
  }});
  assert.deepEqual(await withBitwardenTotp(args),{ready:true,reason:'totp_consumed'});
  assert.equal(calls,2);assert.deepEqual(seen,['135790']);
});

const executionRoot=fileURLToPath(new URL('../',import.meta.url));
function protectedFixture(t,payloadOverrides={},ruleOverrides={},options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-bw-ps-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const config=configuration(root);
  Object.assign(config.bitwardenTotp,ruleOverrides);
  if(options.multisite)for(const site of supportedSites)config.bitwardenTotp.routes[site.origin]=routeFor(site);
  for (const directory of [path.join(root,'scripts'),path.join(root,'config'),path.dirname(config.bitwardenTotp.cliEntryPoint),config.bitwardenTotp.appDataDir]) fs.mkdirSync(directory,{recursive:true});
  for (const file of ['Get-BitwardenTotp.ps1','Manage-BitwardenTotp.ps1','Resolve-Runtime.ps1']) fs.copyFileSync(path.join(executionRoot,'scripts',file),path.join(root,'scripts',file));
  fs.writeFileSync(path.join(root,'config','config.json'),JSON.stringify(config));
  fs.writeFileSync(config.bitwardenTotp.cliEntryPoint,`const fs=require('node:fs'),path=require('node:path');
const data=process.env.BITWARDENCLI_APPDATA_DIR; const mode=JSON.parse(fs.readFileSync(path.join(data,'mode.json'),'utf8'));
const args=process.argv.slice(2);fs.appendFileSync(path.join(data,'calls.jsonl'),JSON.stringify({args,sessionPresent:process.env.BW_SESSION==='A'.repeat(40),nodeOptionsPresent:!!process.env.NODE_OPTIONS})+'\\n');
process.stderr.write('${privateMarker}');
if(args[0]==='status')process.stdout.write(JSON.stringify({status:mode.status||'unlocked',serverUrl:mode.server||'${server}',userId:mode.userId||'${vaultUserId}',userEmail:'synthetic-private@vault.example'}));
else if(args[0]==='sync'){if(mode.syncFails)process.exitCode=2;else{if(mode.changeAccountAfterSync){mode.userId='30000000-0000-4000-8000-000000000003';fs.writeFileSync(path.join(data,'mode.json'),JSON.stringify(mode));}process.stdout.write('Sync complete.');}}
else if(args[0]==='get'&&args[1]==='totp'&&${JSON.stringify(supportedSites.map(site=>site.itemId))}.includes(args[2]))process.stdout.write(mode.code??'${otp}');
else if(args[0]==='unlock'||args[0]==='login')process.stdout.write('B'.repeat(40));
else if(args[0]==='lock')process.exitCode=0;
else process.exitCode=3;`);
  fs.writeFileSync(path.join(config.bitwardenTotp.appDataDir,'mode.json'),'{}');
  const source=path.join(root,'fixture-payload.json');
  fs.writeFileSync(source,JSON.stringify({schemaVersion:1,serverUrl:server,origin,itemName:'piggo.me',itemId,vaultUserId,
    profileBinding:binding,session:'A'.repeat(40),createdAtUtc:'2025-01-01T00:00:00.000Z',...payloadOverrides}));
  const protect=`$ErrorActionPreference='Stop';$jsonOptions=@{};if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$jsonOptions.DateKind='String'};`+
    `$payload=Get-Content -LiteralPath $args[0] -Raw|ConvertFrom-Json @jsonOptions;`+
    `if(-not $payload.PSObject.Properties['windowsSid']){$payload|Add-Member -NotePropertyName windowsSid -NotePropertyValue ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)};`+
    `$secure=ConvertTo-SecureString ($payload|ConvertTo-Json -Compress -Depth 4) -AsPlainText -Force;`+
    `$outer=@{schemaVersion=${options.outerSchemaVersion??1};protection='CurrentUserDPAPI';protectedPayload=ConvertFrom-SecureString $secure};`+
    `[IO.File]::WriteAllText($args[1],($outer|ConvertTo-Json -Compress));$secure.Dispose()`;
  const quote=value=>`'${value.replaceAll("'","''")}'`;
  execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',`& {${protect}} ${quote(source)} ${quote(config.bitwardenTotp.sessionFile)}`],{windowsHide:true,encoding:'utf8'});
  fs.rmSync(source);
  return {root,config,origin,binding,mode:value=>fs.writeFileSync(path.join(config.bitwardenTotp.appDataDir,'mode.json'),JSON.stringify(value)),
    calls:()=>fs.existsSync(path.join(config.bitwardenTotp.appDataDir,'calls.jsonl'))?
      fs.readFileSync(path.join(config.bitwardenTotp.appDataDir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse):[]};
}

function multiFixture(t,overrides={},options={}){
  return protectedFixture(t,{schemaVersion:2,authorizations:supportedSites.map(authorization),...overrides},{},
    {multisite:true,outerSchemaVersion:2,...options});
}

for(const shell of ['powershell.exe','pwsh.exe'])test(`Windows schema-2 three-site authorization shares one daily client sync (${shell})`,
  {skip:process.platform!=='win32'},async t=>{
    const fixture=multiFixture(t,{}, {outerSchemaVersion:shell==='powershell.exe'?1:2});fixture.config.powershellExecutable=shell;
    fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(fixture.config));
    for(const site of supportedSites){
      const scoped={...fixture,origin:site.origin,binding:siteBinding(site)};
      assert.deepEqual(await prepareBitwardenTotp(scoped),{ready:true,reason:'prepared'});
      let consumed,consumptions=0;
      assert.deepEqual(await withBitwardenTotp({...scoped,consume:code=>{consumed=code;consumptions++;}}),{ready:true,reason:'totp_consumed'});
      assert.equal(consumed,otp);
      assert.equal(consumptions,1);
    }
    assert.equal(fixture.calls().filter(call=>call.args[0]==='sync').length,1);
    const requested=fixture.calls().filter(call=>call.args[0]==='get').map(call=>call.args[2]);
    assert.deepEqual([...new Set(requested)],supportedSites.map(site=>site.itemId));
    for(const site of supportedSites){
      const count=requested.filter(id=>id===site.itemId).length;
      assert.ok(count>=1&&count<=2,'only one bounded rotation reread is allowed per route');
    }
    const marker=JSON.parse(fs.readFileSync(path.join(fixture.root,'data/bitwarden/sync-state.json'),'utf8'));
    assert.equal(marker.schemaVersion,2);
    const actualClient=fs.statSync(marker.appDataDir),configuredClient=fs.statSync(fixture.config.bitwardenTotp.appDataDir);
    assert.equal(actualClient.dev,configuredClient.dev);assert.equal(actualClient.ino,configuredClient.ino);
    assert.equal(marker.itemId,undefined);assert.equal(marker.profileBinding,undefined);
  });

test('Windows schema-1 credentials cannot authorize an additional site by changing config',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t,{}, {},{multisite:true});
    for(const site of supportedSites.slice(1)){
      const result=await prepareBitwardenTotp({...fixture,origin:site.origin,binding:siteBinding(site)});
      assert.deepEqual(result,{ready:false,reason:'session_invalid'});assert.deepEqual(fixture.calls(),[]);
    }
  });

test('Windows direct additional-site helper calls must explicitly bind the account and adapter',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=multiFixture(t),site=supportedSites[1];
    for(const bindingArguments of [['-AdapterId',site.adapterId],['-AccountKey','site-default']]){
      const output=execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.join(fixture.root,'scripts/Get-BitwardenTotp.ps1'),
        '-Root',fixture.root,'-Origin',site.origin,'-ProfileBinding',site.profileBinding,'-Mode','Prepare',...bindingArguments],
        {encoding:'utf8',windowsHide:true});
      assert.deepEqual(JSON.parse(output),{ready:false,reason:'profile_mismatch'});assert.deepEqual(fixture.calls(),[]);
    }
  });

test('Windows schema-2 sealed tuples prevent profile, account, adapter and item rebinding',
  {skip:process.platform!=='win32'},async t=>{
    const site=supportedSites[1];
    for(const change of [{itemId:supportedSites[2].itemId},{profileBinding:'d'.repeat(64)},
      {accountKey:'other'},{adapterId:'hhclub-nexus-login-v1'},{itemName:'hhanclub.net'},
      {origin:'https://github.com'}]){
      const entries=supportedSites.map(authorization);Object.assign(entries[1],change);
      const fixture=multiFixture(t,{authorizations:entries});
      assert.deepEqual(await prepareBitwardenTotp({...fixture,origin:site.origin,binding:siteBinding(site)}),
        {ready:false,reason:'session_invalid'});
      assert.deepEqual(fixture.calls(),[]);
    }
    const fixture=multiFixture(t);
    const changed=structuredClone(fixture.config);changed.bitwardenTotp.routes[site.origin].itemId=supportedSites[2].itemId;
    fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(changed));
    assert.deepEqual(await prepareBitwardenTotp({...fixture,config:changed,origin:site.origin,binding:siteBinding(site)}),
      {ready:false,reason:'session_invalid'});
    assert.deepEqual(fixture.calls(),[]);
  });

test('Windows schema-2 missing, duplicate or extra-field authorizations stop before CLI use',
  {skip:process.platform!=='win32'},async t=>{
    const authorized=authorization(supportedSites[0]);
    for(const entries of [[],[authorized,authorized],[{...authorized,permission:'all'}],authorized]){
      const fixture=multiFixture(t,{authorizations:entries});
      assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'session_invalid'});
      assert.deepEqual(fixture.calls(),[]);
    }
    const fixture=multiFixture(t,{authorizations:[authorization(supportedSites[0])]});
    assert.deepEqual(await prepareBitwardenTotp({...fixture,origin:supportedSites[1].origin,binding:siteBinding(supportedSites[1])}),
      {ready:false,reason:'session_invalid'});
    assert.deepEqual(fixture.calls(),[]);
  });

function runManager(fixture,action,shell='pwsh.exe'){
  return execFileSync(shell,['-NoProfile','-NonInteractive','-File',path.join(fixture.root,'scripts/Manage-BitwardenTotp.ps1'),
    '-Action',action],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30_000});
}

test('Windows global operator status reads metadata and disable stops every auxiliary route',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=multiFixture(t);
    fixture.config.nativePtTwoFactorRecovery=Object.fromEntries(supportedSites.map(site=>[site.origin,{enabled:true,provider:'bitwarden'}]));
    fixture.config.nativePtTwoFactorRecovery['https://other.example']={enabled:true,provider:'other'};
    fixture.config.siteTwoFactorRecovery=Object.fromEntries(supportedSites.slice(1).map(site=>[site.origin,{enabled:true,provider:'bitwarden',adapterId:site.adapterId}]));
    fixture.config.automationUserDataDir='SYNTHETIC_UNRELATED_PROFILE';
    fs.writeFileSync(path.join(fixture.root,'config/config.json'),JSON.stringify(fixture.config));
    const localPath=path.join(fixture.root,'config/config.local.json');
    fs.writeFileSync(localPath,JSON.stringify({dashboard:{theme:'preserve'},
      bitwardenTotp:{...structuredClone(fixture.config.bitwardenTotp),sessionFile:path.join(fixture.root,'data/bitwarden/older-session.json')},
      siteTwoFactorRecovery:{...structuredClone(fixture.config.siteTwoFactorRecovery),
        'https://other.example':{enabled:true,provider:'other'}}}));
    const sealed=fs.readFileSync(fixture.config.bitwardenTotp.sessionFile,'utf8');
    const status=JSON.parse(runManager(fixture,'Status'));
    assert.equal(status.enabled,true);assert.equal(status.sites.length,3);assert.deepEqual(fixture.calls(),[]);
    const output=runManager(fixture,'Disable');
    assert.ok(!output.includes(otp)&&!output.includes('A'.repeat(40))&&!output.includes(privateMarker));
    const after=JSON.parse(fs.readFileSync(path.join(fixture.root,'config/config.json'),'utf8'));
    assert.equal(after.bitwardenTotp.enabled,false);
    assert.ok(Object.values(after.bitwardenTotp.routes).every(route=>route.enabled===false));
    assert.ok(supportedSites.every(site=>after.nativePtTwoFactorRecovery[site.origin].enabled===false));
    assert.ok(supportedSites.slice(1).every(site=>after.siteTwoFactorRecovery[site.origin].enabled===false));
    assert.equal(after.nativePtTwoFactorRecovery['https://other.example'].enabled,true);
    assert.equal(after.automationUserDataDir,'SYNTHETIC_UNRELATED_PROFILE');
    assert.equal(fs.readFileSync(fixture.config.bitwardenTotp.sessionFile,'utf8'),sealed);
    assert.deepEqual(fixture.calls().map(call=>call.args[0]),['lock']);
    const local=JSON.parse(fs.readFileSync(localPath,'utf8'));
    assert.equal(local.bitwardenTotp.enabled,false);assert.equal(local.bitwardenTotp.sessionFile,fixture.config.bitwardenTotp.sessionFile);
    assert.ok(Object.values(local.bitwardenTotp.routes).every(route=>route.enabled===false));
    assert.ok(supportedSites.slice(1).every(site=>local.siteTwoFactorRecovery[site.origin].enabled===false));
    assert.ok(supportedSites.every(site=>local.nativePtTwoFactorRecovery[site.origin].enabled===false));
    assert.deepEqual(local.dashboard,{theme:'preserve'});assert.equal(local.siteTwoFactorRecovery['https://other.example'].enabled,true);
  });

for(const shell of ['powershell.exe','pwsh.exe'])test(`Windows global unlock retains only the sealed authorization list (${shell})`,
  {skip:process.platform!=='win32'},async t=>{
    const sealedEntries=supportedSites.slice(0,2).map(authorization);
    const fixture=multiFixture(t,{authorizations:sealedEntries});
    fixture.config.nativePtTwoFactorRecovery=Object.fromEntries(supportedSites.map(site=>[site.origin,{enabled:false,provider:'bitwarden'}]));
    fixture.config.siteTwoFactorRecovery=Object.fromEntries(supportedSites.slice(1).map(site=>[site.origin,{enabled:false,provider:'bitwarden',adapterId:site.adapterId}]));
    fs.writeFileSync(path.join(fixture.root,'config/config.json'),JSON.stringify(fixture.config));
    const localPath=path.join(fixture.root,'config/config.local.json');
    fs.writeFileSync(localPath,JSON.stringify({uiPreference:'preserve',
      bitwardenTotp:{...structuredClone(fixture.config.bitwardenTotp),sessionFile:path.join(fixture.root,'data/bitwarden/older-session.json')},
      siteTwoFactorRecovery:{[supportedSites[1].origin]:{provider:'bitwarden',enabled:false,note:'preserve'}}}));
    const output=runManager(fixture,'Unlock',shell);
    assert.ok(!output.includes(otp)&&!output.includes('B'.repeat(40))&&!output.includes(privateMarker));
    const cfg=JSON.parse(fs.readFileSync(path.join(fixture.root,'config/config.json'),'utf8'));
    assert.equal(cfg.bitwardenTotp.enabled,true);
    for(const site of supportedSites){
      const enrolled=sealedEntries.some(entry=>entry.origin===site.origin);
      assert.equal(cfg.bitwardenTotp.routes[site.origin].enabled,enrolled);
      assert.equal(cfg.nativePtTwoFactorRecovery[site.origin].enabled,enrolled);
      if(site.origin!==origin)assert.equal(cfg.siteTwoFactorRecovery[site.origin].enabled,enrolled);
    }
    const local=JSON.parse(fs.readFileSync(localPath,'utf8'));
    assert.equal(local.uiPreference,'preserve');assert.equal(local.bitwardenTotp.sessionFile,fixture.config.bitwardenTotp.sessionFile);
    assert.equal(local.siteTwoFactorRecovery[supportedSites[1].origin].enabled,true);
    assert.equal(local.siteTwoFactorRecovery[supportedSites[1].origin].note,'preserve');
    assert.equal(local.siteTwoFactorRecovery[supportedSites[2].origin].enabled,false);
    assert.equal(local.bitwardenTotp.routes[supportedSites[2].origin].enabled,false);
    const quote=value=>`'${value.replaceAll("'","''")}'`;
    const command=`$outer=Get-Content -Raw ${quote(fixture.config.bitwardenTotp.sessionFile)}|ConvertFrom-Json;`+
      `$secure=ConvertTo-SecureString $outer.protectedPayload;$text=[Net.NetworkCredential]::new('',$secure).Password;`+
      `$payload=$text|ConvertFrom-Json;`+
      `[pscustomobject]@{schema=$payload.schemaVersion;authorizations=@($payload.authorizations);sessionChanged=($payload.session -ceq ('B'*40))}|ConvertTo-Json -Depth 8 -Compress;$secure.Dispose()`;
    const updated=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true}));
    assert.equal(updated.schema,2);assert.deepEqual(updated.authorizations,sealedEntries);assert.equal(updated.sessionChanged,true);
    assert.ok(fixture.calls().every(call=>!['get','sync'].includes(call.args[0])));
  });

test('Windows global disable and unlock preserve the original PigGo schema-1 enrollment',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);
    fixture.config.nativePtTwoFactorRecovery={[origin]:{enabled:true,provider:'bitwarden'}};
    fs.writeFileSync(path.join(fixture.root,'config/config.json'),JSON.stringify(fixture.config));
    runManager(fixture,'Disable');runManager(fixture,'Unlock');
    const cfg=JSON.parse(fs.readFileSync(path.join(fixture.root,'config/config.json'),'utf8'));
    assert.equal(cfg.bitwardenTotp.enabled,true);assert.equal(cfg.bitwardenTotp.routes[origin].enabled,true);
    assert.equal(cfg.nativePtTwoFactorRecovery[origin].enabled,true);
    assert.equal(cfg.bitwardenTotp.routes[origin].adapterId,undefined);
    assert.equal(cfg.bitwardenTotp.routes[origin].itemId,itemId);
    assert.ok(fixture.calls().every(call=>!['get','sync'].includes(call.args[0])));
  });

test('Windows DPAPI fixture prepares metadata, syncs once daily and gets only exact UUID TOTP',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);
    for (let count=0;count<2;count++) assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:true,reason:'prepared'});
    assert.equal(fixture.calls().filter(call=>call.args[0]==='sync').length,1);
    assert.ok(fixture.calls().every(call=>call.args[0]!=='get'));
    let consumed;
    assert.deepEqual(await withBitwardenTotp({...fixture,consume:code=>{consumed=code;}}),{ready:true,reason:'totp_consumed'});
    assert.equal(consumed,otp);
    assert.deepEqual(fixture.calls().filter(call=>call.args[0]==='get').map(call=>call.args),[['get','totp',itemId,'--raw','--nointeraction']]);
    assert.ok(fixture.calls().every(call=>call.sessionPresent&&!call.nodeOptionsPresent));
    assert.ok(!fs.readFileSync(fixture.config.bitwardenTotp.sessionFile,'utf8').includes('A'.repeat(40)));
    assert.ok(!fs.readFileSync(path.join(fixture.root,'data','bitwarden','sync-state.json'),'utf8').includes(otp));
  });

for (const shell of ['powershell.exe','pwsh.exe']) {
  for (const createdAtUtc of ['2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.0000000+00:00']) {
    test(`Windows ${shell} accepts the original UTC session timestamp ${createdAtUtc.endsWith('Z')?'Z':'+00:00'}`,
      {skip:process.platform!=='win32'},async t=>{
        const fixture=protectedFixture(t,{createdAtUtc});
        fixture.config.powershellExecutable=shell;
        fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(fixture.config));
        assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:true,reason:'prepared'});
        let consumed;
        assert.deepEqual(await withBitwardenTotp({...fixture,consume:code=>{consumed=code;}}),{ready:true,reason:'totp_consumed'});
        assert.equal(consumed,otp);
      });
  }
  for (const [title,createdAtUtc] of [
    ['local non-UTC','2025-01-01T08:00:00.0000000+08:00'],
    ['missing UTC zone','2025-01-01T00:00:00.000'],
    ['future Z','2999-01-01T00:00:00.000Z'],
    ['future +00:00','2999-01-01T00:00:00.0000000+00:00'],
  ]) {
    test(`Windows ${shell} rejects ${title} session creation before any CLI call`,
      {skip:process.platform!=='win32'},async t=>{
        const fixture=protectedFixture(t,{createdAtUtc});
        fixture.config.powershellExecutable=shell;
        fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(fixture.config));
        assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'session_invalid'});
        assert.deepEqual(fixture.calls(),[]);
      });
  }
}

for (const [title,overrides] of [
  ['wrong item UUID',{itemId:'30000000-0000-4000-8000-000000000003'}],
  ['wrong profile',{profileBinding:'b'.repeat(64)}],['wrong site',{origin:'https://other.example'}],
  ['wrong vault',{serverUrl:'https://other-vault.example'}],['wrong Windows SID',{windowsSid:'S-1-5-21-0-0-0-0'}],
  ['future creation',{createdAtUtc:'2999-01-01T00:00:00.000Z'}],['invalid session',{session:'invalid'}],
]) {
  test(`Windows sealed ${title} is rejected before any CLI call`,{skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t,overrides);
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'session_invalid'});
    assert.deepEqual(fixture.calls(),[]);
  });
}

for (const [title,mode,reason] of [
  ['locked',{status:'locked'},'vault_locked'],['unauthenticated',{status:'unauthenticated'},'vault_unauthenticated'],
  ['wrong server',{server:'https://other-vault.example'},'server_mismatch'],
  ['wrong vault account',{userId:'30000000-0000-4000-8000-000000000003'},'session_invalid'],
  ['account changed after sync',{changeAccountAfterSync:true},'session_invalid'],
  ['sync failure',{syncFails:true},'vault_sync_failed'],
]) {
  test(`Windows ${title} cannot read a TOTP`,{skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);fixture.mode(mode);
    const result=await prepareBitwardenTotp(fixture);
    assert.deepEqual(result,{ready:false,reason});publicOnly(result);
    assert.ok(fixture.calls().every(call=>call.args[0]!=='get'));
  });
}

test('Windows missing or damaged DPAPI file never launches the CLI',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);
    fs.rmSync(fixture.config.bitwardenTotp.sessionFile);
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'session_missing'});
    fs.writeFileSync(fixture.config.bitwardenTotp.sessionFile,JSON.stringify({schemaVersion:1,protection:'CurrentUserDPAPI',protectedPayload:'0'.repeat(120)}));
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'session_unavailable'});
    assert.deepEqual(fixture.calls(),[]);
  });

test('Windows helper rereads private config rather than trusting the Node caller snapshot',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);
    const changed=structuredClone(fixture.config);
    changed.bitwardenTotp.routes[origin].profileBinding='b'.repeat(64);
    fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(changed));
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'profile_mismatch'});
    assert.deepEqual(fixture.calls(),[]);
  });

test('Windows provider lock prevents concurrent client/cache use',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t);
    const lockPath=path.join(fixture.root,'data','bitwarden','provider.lock');
    const lockScript=path.join(fixture.root,'hold-fixture-lock.ps1');
    fs.writeFileSync(lockScript,"param($Path);$handle=[IO.File]::Open($Path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);'locked';try{[Console]::ReadLine()|Out-Null}finally{$handle.Dispose()}");
    const {spawn}=await import('node:child_process');
    const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-File',lockScript,lockPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    t.after(()=>{child.stdin.end();child.kill();});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.stdout.once('data',()=>resolve());});
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'provider_busy'});
    const configBefore=fs.readFileSync(path.join(fixture.root,'config/config.json'),'utf8');
    runManager(fixture,'Disable');
    assert.equal(fs.readFileSync(path.join(fixture.root,'config/config.json'),'utf8'),configBefore);
    assert.equal(fs.existsSync(path.join(fixture.root,'config/config.local.json')),false);
    assert.deepEqual(fixture.calls(),[]);
    child.stdin.end();
    await new Promise(resolve=>child.once('close',resolve));
  });

test('Windows junctions cannot redirect secret/cache files outside the runtime',
  {skip:process.platform!=='win32'},async t=>{
    const fixture=protectedFixture(t), outside=fs.mkdtempSync(path.join(os.tmpdir(),'checkin-bw-outside-'));
    t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
    const junction=path.join(fixture.root,'data','bitwarden','redirect');
    fs.symlinkSync(outside,junction,'junction');
    fixture.config.bitwardenTotp.sessionFile=path.join(junction,'session.json');
    fs.writeFileSync(path.join(fixture.root,'config','config.json'),JSON.stringify(fixture.config));
    assert.deepEqual(await prepareBitwardenTotp(fixture),{ready:false,reason:'invalid_configuration'});
    assert.deepEqual(fixture.calls(),[]);
  });
