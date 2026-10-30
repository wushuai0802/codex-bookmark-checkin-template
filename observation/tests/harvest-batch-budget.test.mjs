import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runHarvestFallback} from '../src/harvest-fallback.mjs';
import {spawnPtSiteChild} from '../src/pt-site-execution.mjs';
import {reconcilePtWorker} from '../src/pt-worker-lifecycle.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-batch-budget-')),legacyRoot=path.join(root,'legacy');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const d of ['config','outputs','legacy/data','legacy/scripts'])fs.mkdirSync(path.join(root,d),{recursive:true});
  fs.writeFileSync(root+'/config/runtime.local.json',JSON.stringify({executionEngine:'v1',legacyRoot}));
  fs.writeFileSync(legacyRoot+'/data/v2-integration.json',JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
  fs.writeFileSync(legacyRoot+'/scripts/Run-PtSupplement.mjs','fixture');
  const now=new Date('2026-10-30T00:45:00Z'),origins=['https://ourbits.club','https://audiences.me'];
  return {root,legacyRoot,origins,now,file:root+'/outputs/harvest-fallback-attempts-2026-10-30.json',args:{root,now,execute:true,
    harvest:{source:'harvest',businessDate:'2026-10-30',generatedAt:now.toISOString(),
      sites:origins.map(origin=>({origin,status:'failed',observedAt:now.toISOString()})),
      taskCompletion:{status:'completed',resultId:1,startedAt:now.toISOString(),completedAt:now.toISOString()}},
    catalog:{sites:origins.map(origin=>({origin}))},plan:{targets:origins.map(origin=>({origin,folderNames:['PT白名单']}))},
    latest:{runId:'20261030-fixture',runState:'final',isComplete:true,results:origins.map(origin=>({origin,status:'deferred'}))}}};
}
function receipt(origin,at,status='not_signed'){
  return {origin,status,accountKey:'site-default',profileBinding:'b'.repeat(64),businessDate:'2026-10-30',
    operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:status==='signed',observedAt:new Date(at).toISOString(),
    evidence:{source:'pt_page',authoritative:true,confirmedAt:new Date(at).toISOString(),businessDate:'2026-10-30',
      evidenceScope:'site_account_day',statusSignal:status==='signed'?'nexus_daily_header_signed':'nexus_daily_header_unsigned'}};
}
test('insufficient remaining budget defers a second site without consuming its attempt or marking failure',async t=>{
  const f=fixture(t);let at=f.now.getTime(),calls=0;
  const result=await runHarvestFallback({...f.args,clock:()=>new Date(at),deadline:at+180_000,runSite:async options=>{
    if(options.readOnly)return receipt(options.origin,at);
    calls++;at+=130_000;return receipt(options.origin,at,'signed');}});
  assert.equal(calls,1,JSON.stringify(result));const state=JSON.parse(fs.readFileSync(f.file));
  assert.equal(state.attempts.length,1);assert.equal(state.deferrals[0].state,'deferred_budget');
  assert.equal(state.deferrals[0].submissionAttempted,false);assert.equal(state.deferrals[0].origin,f.origins[1]);
  assert.equal(result.outcomes.at(-1).state,'deferred_budget');
});
test('time spent refreshing Harvest cannot start a site with an insufficient remaining budget',async t=>{
  const f=fixture(t);let at=f.now.getTime(),probes=0;
  await runHarvestFallback({...f.args,clock:()=>new Date(at),deadline:at+180_000,
    refreshHarvest:async()=>{at+=130_000;return f.args.harvest;},
    runSite:async()=>{probes++;throw Error('site must be deferred before browsing');}});
  const state=JSON.parse(fs.readFileSync(f.file));assert.equal(probes,0);assert.equal(state.attempts.length,0);
  assert.equal(state.deferrals.length,2);assert.ok(state.deferrals.every(v=>v.state==='deferred_budget'&&v.submissionAttempted===false));
});
for(const cleanupCompletes of [true,false])test(`second-site cancellation uses cleanup and preserves unknown submission (${cleanupCompletes})`,async t=>{
  const f=fixture(t),cancel=new AbortController(),marker=f.root+'/data/pt-worker-lifecycle.json';let calls=0,cleaned=false;
  const execute=async()=>{
    const child=new EventEmitter();child.pid=12345;child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    return spawnPtSiteChild({root:f.root,legacyRoot:f.legacyRoot,origin:f.origins[1],catalogFile:'fixture',catalogHash:'a'.repeat(64),
      lease:{owner:{nonce:'fixture'}},signal:cancel.signal,
      resolveScope:async()=>({profileBinding:'b'.repeat(64),privateProfile:null,shell:'pwsh.exe'}),
      spawnChild:()=>{setImmediate(()=>cancel.abort());return child;},cleanup:async()=>{
        cleaned=true;assert.equal(JSON.parse(fs.readFileSync(marker)).state,'cleanup_pending');
        if(cleanupCompletes)setImmediate(()=>child.emit('close',1,null));return cleanupCompletes;
      }});
  };
  await runHarvestFallback({...f.args,clock:()=>f.now,signal:cancel.signal,runSite:async options=>{
    if(options.readOnly)return receipt(options.origin,f.now);
    calls++;if(calls===1)return receipt(options.origin,f.now,'signed');await execute();throw Error('unreachable');}});
  assert.equal(calls,2);assert.equal(cleaned,true);
  const state=JSON.parse(fs.readFileSync(f.file)),attempt=state.attempts[1];
  assert.equal(attempt.state,'outcome_unknown');assert.equal(attempt.outcome,undefined);assert.notEqual(attempt.submissionState,'not_submitted');
  if(!cleanupCompletes){
    assert.equal(JSON.parse(fs.readFileSync(marker)).state,'cleanup_pending');
    await assert.rejects(reconcilePtWorker(f.root,{legacyRoot:f.legacyRoot,cleanup:async()=>false}),e=>e.code==='PT_CLEANUP_PENDING');
  }
  await reconcilePtWorker(f.root,{legacyRoot:f.legacyRoot,cleanup:async()=>true});assert.equal(fs.existsSync(marker),false);
  await runHarvestFallback({...f.args,clock:()=>f.now,runSite:async options=>{
    assert.equal(options.readOnly,true,'unknown attempt must not be replayed');
    return {...receipt(options.origin,f.now),status:'unknown',evidence:{source:'none',authoritative:false}};
  }});
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)).attempts[1],attempt);
});
