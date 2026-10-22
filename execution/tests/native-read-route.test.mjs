import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {runNativePtGate} from '../src/native-pt-gate.mjs';
import {ptReadPolicy} from '../src/pt-read-policy.mjs';
import {ptObservationBinding} from '../src/pt-observation-receipt.mjs';

test('all native PT readers bind the profile used by the registered execution route',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-read-route-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const shared=path.join(root,'data','shared'),piggo=path.join(root,'data','piggo'),main=path.join(root,'main','Default');
  for(const profile of [shared,piggo,path.dirname(main)]){
    fs.mkdirSync(profile,{recursive:true});fs.writeFileSync(path.join(profile,'Local State'),'{}');
  }
  fs.mkdirSync(path.join(root,'config'));fs.mkdirSync(main,{recursive:true});
  const config={bookmarksPath:path.join(main,'AccountBookmarks'),sourceUserDataDir:path.dirname(main),automationUserDataDir:shared,
    nativeWafPreflightUrls:[{url:'https://piggo.me/attendance.php',passiveOnly:true,automationUserDataDir:piggo},
      {url:'https://www.hdkyl.in/attendance.php',passiveOnly:true},
      {url:'https://ourbits.club/attendance.php'}],
    nativeChallengePreflight:[{url:'https://audiences.me/attendance.php',action:'checkin'}],
    mainChromeFallbackUrls:['https://audiences.me/attendance.php','https://piggo.me/attendance.php',
      'https://www.hdkyl.in/attendance.php','https://ourbits.club/attendance.php']};
  fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify(config));
  for(const [origin,profile,mainProfile] of [['https://audiences.me',shared,false],['https://piggo.me',piggo,false],
    ['https://www.hdkyl.in',shared,false],['https://ourbits.club',main,true]]){
    const target={origin,accountKey:'site-default',folderNames:['PT白名单'],allowedOrigins:[origin]};
    const gate=await runNativePtGate({root,origin,url:origin+'/index.php',profile,mainProfile,phase:'bind',
      readPlan:async()=>({targets:[target]})});
    const binding=ptObservationBinding(root,target,config),policy=ptReadPolicy(origin,config);
    assert.equal(gate.allow,true,origin);
    assert.equal(binding.profileBinding,gate.profileBinding,origin);
    assert.equal(binding.profileBinding,crypto.createHash('sha256').update(process.platform==='win32'?profile.toLowerCase():profile).digest('hex'),origin);
    assert.equal(policy.nativeMainChrome,mainProfile,origin);
    assert.equal(policy.nativeIsolatedChrome,!mainProfile,origin);
  }
  assert.equal(fs.existsSync(path.join(root,'data/native-pt-attempts.json')),false);
  const conflicting={...config,nativeWafPreflightUrls:[...config.nativeWafPreflightUrls,
    {url:'https://piggo.me/index.php',passiveOnly:true,automationUserDataDir:shared}]};
  assert.throws(()=>ptObservationBinding(root,{origin:'https://piggo.me',accountKey:'site-default'},conflicting),/ambiguous/);
});
