import assert from 'node:assert/strict';
import test from 'node:test';
import {planHarvestFallback} from '../src/harvest-fallback.mjs';

const origin='https://tracker.example',now=new Date('2026-11-11T04:00:00Z');
const row={origin,accountKey:'site-default',status:'deferred',failureCode:'site_maintenance',
  siteCondition:'site_maintenance',submissionAttempted:false,observedAt:now.toISOString()};
function fixture(prior=row){
  return {now,fallbackOnlyEnabled:true,
    harvest:{source:'harvest',businessDate:'2026-11-11',generatedAt:now.toISOString(),
      sites:[{origin,status:'failed',observedAt:now.toISOString(),evidence:{authoritative:false}}],
      taskCompletion:{resultId:1,status:'completed',startedAt:'2026-11-11T01:00:00Z',completedAt:'2026-11-11T01:01:00Z'}},
    catalog:{sites:[{origin,entryUrl:origin+'/index.php'}]},
    plan:{targets:[{origin,folderNames:['PT']}]},
    latest:{runId:'20261111-fixture',runState:'final',isComplete:true,results:[prior]}};
}

test('today unsubmitted maintenance from the main run prevents automatic fallback rereads',()=>{
  const preview=planHarvestFallback(fixture());
  assert.deepEqual(preview.eligible,[]);
  assert.deepEqual(preview.blocked,[{origin,reason:'external_condition',external:true}]);
});

for(const [name,change] of Object.entries({
  yesterday:{observedAt:'2026-11-10T04:00:00Z'},future:{observedAt:'2026-11-12T04:00:00Z'},
  undated:{observedAt:null},otherAccount:{accountKey:'example-other'},
  unknownWrite:{status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true},
  missingSubmissionFact:{submissionAttempted:undefined},
  login:{status:'login_required',failureCode:'login_required',siteCondition:undefined},
}))test('maintenance fallback suppression does not apply to '+name,()=>{
  assert.equal(planHarvestFallback(fixture({...row,...change})).eligible.length,1);
});

test('paused configuration still owns the result and today completion still wins',()=>{
  const paused=fixture();paused.config={disabledCheckinOrigins:[origin]};
  assert.deepEqual(planHarvestFallback(paused).blocked,[{origin,reason:'disabled_by_v1_configuration'}]);
  const completed=fixture();completed.harvest.sites[0]={origin,status:'signed',observedAt:now.toISOString(),evidence:{authoritative:true}};
  assert.equal(planHarvestFallback(completed).observedSuccess,1);
});
