import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkHarvestPtBeforeWrite,harvestPtDecision} from '../src/harvest-pt-gate.mjs';

const now=new Date('2026-09-29T02:00:00Z');
const target={origin:'https://pt.example',folderNames:['公益站'],accountKey:'site-default'};
const report=()=>({schemaVersion:1,source:'harvest',businessDate:'2026-09-29',generatedAt:'2026-09-29T01:59:50Z',
  taskCompletion:{resultId:42,status:'completed',startedAt:'2026-09-29T01:30:00Z',completedAt:'2026-09-29T01:50:00Z'},
  sites:[{origin:target.origin,status:'unknown',observedAt:null}]});

test('PT gate waits for an exact fresh same-day Harvest completion',()=>{
  assert.equal(harvestPtDecision({report:report(),target,now}),null);
  assert.equal(harvestPtDecision({report:{...report(),taskCompletion:null},target,now}).status,'deferred');
  assert.equal(harvestPtDecision({report:{...report(),businessDate:'2026-09-28'},target,now}).status,'deferred');
  assert.equal(harvestPtDecision({report:{...report(),generatedAt:'2026-09-29T01:55:00Z'},target,now}).status,'deferred');
  assert.equal(harvestPtDecision({report:{...report(),taskCompletion:{...report().taskCompletion,resultId:null}},target,now}).status,'deferred');
});

test('Harvest confirmed same-day success is observed once; its user ID is not a PT account ID',()=>{
  const signed={...report(),sites:[{origin:target.origin,userId:'different-harvest-id',status:'signed',
    observedAt:'2026-09-29T01:58:00Z',evidence:{source:'harvest',authoritative:true}}]};
  const decided=harvestPtDecision({report:signed,target,now});
  assert.equal(decided.status,'already_signed');
  assert.equal(decided.submissionAttempted,false);
  assert.equal(decided.evidence.authoritative,false);
  signed.sites[0].evidence.authoritative=false;
  assert.equal(harvestPtDecision({report:signed,target,now}).status,'deferred');
  signed.sites[0].evidence.authoritative=true;
  signed.sites.push({...signed.sites[0]});
  assert.equal(harvestPtDecision({report:signed,target,now}).status,'deferred');
});

test('private opt-in binds one exact PT origin and account without a network call in fixtures',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-harvest-gate-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'data'));
  const catalogFile=path.join(root,'catalog.json');
  fs.writeFileSync(catalogFile,JSON.stringify({sites:[{origin:target.origin}]}));
  const planFile=path.join(root,'data/last-valid-bookmark-plan.json');
  fs.writeFileSync(planFile,JSON.stringify({targets:[target]}));
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',
    v2ProjectRoot:root,harvestPtGate:{enabled:true,catalogFile,sshTarget:'fixture',
      database:'/volume3/docker/harvest/db/data.sqlite3',expectedOrigins:[target.origin]}}));
  let probes=0;
  const probe=()=>{probes++;return report();};
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}),null);
  assert.equal(probes,1);
  assert.equal(checkHarvestPtBeforeWrite({origin:'https://other.example',folderNames:['公益站']},{root,now,probe}),null);
  assert.equal(probes,1);
  fs.writeFileSync(planFile,JSON.stringify({targets:[target,{...target,accountKey:'second'}]}));
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}).status,'deferred');
  assert.equal(probes,1);
  fs.unlinkSync(catalogFile);
  assert.equal(checkHarvestPtBeforeWrite(target,{root,now,probe}).status,'deferred');
  assert.equal(probes,1);
});

test('live assignment distinguishes disabled and absent sites from Harvest-managed sites',()=>{
  const current={...report(),checkinInventoryComplete:true,taskCompletion:null,
    sites:[{...report().sites[0],checkinEnabled:false}]};
  assert.equal(harvestPtDecision({report:current,target,now}),null);
  assert.equal(harvestPtDecision({report:{...current,sites:[]},target,now}),null);
  current.sites[0].checkinEnabled=true;
  assert.equal(harvestPtDecision({report:current,target,now}).retryCause,'harvest_waiting');
  current.sites[0].checkinEnabled='false';
  assert.equal(harvestPtDecision({report:current,target,now}).status,'deferred');
  assert.equal(harvestPtDecision({report:{...current,sites:[],checkinInventoryComplete:false},target,now}).status,'deferred');
});

test('OpenCD known alias consumes dated success without waiting or inferring Harvest user identity',()=>{
  const current={...report(),checkinInventoryComplete:true,taskCompletion:null,sites:[{origin:'https://www.open.cd',
    checkinEnabled:true,userId:'harvest-owner',status:'signed',observedAt:'2026-09-29T01:59:00Z',evidence:{authoritative:true}}]};
  const result=harvestPtDecision({report:current,target:{...target,origin:'https://open.cd'},now});
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
  current.sites.push({...current.sites[0],origin:'https://open.cd'});
  assert.equal(harvestPtDecision({report:current,target:{...target,origin:'https://open.cd'},now}).status,'deferred');
});
