import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {validateSiteTwoFactorScope} from '../src/two-factor-scope.mjs';
import {acquireRunLock,releaseRunLock} from '../src/run-lock.mjs';

export function scopeFixture(t,{daily=true,origin='https://hhanclub.net',adapterId='hhclub-nexus-login-v1'}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'site-totp-')),profile=path.join(root,'data/profile'),controller=path.join(root,'controller');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['config','data/profile','tmp','controller/config','controller/data','controller/src'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  fs.writeFileSync(path.join(profile,'Local State'),'SYNTHETIC_PROFILE');
  const nonce=crypto.randomUUID(),config={automationUserDataDir:profile,bookmarksPath:path.join(root,'bookmarks.json'),
    siteTwoFactorRecovery:{[origin]:{enabled:true,reviewed:true,provider:'bitwarden',adapterId,expectedAccountId:'123',usernameHash:'a'.repeat(64)}}};
  const configFile=path.join(root,'config/config.json'),catalogFile=path.join(root,'catalog.json');
  const integration={executionEngine:'v1',v2ProjectRoot:controller,harvestPtGate:{catalogFile}};
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify(integration));
  fs.writeFileSync(path.join(controller,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root,ptFallbackOnlyEnabled:true}));
  fs.writeFileSync(path.join(controller,'data/v2-run.lock'),JSON.stringify({pid:process.pid,nonce}));
  fs.writeFileSync(path.join(controller,'src/legacy-engine.mjs'),`export {validateEngineLease} from ${JSON.stringify(new URL('../../observation/src/legacy-engine.mjs',import.meta.url).href)};`);
  fs.writeFileSync(catalogFile,JSON.stringify({schemaVersion:1,scope:{folderId:'10',parentId:'1'},sites:[{origin,entryUrl:origin+'/attendance.php'}]}));
  const bookmarks={roots:{bar:{id:'1',children:[{id:'10',children:[{id:'11',type:'url',url:origin+'/attendance.php'}]}]}}};
  fs.writeFileSync(config.bookmarksPath,JSON.stringify(bookmarks));
  const saved=new Map(['CHECKIN_V2_ENGINE_ROOT','CHECKIN_V2_ENGINE_LEASE'].map(key=>[key,process.env[key]]));
  process.env.CHECKIN_V2_ENGINE_ROOT=controller;process.env.CHECKIN_V2_ENGINE_LEASE=nonce;
  t.after(()=>{for(const [key,v] of saved)if(v===undefined)delete process.env[key];else process.env[key]=v;});
  let at=Date.parse('2026-10-14T01:00:00Z');
  const inspectOwner=async pid=>({alive:pid===process.pid,startedAt:null});
  const readPlan=async()=>({exactScopeConfigured:true,targets:daily?[{origin,candidates:[origin+'/attendance.php']}]:[]});
  const acquire=file=>acquireRunLock(file,{inspectProcess:inspectOwner});
  const args={root,origin,config,profile,adapterId,clock:()=>at,inspectOwner,readPlan,acquire,ancestors:async()=>new Set([process.pid])};
  const saveConfig=()=>fs.writeFileSync(configFile,JSON.stringify(config));saveConfig();
  return {args,root,profile,config,configFile,controller,catalogFile,bookmarks,saveConfig,inspectOwner,acquire,
    setTime:value=>{at=new Date(value).getTime();},get time(){return at;}};
}

test('site 2FA uses and releases the existing execution owner lock',async t=>{
  const f=scopeFixture(t),scope=await validateSiteTwoFactorScope(f.args);
  assert.ok(scope);assert.equal(scope.binding.adapterId,f.args.adapterId);assert.equal(scope.binding.accountKey,'site-default');
  assert.match(scope.binding.profileBinding,/^[a-f0-9]{64}$/);assert.ok(await scope.assertCurrent());
  assert.ok(fs.existsSync(path.join(f.root,'tmp/run.lock')));await scope.release();
  assert.equal(await scope.assertCurrent(),false);assert.equal(fs.existsSync(path.join(f.root,'tmp/run.lock')),false);
});

test('an authenticated child reuses only its active ancestor execution owner',async t=>{
  const f=scopeFixture(t),lease=await f.acquire(path.join(f.root,'tmp/run.lock'));
  const scope=await validateSiteTwoFactorScope(f.args);assert.ok(scope);await scope.release();
  assert.ok(fs.existsSync(lease.lockPath));await releaseRunLock(lease);
});

test('another task lock, stale owner, wrong profile, pause and lost controller lease all block',async t=>{
  for(const change of ['other_owner','stale','profile','pause','lease','config']){
    await t.test(change,async t=>{
      const f=scopeFixture(t);
      if(change==='other_owner'){
        const lease=await f.acquire(path.join(f.root,'tmp/run.lock'));f.args.ancestors=async()=>new Set();
        assert.ok(lease);
      }
      if(change==='stale'){
        fs.writeFileSync(path.join(f.root,'tmp/run.lock'),JSON.stringify({pid:123456,nonce:'stale'}));
      }
      if(change==='profile')f.args.profile=path.join(f.root,'data/other');
      if(change==='pause'){f.config.disabledCheckinOrigins=[f.args.origin];f.saveConfig();}
      if(change==='lease')delete process.env.CHECKIN_V2_ENGINE_LEASE;
      if(change==='config')fs.writeFileSync(f.configFile,JSON.stringify({...f.config,bitwardenTotp:{enabled:true}}));
      assert.equal(await validateSiteTwoFactorScope(f.args),null);
    });
  }
});

test('runtime-only execution flags do not change the exact authorization or profile',async t=>{
  const f=scopeFixture(t),scope=await validateSiteTwoFactorScope({...f.args,
    config:{...f.config,retryCount:0,failureScreenshots:false,capturePtEvidence:true,ptPassiveReadOnly:false,beforePtSubmit:async()=>{}}});
  assert.ok(scope);assert.equal(await scope.assertCurrent(),true);await scope.release();
});

test('an authentication state or auxiliary directory junction is rejected before reading any secret',async t=>{
  for(const part of ['directory','state'])await t.test(part,async t=>{
    const f=scopeFixture(t),auxiliary=path.join(f.root,'data/bitwarden'),outside=path.join(f.root,'outside');
    fs.mkdirSync(outside);
    try{
      if(part==='directory')fs.symlinkSync(outside,auxiliary,process.platform==='win32'?'junction':'dir');
      else{
        fs.mkdirSync(auxiliary);fs.writeFileSync(path.join(outside,'secret.json'),'DO_NOT_READ');
        fs.symlinkSync(path.join(outside,'secret.json'),path.join(auxiliary,'hhclub-authentication.json'),'file');
      }
    }catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Creating a synthetic link is unavailable');return;}throw error;}
    assert.equal(await validateSiteTwoFactorScope(f.args),null);
  });
});

test('PT monitor scope comes from the current exact bookmark folder, not a cached site list',async t=>{
  const f=scopeFixture(t,{daily:false}),scope=await validateSiteTwoFactorScope(f.args);
  assert.ok(scope);assert.equal(await scope.assertCurrent(),true);
  f.bookmarks.roots.bar.children[0].children=[];fs.writeFileSync(f.config.bookmarksPath,JSON.stringify(f.bookmarks));
  assert.equal(await scope.assertCurrent(),false);await scope.release();
  assert.equal(await validateSiteTwoFactorScope(f.args),null);
});

test('ambiguous exact scope and a different account never obtain a scope lease',async t=>{
  for(const change of ['duplicate','different_account','nonexact','monitor_duplicate']){
    await t.test(change,async t=>{
      const f=scopeFixture(t,{daily:change!=='monitor_duplicate'});
      if(change==='duplicate')f.args.readPlan=async()=>({exactScopeConfigured:true,targets:[{origin:f.args.origin},{origin:f.args.origin}]});
      if(change==='different_account')f.args.readPlan=async()=>({exactScopeConfigured:true,targets:[{origin:f.args.origin,accountKey:'another',candidates:[f.args.origin+'/attendance.php']}]});
      if(change==='nonexact')f.args.readPlan=async()=>({exactScopeConfigured:false,targets:[{origin:f.args.origin,candidates:[f.args.origin+'/attendance.php']}]});
      if(change==='monitor_duplicate'){f.bookmarks.roots.bar.children.push(f.bookmarks.roots.bar.children[0]);fs.writeFileSync(f.config.bookmarksPath,JSON.stringify(f.bookmarks));}
      assert.equal(await validateSiteTwoFactorScope(f.args),null);
    });
  }
});

test('configuration, scope owner and business day are rechecked before dispatch',async t=>{
  for(const change of ['config','owner','day'])await t.test(change,async t=>{
    const f=scopeFixture(t),scope=await validateSiteTwoFactorScope(f.args);assert.ok(scope);
    if(change==='config')fs.writeFileSync(f.configFile,JSON.stringify({...f.config,anything:'changed'}));
    if(change==='owner'){const owner=JSON.parse(fs.readFileSync(path.join(f.root,'tmp/run.lock')));owner.nonce='changed';fs.writeFileSync(path.join(f.root,'tmp/run.lock'),JSON.stringify(owner));}
    if(change==='day')f.setTime('2026-10-15T00:00:00Z');
    assert.equal(await scope.assertCurrent(),false);await scope.release();
  });
});
