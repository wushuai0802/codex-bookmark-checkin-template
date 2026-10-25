import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {deploymentIntegrity} from '../src/deployment-integrity.mjs';
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
test('managed package hashes and installed dependency versions detect drift, while a live release reports busy',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deployment-integrity-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(root+'/node_modules/fixture-sdk',{recursive:true});fs.mkdirSync(root+'/tmp');
  fs.writeFileSync(root+'/package.json',JSON.stringify({version:'1.1.46',dependencies:{'fixture-sdk':'1.0.0'}}));
  fs.writeFileSync(root+'/package-lock.json',JSON.stringify({packages:{'node_modules/fixture-sdk':{version:'1.0.0'}}}));
  fs.writeFileSync(root+'/node_modules/fixture-sdk/package.json',JSON.stringify({version:'1.0.0'}));
  fs.writeFileSync(root+'/release.json',JSON.stringify({version:'1.1.46',packageHash:hash(root+'/package.json'),lockHash:hash(root+'/package-lock.json')}));
  assert.equal(deploymentIntegrity(root).consistent,true);
  fs.writeFileSync(root+'/node_modules/fixture-sdk/package.json',JSON.stringify({version:'2.0.0'}));
  assert.deepEqual(deploymentIntegrity(root).issues,['execution_dependency_drift']);
  fs.appendFileSync(root+'/package.json','\n');assert.ok(deploymentIntegrity(root).issues.includes('execution_package_drift'));
  fs.writeFileSync(root+'/tmp/release-in-progress.json',JSON.stringify({kind:'managed-release',pid:process.pid,startedAt:new Date().toISOString()}));
  const busy=deploymentIntegrity(root);assert.equal(busy.busy,true);assert.equal(busy.consistent,null);
  fs.unlinkSync(root+'/tmp/release-in-progress.json');
  fs.mkdirSync(root+'/data');fs.writeFileSync(root+'/data/pt-worker-lifecycle.json',JSON.stringify({state:'cleanup_pending'}));
  assert.ok(deploymentIntegrity(root).issues.includes('pt_cleanup_pending'));
});

test('unmanaged legacy installations are compatible and integrity issues never include metadata contents',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deployment-legacy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(root+'/release.json',JSON.stringify({version:'old'}));assert.equal(deploymentIntegrity(root).consistent,true);
  fs.writeFileSync(root+'/release.json',JSON.stringify({version:'new',packageHash:'a'.repeat(64)}));
  fs.writeFileSync(root+'/package.json','PRIVATE_FIXTURE_DETAIL');
  const result=deploymentIntegrity(root);assert.equal(result.consistent,false);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_FIXTURE_DETAIL/);
});
