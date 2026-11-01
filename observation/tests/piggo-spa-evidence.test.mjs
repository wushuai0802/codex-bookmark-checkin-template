import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {runHarvestFallback} from '../src/harvest-fallback.mjs';
import {projectPtSiteResult} from '../src/pt-site-execution.mjs';
import {normalizeEvidence} from '../src/evidence-contract.mjs';

const origin='https://piggo.me',now=new Date('2026-11-01T04:00:00Z'),businessDate='2026-11-01';
function proof(){return {origin,accountKey:'site-default',profileBinding:'a'.repeat(64),status:'not_signed',
  observedAt:now.toISOString(),businessDate,submissionAttempted:false,operationMode:'safe_history_page',readSafety:'reviewed_passive',
  evidence:{source:'api',authoritative:true,confirmedAt:now.toISOString(),businessDate,
    evidenceScope:'site_account_day',pagePath:'/calendar',statusSignal:'piggo_calendar_unsigned'}};}

test('PigGo calendar provenance survives both observation projections without adding paths for other sites',()=>{
  const result=proof();result.status='already_signed';result.evidence.statusSignal='piggo_calendar_signed';
  const projected=projectPtSiteResult(result,origin);
  assert.equal(projected.evidence.pagePath,'/calendar');
  const normalized=normalizeEvidence(result,{businessDate,referenceAt:now.toISOString()});
  assert.equal(normalized.pagePath,'/calendar');assert.equal(normalized.authoritative,true);
  const other={...result,origin:'https://tracker.example'};
  assert.equal(projectPtSiteResult(other,other.origin).evidence.pagePath,undefined);
  assert.equal(normalizeEvidence(other,{businessDate,referenceAt:now.toISOString()}).pagePath,undefined);
});

test('only the exact enabled native calendar route can hand fresh PigGo proof to the existing engine',async t=>{
  for(const variant of ['calendar','retired','execution-off','wrong-path','wrong-source','unknown']){
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'piggo-observation-fixture-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const legacyRoot=path.join(root,'legacy');
    fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(legacyRoot,'data'),{recursive:true});
    fs.writeFileSync(path.join(root,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot}));
    fs.writeFileSync(path.join(legacyRoot,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:root}));
    const current=proof();
    if(variant==='retired')current.evidence.statusSignal='nexus_daily_header_unsigned';
    if(variant==='wrong-path')current.evidence.pagePath='/index.php';
    if(variant==='wrong-source')current.evidence.source='page_text';
    if(variant==='unknown'){current.status='unknown';current.evidence.authoritative=false;}
    const policy={reviewed:true,piggoCalendar:true,mode:'safe_history_page',url:origin+'/calendar',selector:'.cal-page',
      nativeIsolatedChrome:true,nativeApiHeaderFallback:true,nativeApiExecution:variant!=='execution-off'};
    const calls=[];
    const args={root,now,clock:()=>now,execute:true,readOnlyOrigins:[origin],config:{ptReadOnlyPolicies:{[origin]:policy}},
      harvest:{source:'harvest',businessDate,generatedAt:now.toISOString(),sites:[{origin,status:'failed',observedAt:now.toISOString()}],
        taskCompletion:{resultId:1,status:'completed',startedAt:now.toISOString(),completedAt:now.toISOString()}},
      catalog:{sites:[{origin}]},plan:{targets:[{origin,folderNames:['PT']}]},
      latest:{runId:'20261101-fixture',runState:'final',isComplete:true,businessDate,results:[{
        origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true}]},
      runSite:async options=>{assert.equal(options.readOnly,true,'generic submission forbidden');calls.push('read');return current;},
      runEngine:async options=>{assert.deepEqual(options.origins,[origin]);assert.equal(options.notify,false);calls.push('engine');
        return {businessDate,observedAt:now.toISOString(),results:[{...current,status:'signed',submissionAttempted:true,
          evidence:{...current.evidence,statusSignal:'piggo_calendar_signed'}}]};}};
    await runHarvestFallback(args);
    assert.deepEqual(calls,variant==='calendar'?['read','engine']:['read'],variant);
  }
});
