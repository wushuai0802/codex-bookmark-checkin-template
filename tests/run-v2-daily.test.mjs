import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDaily} from '../src/daily-runner.mjs';

test('daily V2 entry enforces a narrow execution window and uses migration candidates',()=>{
  const source=fs.readFileSync(new URL('../src/daily-runner.mjs',import.meta.url),'utf8');
  assert.match(source,/V2 daily execute window is closed/);assert.match(source,/migration-\[A-Za-z0-9/);assert.match(source,/runCanary/);assert.match(source,/current:'v2-worker'/);assert.match(source,/acquireExecutionLock/);
});

test('daily runner filters to the selected migration and keeps read-only mode',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-runner-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  const day='2026-09-09',profileDir=path.join(root,'profiles','acct7');fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:profileDir}]}));fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'new-api.execute.v1',ownership:{current:'legacy-checkin'}}));
  const report=await runDaily({root,legacyRoot:legacy,accountKey:'acct7',now:new Date('2026-09-09T01:00:00Z'),execute:false,runAccount:async()=>({stage:'already_done',phase:'already_done',mutationCount:0,completedAt:'2026-09-09T01:00:01Z'})});
  assert.equal(report.results[0].stage,'already_done');assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir,'migration-acct7.json'),'utf8')).state,'candidate');
});

test('daily runner refuses to start Canary when the execution plan is missing or sentinel-only',async()=>{
  for(const fingerprint of [null,'0'.repeat(64)]){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-plan-')),legacy=path.join(root,'legacy');
    fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});
    fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));
    if(fingerprint!==null)fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:fingerprint}));
    await assert.rejects(()=>runDaily({root,legacyRoot:legacy,now:new Date('2026-09-09T01:00:00Z'),runAccount:async()=>{throw Error('must not run');}}),/execution plan (?:is missing|planFingerprint must be a non-zero SHA-256 hash)/);
  }
});

test('daily runner rejects an invalid schedule instead of bypassing its window',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-schedule-')),legacy=path.join(root,'legacy');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'invalid'}));
  await assert.rejects(()=>runDaily({root,legacyRoot:legacy,execute:true,now:new Date('2026-09-09T12:00:00Z')}),/schedule is invalid/);
});

test('daily runner keeps a successful task when notification delivery fails',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-notify-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');
  fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:path.join(root,'profiles','acct7')}]}));
  const migrationFile=path.join(outputDir,'migration-acct7.json');fs.writeFileSync(migrationFile,JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'new-api.execute.v1',ownership:{current:'legacy-checkin'}}));
  const report=await runDaily({root,legacyRoot:legacy,execute:true,now:new Date('2026-09-09T00:05:00Z'),runAccount:async()=>({stage:'succeeded',phase:'succeeded',mutationCount:1,completedAt:'2026-09-09T00:06:00Z',output:path.join(outputDir,'receipt.json')}),notifyAccount:async()=>{throw Error('telegram unavailable');}});
  assert.equal(report.results.length,1);assert.equal(report.results[0].stage,'succeeded');assert.equal(report.results[0].delivery.state,'failed');assert.equal(report.hasFailures,true);assert.equal(JSON.parse(fs.readFileSync(migrationFile,'utf8')).state,'active');
});

test('daily runner reconciles a duplicate successful result without losing its completion time',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-duplicate-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');
  fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:path.join(root,'profiles','acct7')}]}));
  const migrationFile=path.join(outputDir,'migration-acct7.json');fs.writeFileSync(migrationFile,JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'new-api.execute.v1',ownership:{current:'legacy-checkin'}}));
  const report=await runDaily({root,legacyRoot:legacy,execute:true,now:new Date('2026-09-09T00:05:00Z'),runAccount:async()=>({stage:'succeeded',phase:'succeeded',mutationCount:1,duplicate:true,completedAt:'2026-09-09T00:06:00Z'})});
  assert.equal(report.results[0].duplicate,true);const migration=JSON.parse(fs.readFileSync(migrationFile,'utf8'));assert.equal(migration.state,'active');assert.equal(migration.lastSuccessAt,'2026-09-09T00:06:00.000Z');assert.equal(migration.ownership.switchedAt,'2026-09-09T00:06:00.000Z');
});

test('one corrupt migration file is isolated while other accounts continue',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-corrupt-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');
  fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'migration-bad.json'),'not-json','utf8');fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:path.join(root,'profiles','acct7')}]}));
  fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'new-api.execute.v1'}));
  const report=await runDaily({root,legacyRoot:legacy,execute:false,now:new Date('2026-09-09T01:00:00Z'),runAccount:async()=>({stage:'already_done',phase:'already_done',mutationCount:0})});
  assert.equal(report.results.length,2);assert.equal(report.results.find(row=>row.accountKey==='acct7').stage,'already_done');assert.equal(report.results.find(row=>row.accountKey==='bad').reason,'migration_invalid_json');assert.equal(report.hasFailures,true);
});

test('migration filename and account identity must match before execution',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-key-mismatch-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');
  fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct8',origin:'https://fixture.example',state:'ready',identity:'8',expectedIdentity:'8'}]}));
  fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct8',origin:'https://fixture.example',adapterId:'new-api.execute.v1'}));let calls=0;
  const report=await runDaily({root,legacyRoot:legacy,execute:false,now:new Date('2026-09-09T01:00:00Z'),runAccount:async()=>{calls++;return {stage:'already_done',phase:'already_done',mutationCount:0};}});
  assert.equal(calls,0);assert.equal(report.results[0].reason,'migration_key_mismatch');assert.equal(report.hasFailures,true);
});

test('daily runner blocks migrations whose adapter is not implemented',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-adapter-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7'}]}));
  fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'native-pt.execute.v1'}));let calls=0;
  const report=await runDaily({root,legacyRoot:legacy,execute:false,now:new Date('2026-09-09T01:00:00Z'),runAccount:async()=>{calls++;return {stage:'already_done',phase:'already_done',mutationCount:0};}});
  assert.equal(calls,0);assert.equal(report.results[0].reason,'adapter_not_implemented');
});

test('daily execution lock covers the entire multi-account orchestration',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-lock-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7'}]}));fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',adapterId:'new-api.execute.v1'}));
  let release,startedResolve;const started=new Promise(resolve=>{startedResolve=resolve}),hold=new Promise(resolve=>{release=resolve});
  const options={root,legacyRoot:legacy,execute:true,now:new Date('2026-09-09T00:05:00Z'),runAccount:async()=>{startedResolve();await hold;return {stage:'already_done',phase:'already_done',mutationCount:0};}};
  const first=runDaily(options);await started;await assert.rejects(()=>runDaily({...options,runAccount:async()=>({stage:'already_done',phase:'already_done',mutationCount:0})}),/already active/);release();await first;
});
