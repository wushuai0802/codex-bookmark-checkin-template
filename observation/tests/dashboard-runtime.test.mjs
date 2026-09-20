import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {get as httpGet} from 'node:http';
import {runtimeOwners,readDashboardRuntime} from '../src/dashboard-runtime.mjs';
import {publicCanaryResults} from '../src/canary-report-view.mjs';
import {createDashboardServer} from '../src/dashboard-server.mjs';
import {accountRef} from '../src/contracts.mjs';

test('runtime projection excludes private registry fields and keeps all current accounts',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-project-'));
  try {
    fs.writeFileSync(path.join(root,'migration-fixture.json'),JSON.stringify({state:'active',accountKey:'fixture',origin:'https://fixture.example',profileDir:'private-profile',password:'TEST',ownership:{current:'v2-worker',switchedAt:'2026-09-16T00:00:00Z'}}));
    const owners=runtimeOwners(root);assert.equal(owners.length,1);assert.equal(owners[0].accountRef,accountRef('fixture'));assert.doesNotMatch(JSON.stringify(owners),/private|password|profile/);
    fs.writeFileSync(path.join(root,'dashboard-runtime.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),owners,results:Array.from({length:60},(_,i)=>({taskId:`task_${i.toString(16).padStart(24,'0')}`,mode:'canary_execute',stage:'succeeded',origin:'https://fixture.example',password:'TEST',profileDir:'private-profile',completedAt:'2026-09-18T00:00:00Z'}))}));
    assert.equal(publicCanaryResults(root).length,60);assert.doesNotMatch(JSON.stringify(publicCanaryResults(root)),/private|password|profile/);
    fs.writeFileSync(path.join(root,'dashboard-runtime.json'),JSON.stringify({schemaVersion:1,executionEngine:'v1',generatedAt:new Date().toISOString(),owners,results:[{taskId:'task_aaaaaaaaaaaaaaaaaaaaaaaa',mode:'canary_execute'}]}));
    assert.deepEqual(readDashboardRuntime(root).owners,[]);
    assert.deepEqual(readDashboardRuntime(root).results,[]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('runtime ownership, receipts and merged metrics stay consistent across APIs',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-api-'));
  const id='task_cccccccccccccccccccccccc',origin='https://fixture.example',date='2026-09-18';
  const task={taskId:id,businessDate:date,origin,accountRef:accountRef('fixture'),executionOwner:'legacy-checkin',observedStatus:'not_available'};
  fs.writeFileSync(path.join(root,'shadow-beta-snapshot.json'),JSON.stringify({businessDate:date,mode:'shadow_read_only',counts:{executionUnits:1},tasks:[task]}));
  const runtime={schemaVersion:1,generatedAt:new Date().toISOString(),owners:[{origin,accountRef:task.accountRef,owner:'v2-worker'}],results:[]};
  const save=()=>fs.writeFileSync(path.join(root,'dashboard-runtime.json'),JSON.stringify(runtime));save();
  const {server}=createDashboardServer({dataDir:root,port:0});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const get=(route='/api/overview')=>new Promise((resolve,reject)=>{
    httpGet(`http://127.0.0.1:${server.address().port}${route}`,response=>{
      let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});
      response.on('end',()=>{try{resolve(JSON.parse(body));}catch(error){reject(error);}});
      response.on('error',reject);
    }).on('error',reject);
  });
  try {
    let view=await get();assert.equal(view.tasks[0].executionOwner,'v2-worker');assert.equal(view.tasks[0].observedStatus,'not_started');
    runtime.results=[{taskId:id,origin,businessDate:date,mode:'canary_execute',stage:'already_done',evidence:{authoritative:true,source:'oauth_reward_log'}}];save();
    view=await get();assert.equal(view.status.already_signed,1);assert.equal(view.evidenceQuality.verifiedSuccess,1);assert.equal(view.snapshot.counts.status.already_signed,1);assert.equal(view.execution.owners['v2-worker'],1);
    assert.equal((await get('/api/summary')).evidenceQuality.verifiedSuccess,1);assert.equal((await get('/api/config')).executionOwner,'account_scoped');
    runtime.results[0].businessDate='2026-09-17';save();assert.equal((await get()).status.not_started,1);
    runtime.results[0].businessDate=date;runtime.results[0].origin='https://other.example';save();assert.equal((await get()).status.not_started,1);
    runtime.results[0].origin=origin;runtime.results[0].evidence.authoritative=false;save();view=await get();assert.equal(view.status.needs_attention,1);assert.equal(view.evidenceQuality.verifiedSuccess,0);
  } finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});
