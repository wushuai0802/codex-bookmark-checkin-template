import test from 'node:test';
import assert from 'node:assert/strict';
import {taskResultBucket,matchesTask,TASK_FILTERS} from '../public/dashboard-model.mjs';
import {overviewMetrics,overviewResultCounts,overviewFreshness} from '../public/overview-model.mjs';
import {attentionReason,overviewQueuePreview} from '../public/notice-state.mjs';

const origin='https://pt.example';
const task=(value={})=>({taskId:'task-1',origin,businessDate:'2026-10-22',observedStatus:'signed',
  evidence:{authoritative:true},...value});

test('success receipts and verified success stay separate presentation buckets',()=>{
  assert.equal(taskResultBucket(task()),'verified');
  assert.equal(taskResultBucket(task({evidence:{authoritative:false}})),'proof');
  assert.equal(taskResultBucket(task({observedStatus:'already_signed'})),'verified');
  assert.equal(taskResultBucket(task({observedStatus:'already_signed',evidence:{authoritative:false}})),'proof');
  assert.equal(taskResultBucket(task({observedStatus:'not_available'})),'excluded');
  assert.equal(taskResultBucket(task({observedStatus:'not_available',evidence:{authoritative:false}})),'proof');
  assert.equal(taskResultBucket(task({observedStatus:'login_required',evidence:null})),'actionable');
  assert.equal(taskResultBucket(task({observedStatus:'failed',evidence:null})),'actionable');
});

test('site-side conditions and configured cancellations leave the actionable queue without losing the receipt',()=>{
  const maintenance=task({observedStatus:'needs_attention',condition:'submission_outcome_unknown',
    failureCode:'submission_outcome_unknown',submissionAttempted:true,availability:{condition:'site_maintenance'}});
  assert.equal(taskResultBucket(maintenance),'excluded');
  assert.equal(maintenance.failureCode,'submission_outcome_unknown');
  assert.equal(maintenance.submissionAttempted,true);
  assert.equal(taskResultBucket(task({observedStatus:'not_available',condition:'task_disabled',
    evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}})),'excluded');
  assert.equal(taskResultBucket(task({observedStatus:'needs_attention',condition:'site_migration',
    failureCode:'site_migration',evidence:{authoritative:false}})),'excluded');
});

test('the four result filters match their own bucket and never overlap',()=>{
  const tasks=[task(),task({taskId:'proof',evidence:{authoritative:false}}),
    task({taskId:'action',observedStatus:'login_required',evidence:null}),
    task({taskId:'off',observedStatus:'not_available'})];
  const buckets=['verified','proof','actionable','excluded'];
  for(const bucket of buckets){
    assert.equal(tasks.filter(item=>matchesTask(item,{status:bucket})).length,1,bucket);
    assert.ok(TASK_FILTERS.some(([value])=>value===bucket),`${bucket} must stay selectable`);
  }
  assert.equal(tasks.filter(item=>matchesTask(item,{status:'completed'})).length,2);
  assert.equal(tasks.filter(item=>matchesTask(item,{status:'pending'})).length,1);
});

test('identity review is a reason inside the actionable bucket, not a success',()=>{
  const review=task({observedStatus:'needs_attention',evidence:{authoritative:false,verification:'identity_conflict'}});
  assert.equal(taskResultBucket(review),'actionable');
  assert.equal(matchesTask(review,{status:'identity_review'}),true);
  assert.equal(matchesTask(task({observedStatus:'needs_attention',evidence:{authoritative:false}}),{status:'identity_review'}),false);
});

test('overview result counts reconcile with the existing verified/unavailable metrics',()=>{
  const tasks=[task(),task({taskId:'b',evidence:{authoritative:false}}),
    task({taskId:'c',observedStatus:'not_available'}),
    task({taskId:'d',observedStatus:'not_available',condition:'task_disabled',
      evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}}),
    task({taskId:'e',observedStatus:'login_required',evidence:null}),
    task({taskId:'f',observedStatus:'needs_attention',availability:{condition:'site_maintenance'},evidence:{authoritative:false}})];
  const data={generatedAt:new Date().toISOString(),businessDate:'2026-10-22',
    counts:{executionUnits:tasks.length},tasks,
    evidenceQuality:{verifiedSuccess:1,unverifiedSuccess:1,verifiedUnavailable:1,unverifiedUnavailable:0,cancelled:1}};
  const metrics=overviewMetrics(data),counts=overviewResultCounts(data);
  assert.equal(counts.verified,1);
  assert.equal(counts.proof,1);
  assert.equal(counts.actionable,1);
  assert.equal(counts.excluded,3);
  assert.equal(counts.verified+counts.proof+counts.actionable+counts.excluded,metrics.total);
});

test('business date, snapshot freshness and source health are reported separately',()=>{
  const now=Date.parse('2026-10-22T06:00:00Z');
  const current=overviewFreshness({businessDate:'2026-10-22',generatedAt:'2026-10-22T05:55:00Z'},now);
  assert.equal(current.businessCurrent,true);assert.equal(current.snapshotFresh,true);
  const yesterday=overviewFreshness({businessDate:'2026-10-21',generatedAt:'2026-10-21T05:55:00Z'},now);
  assert.equal(yesterday.businessCurrent,false);assert.equal(yesterday.businessLabel,'非今日业务');
  // Business date and snapshot age are reported independently: a 24h-old
  // snapshot can still be inside the 26h window while belonging to yesterday.
  assert.equal(yesterday.snapshotLabel,'快照新鲜');
  const expired=overviewFreshness({businessDate:'2026-10-20',generatedAt:'2026-10-20T05:55:00Z'},now);
  assert.equal(expired.snapshotLabel,'快照已过期');
  const staleGeneration=overviewFreshness({businessDate:'2026-10-22',generatedAt:'2026-10-22T05:59:00Z',
    snapshotMeta:{generationStale:true}},now);
  assert.equal(staleGeneration.snapshotFresh,false);
  assert.match(staleGeneration.snapshotLabel,/同步未完成/);
  assert.equal(overviewFreshness({},now).snapshotLabel,'尚无快照');
});

test('queue reasons rank login and execution failures ahead of proof, deferral and site waits',()=>{
  const reasons={
    login:attentionReason(task({observedStatus:'login_required',evidence:null})),
    failed:attentionReason(task({observedStatus:'failed',evidence:null})),
    proof:attentionReason(task({evidence:{authoritative:false}})),
    deferred:attentionReason(task({observedStatus:'deferred',evidence:null})),
    external:attentionReason(task({observedStatus:'deferred',condition:'site_maintenance',evidence:null}))
  };
  assert.equal(reasons.login.label,'需登录');assert.equal(reasons.login.filter,'login_required');
  assert.equal(reasons.failed.label,'执行异常');assert.equal(reasons.failed.filter,'failed');
  assert.equal(reasons.proof.label,'回执待补证');
  assert.equal(reasons.deferred.label,'已延后');
  assert.equal(reasons.external.label,'站点维护');
  const order=Object.values(reasons).sort((a,b)=>a.priority-b.priority).map(value=>value.label);
  assert.deepEqual(order,['需登录','执行异常','回执待补证','已延后','站点维护']);
});

test('queue preview groups only its own bucket and keeps paused items out of the count',()=>{
  const now=Date.parse('2026-10-22T06:00:00Z');
  const shared={origin,businessDate:'2026-10-22',observedStatus:'signed',evidence:{authoritative:false,summary:'same cause'}};
  const tasks=[{...shared,taskId:'a',accountRef:'one'},{...shared,taskId:'b',accountRef:'two'},
    task({taskId:'c',observedStatus:'login_required',evidence:null}),
    task({taskId:'d',observedStatus:'login_required',evidence:null,attention:{pausedUntil:'2026-10-23T00:00:00Z'}}),
    task({taskId:'e',observedStatus:'needs_attention',availability:{condition:'site_maintenance'},evidence:{authoritative:false}})];
  const proof=overviewQueuePreview(tasks,'proof',4,now);
  assert.equal(proof.all.length,2);
  assert.equal(proof.visible.length,1);
  assert.equal(proof.visible[0].tasks.length,2);
  assert.equal(proof.pausedCount,0);
  const actionable=overviewQueuePreview(tasks,'actionable',4,now);
  assert.equal(actionable.all.length,1);
  assert.equal(actionable.pausedCount,1);
  const external=overviewQueuePreview(tasks,'external',4,now);
  assert.equal(external.all.length,1);
  assert.equal(external.all[0].taskId,'e');
});
