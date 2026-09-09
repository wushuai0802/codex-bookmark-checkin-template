import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runDaily} from '../src/daily-runner.mjs';

test('daily V2 entry enforces a narrow execution window and uses migration candidates',()=>{
  const source=fs.readFileSync(new URL('../src/daily-runner.mjs',import.meta.url),'utf8');
  assert.match(source,/V2 daily execute window is closed/);assert.match(source,/migration-\[A-Za-z0-9/);assert.match(source,/runCanary/);assert.match(source,/current:'v2-worker'/);
});

test('daily runner filters to the selected migration and keeps read-only mode',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'daily-runner-')),legacy=path.join(root,'legacy'),outputDir=path.join(root,'outputs');fs.mkdirSync(path.join(legacy,'config'),{recursive:true});fs.mkdirSync(path.join(legacy,'data'),{recursive:true});fs.mkdirSync(outputDir,{recursive:true});
  fs.writeFileSync(path.join(legacy,'config','config.json'),JSON.stringify({schedule:'08:05'}));fs.writeFileSync(path.join(legacy,'data','last-valid-bookmark-plan.json'),JSON.stringify({planFingerprint:'a'.repeat(64)}));
  const day='2026-09-09',profileDir=path.join(root,'profiles','acct7');fs.writeFileSync(path.join(outputDir,'v2-profile-registry.json'),JSON.stringify({profiles:[{accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:profileDir}]}));fs.writeFileSync(path.join(outputDir,'migration-acct7.json'),JSON.stringify({state:'candidate',accountKey:'acct7',origin:'https://fixture.example',ownership:{current:'legacy-checkin'}}));
  const report=await runDaily({root,legacyRoot:legacy,accountKey:'acct7',now:new Date('2026-09-09T01:00:00Z'),execute:false,runAccount:async()=>({stage:'already_done',phase:'already_done',mutationCount:0,completedAt:'2026-09-09T01:00:01Z'})});
  assert.equal(report.results[0].stage,'already_done');assert.equal(JSON.parse(fs.readFileSync(path.join(outputDir,'migration-acct7.json'),'utf8')).state,'candidate');
});
