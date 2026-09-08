import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadEffectiveConfig,resolveExecutionProfile} from '../src/effective-config.mjs';
import {desiredTargets,reconcilePlan} from '../src/desired-plan.mjs';
import {normalizeEvidence} from '../src/evidence-contract.mjs';
import {buildSnapshot} from '../src/bridge.mjs';
import {snapshotSafetyReasons} from '../src/freshness.mjs';
const fixture=fileURLToPath(new URL('./fixtures/legacy/',import.meta.url));
const now='2026-09-02T02:00:00Z';

test('runtime config wins completely; overlays cannot silently replace nested maps',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m1-config-'));
 try{fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/config.json'),JSON.stringify({automationUserDataDir:'data/default',isolatedOAuthSiteProfiles:{'https://a.example':'data/a','https://b.example':'data/b'}}));
 fs.writeFileSync(path.join(root,'config/config.local.json'),JSON.stringify({isolatedOAuthSiteProfiles:{'https://a.example':'data/wrong'}}));
 const config=loadEffectiveConfig(root);assert.equal(resolveExecutionProfile(config,root,'https://b.example'),path.join(root,'data/b'));
 assert.equal(resolveExecutionProfile(config,root,'https://a.example'),path.join(root,'data/a'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('profile resolver honors direct account and rejects shared conflicts or outside paths',()=>{
 const config={automationUserDataDir:'data/default',oauthAccountIdentities:{'https://a.example':{accountKey:'primary',automationUserDataDir:'data/primary'}}};
 assert.equal(resolveExecutionProfile(config,'/fixture','https://a.example','primary'),path.resolve('/fixture/data/primary'));
 assert.throws(()=>resolveExecutionProfile({...config,isolatedOAuthSiteProfiles:{'https://a.example':'data/a'},oauthSiteSessionBindings:{'https://a.example':'group'}},'/fixture','https://a.example'),/conflicting/);
 assert.throws(()=>resolveExecutionProfile({automationUserDataDir:'../ordinary-chrome'},'/fixture','https://a.example'),/dedicated/);
});
test('desired primary and supplemental tasks come from plan/config, never result ordering',()=>{
 const targets=desiredTargets({targets:[{origin:'https://a.example'}]},{oauthAccountIdentities:{'https://a.example':{accountKey:'one',accountId:'1'}},supplementalOAuthAccounts:[{origin:'https://a.example',accountKey:'two',accountId:'2'}]});
 const results=[{origin:'https://a.example',accountKey:'two',accountId:'2',status:'signed'}];
 const r=reconcilePlan(targets,results);assert.equal(r.entries.length,2);assert.equal(r.entries[0].status,'not_started');assert.equal(r.entries[1].status,'signed');
 assert.equal(r.diagnostics.missingCount,1);
});
test('explicit exclusion removes a stale physical bookmark and is reversible',()=>{
 const plan={targets:[{origin:'https://free.lyclaude.site'},{origin:'https://keep.example'}]};
 assert.deepEqual(desiredTargets(plan,{excludedOrigins:['https://free.lyclaude.site']}).map(t=>t.origin),['https://keep.example']);
 assert.deepEqual(desiredTargets(plan,{}).map(t=>t.origin),['https://free.lyclaude.site','https://keep.example']);
});
test('removed account result cannot re-enter plan; duplicate and wrong ID fail closed',()=>{
 const targets=desiredTargets({targets:[{origin:'https://a.example',accountKey:'one',accountId:'1'}]});
 assert.equal(reconcilePlan(targets,[{origin:'https://a.example',accountKey:'old',status:'signed'}]).diagnostics.unexpectedCount,1);
 assert.equal(reconcilePlan(targets,[{origin:'https://a.example',accountKey:'one',accountId:'2'}]).entries[0].status,'needs_attention');
 assert.equal(reconcilePlan(targets,[{origin:'https://a.example',accountKey:'one'},{origin:'https://a.example',accountKey:'one'}]).diagnostics.conflictCount,1);
});
test('same desired plan hash survives an omitted result, which blocks the dry gate',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m1-missing-'));fs.cpSync(fixture,root,{recursive:true});
 try{const before=buildSnapshot({legacyRoot:root,generatedAt:now});
 const file=path.join(root,'logs/fixture-run-20260902/result.json');const data=JSON.parse(fs.readFileSync(file));data.results.shift();fs.writeFileSync(file,JSON.stringify(data));
 const after=buildSnapshot({legacyRoot:root,generatedAt:now});assert.equal(after.planHash,before.planHash);assert.equal(after.tasks.length,3);
 assert.equal(after.tasks.filter(t=>t.observedStatus==='not_started').length,1);assert.equal(after.source.executionComplete,false);
 assert.ok(snapshotSafetyReasons(after,now).includes('planned_results_missing'));
 data.results=[];fs.writeFileSync(file,JSON.stringify(data));assert.equal(buildSnapshot({legacyRoot:root,generatedAt:now}).reconciliation.missingCount,3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('an incomplete latest report is not concealed by an older complete result',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m1-partial-'));fs.cpSync(fixture,root,{recursive:true});
 try{fs.writeFileSync(path.join(root,'logs/latest.json'),JSON.stringify({runId:'20260902-new',finishedAt:now,results:[],runState:'running'}));
 const snapshot=buildSnapshot({legacyRoot:root,generatedAt:now});assert.equal(snapshot.reconciliation.missingCount,3);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('a completely absent run report still shows every desired task as not started',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'m1-no-run-'));fs.cpSync(fixture,root,{recursive:true});
 try{fs.rmSync(path.join(root,'logs'),{recursive:true,force:true});const snapshot=buildSnapshot({legacyRoot:root,generatedAt:now});
 assert.equal(snapshot.tasks.length,3);assert.equal(snapshot.reconciliation.missingCount,3);
 assert.equal(snapshot.receipts.every(r=>r.observedAt===null),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('explicit site-default reconciliation still preserves single Harvest display identity',()=>{
 const s=buildSnapshot({legacyRoot:fixture,generatedAt:now,ptStatusReport:{source:'harvest',generatedAt:now,sites:[{origin:'https://daily.example',userId:'123',username:'fixture-user',status:'unknown',observedAt:null}]}});
 const t=s.tasks.find(t=>t.origin==='https://daily.example');assert.equal(t.identity.userId,'123');assert.equal(t.identity.source,'harvest');
});
test('AnyRouter source is preserved, missing/unknown evidence never becomes authoritative',()=>{
 const context={businessDate:'2026-09-02',referenceAt:now};
 const known=normalizeEvidence({status:'signed',evidence:{source:'sign_in_response',authoritative:true}},context);
 assert.equal(known.source,'api');assert.equal(known.rawSource,'sign_in_response');assert.equal(known.verification,'verified');
 assert.equal(normalizeEvidence({status:'signed',reason:'success'},context).verification,'missing_evidence');
 assert.equal(normalizeEvidence({status:'signed',evidence:{source:'api'}},context).authoritative,false);
 assert.equal(normalizeEvidence({status:'signed',evidence:{source:'unknown_adapter',authoritative:true}},context).authoritative,false);
 assert.equal(normalizeEvidence({status:'signed',evidence:{source:'api',authoritative:false}},context).authoritative,false);
});
test('cached unavailability retains original evidence, but is never a success',()=>{
 const evidence=normalizeEvidence({status:'not_available',evidence:{source:'cached_confirmation',originalSource:'new_api_checkin_status',outcome:'message_not_enabled',authoritative:true,confirmedAt:'2026-09-01T02:00:00Z'}},{businessDate:'2026-09-02',referenceAt:now});
 assert.equal(evidence.source,'health_cache');assert.equal(evidence.originalSource,'new_api_checkin_status');assert.equal(evidence.verification,'feature_unavailable');
});
test('wrong date, future timestamp, and account mismatch cannot establish success',()=>{
 const context={businessDate:'2026-09-02',referenceAt:now,expectedId:'1'};
 for(const evidence of [{source:'api',createdAt:'2026-09-01T01:00:00Z'},{source:'api',createdAt:'2026-09-03T01:00:00Z'},{source:'api',accountId:'2'}])
 assert.equal(normalizeEvidence({status:'signed',evidence},context).authoritative,false);
});
