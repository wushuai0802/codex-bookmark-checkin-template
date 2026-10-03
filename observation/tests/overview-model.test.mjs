import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewMetrics, overviewStatusCounts, projectOverviewSnapshot, dailySummaryTitle, statusGradient } from '../public/overview-model.mjs';

test('both successful outcomes share one chart category for live and historical counts without altering records or evidence quality',()=>{
  const data={counts:{executionUnits:4},status:{signed:1,already_signed:2,login_required:1},
    evidenceQuality:{verifiedSuccess:2},tasks:[{observedStatus:'signed'},{observedStatus:'already_signed'},
      {observedStatus:'already_signed'},{observedStatus:'login_required'}]};
  const original=JSON.stringify(data),expected={signed:3,login_required:1};
  assert.deepEqual(overviewStatusCounts(data),expected);
  assert.deepEqual(overviewStatusCounts({...data,tasks:undefined}),expected);
  assert.equal(statusGradient(data.status),'conic-gradient(#36c99b 0% 75%,#ffac70 75% 100%)');
  const metrics=overviewMetrics(data);
  assert.equal(metrics.success,3);assert.equal(metrics.pending,1);
  assert.equal(metrics.verifiedSuccess,2);assert.equal(metrics.unverifiedSuccess,1);
  assert.equal(JSON.stringify(data),original);
});

test('confirmed site faults leave the success denominator while local failures and unknown outcomes remain',()=>{
  const tasks=[{observedStatus:'signed'},
    {observedStatus:'deferred',condition:'upstream_unavailable',failureCode:'tls_certificate_invalid'},
    {observedStatus:'deferred',condition:'site_maintenance'},
    {observedStatus:'deferred',condition:'rate_limit'},
    {observedStatus:'deferred',condition:'upstream_unavailable',failureCode:'network_error'},
    {observedStatus:'needs_attention',condition:'submission_outcome_unknown'},
    {observedStatus:'login_required'},
    {observedStatus:'deferred',condition:'harvest_waiting'}];
  const data={counts:{executionUnits:tasks.length},tasks,evidenceQuality:{verifiedSuccess:1}};
  const original=JSON.stringify(data),result=overviewMetrics(data);
  assert.equal(result.excludedSiteIssues,3);assert.equal(result.eligible,5);assert.equal(result.rate,20);
  assert.equal(result.pending,7);assert.equal(result.allResolved,false);
  assert.equal(JSON.stringify(data),original);
  const sitesOnly={generatedAt:new Date().toISOString(),counts:{executionUnits:2},tasks:tasks.slice(0,2),evidenceQuality:{verifiedSuccess:1}};
  assert.equal(overviewMetrics(sitesOnly).rate,100);
  assert.equal(overviewMetrics(sitesOnly).allResolved,false);
  assert.equal(dailySummaryTitle(overviewMetrics(sitesOnly)),'项目签到已完成 · 1 个站点待恢复');
  assert.equal(overviewMetrics({...sitesOnly,tasks:tasks.slice(0,1)}).excludedSiteIssues,0);
  const noExecutable={counts:{executionUnits:1},tasks:tasks.slice(1,2)};
  assert.equal(overviewMetrics(noExecutable).rate,null);
});

test('overview separates maintenance, active uncertainty and deferred work without inflating completion',()=>{
  const data={counts:{executionUnits:5},status:{signed:1,needs_attention:2,deferred:1,not_available:1},
    evidenceQuality:{verifiedSuccess:1,verifiedUnavailable:1},tasks:[
      {observedStatus:'signed'},
      {observedStatus:'needs_attention',condition:'submission_outcome_unknown',availability:{condition:'site_maintenance'}},
      {observedStatus:'needs_attention',condition:'submission_outcome_unknown'},
      {observedStatus:'deferred'},
      {observedStatus:'not_available'}]};
  const original=JSON.stringify(data);
  assert.deepEqual(overviewStatusCounts(data),{signed:1,external:1,verification:1,deferred:1,not_available:1});
  const metrics=overviewMetrics(data);
  assert.equal(metrics.pending,3);assert.equal(metrics.success,1);assert.equal(metrics.verifiedSuccess,1);
  assert.equal(metrics.manual,1);assert.equal(metrics.external,1);assert.equal(metrics.deferred,1);
  assert.equal(metrics.allResolved,false);assert.equal(JSON.stringify(data),original);
  assert.deepEqual(overviewStatusCounts({...data,tasks:data.tasks.slice(0,1)}),data.status);
});

test('success, disabled and outstanding counts do not overlap', () => {
  const now = Date.now();
  const data = { generatedAt: new Date(now).toISOString(), counts:{executionUnits:23}, status:{signed:14,already_signed:3,not_available:4,deferred:2}, source:{executionComplete:true}, health:{healthy:true,sourceCheckedAt:new Date(now).toISOString(),freshness:{fresh:true}} };
  data.evidenceQuality={verifiedSuccess:17,verifiedUnavailable:4};
  const m = overviewMetrics(data,now);
  assert.equal(m.success,17); assert.equal(m.unavailable,4); assert.equal(m.pending,2); assert.equal(m.rate,89);
  assert.equal(m.executionRate,74);
  assert.equal(m.allResolved,false); assert.equal(m.healthy,true);
  data.health.healthy = false; assert.equal(overviewMetrics(data,now).healthy,false);
  data.health.healthy = true; assert.equal(overviewMetrics(data,now+27*3_600_000).healthy,false);
  assert.equal(overviewMetrics(data,now+27*3_600_000).fresh,false);
});
test('chart segments use real counts, including missing-login states', () => {
  assert.equal(statusGradient({signed:1,login_required:1}), 'conic-gradient(#36c99b 0% 50%,#ffac70 50% 100%)');
  assert.equal(statusGradient({}), '#e8edf3');
  assert.equal(overviewMetrics({}).pending,0);
});

test('unverified successes and unavailability cannot inflate verified completion',()=>{
  const data={counts:{executionUnits:22},status:{signed:11,already_signed:1,not_available:8,deferred:2},evidenceQuality:{verifiedSuccess:1,verifiedUnavailable:1}};
  const result=overviewMetrics(data);
  assert.equal(result.success,12);assert.equal(result.verifiedSuccess,1);assert.equal(result.unverifiedSuccess,11);
  assert.equal(result.executionRate,55);
  assert.equal(result.unverifiedUnavailable,7);assert.equal(result.eligible,21);assert.equal(result.rate,5);
  assert.equal(overviewMetrics({counts:{executionUnits:1},status:{signed:1}}).allResolved,false);
});

test('a newly synchronized previous-day report is not current-day data',()=>{
  const now=Date.parse('2026-09-19T16:30:00Z');
  const data={businessDate:'2026-09-19',generatedAt:'2026-09-19T16:29:00Z',counts:{executionUnits:1},status:{signed:1},evidenceQuality:{verifiedSuccess:1}};
  assert.equal(overviewMetrics(data,now).fresh,false);
  data.businessDate='2026-09-20';assert.equal(overviewMetrics(data,now).fresh,true);
});

test('paused attention stays unfinished in the daily headline',()=>{
  const metrics={total:22,pending:2,fresh:true,allResolved:false};
  assert.equal(dailySummaryTitle(metrics,{pausedCount:2}),'2 项未完成 · 2 项暂缓关注');
  assert.equal(dailySummaryTitle(metrics,{pausedCount:0}),'还有 2 个签到项待处理');
  assert.equal(dailySummaryTitle(metrics,{previousDay:true,pausedCount:2}),'等待今日签到结果');
});

test('an API fallback generation is visibly stale even when its receipt is from today',()=>{
  const now=Date.parse('2026-10-02T08:00:00Z');
  const response={snapshot:{businessDate:'2026-10-02',generatedAt:'2026-10-02T07:55:00Z',counts:{executionUnits:1}},
    tasks:[{observedStatus:'signed'}],status:{signed:1},evidenceQuality:{verifiedSuccess:1},
    snapshotMeta:{available:true,fresh:false,generationStale:true}};
  const original=JSON.stringify(response),snapshot=projectOverviewSnapshot(response),metrics=overviewMetrics(snapshot,now);
  assert.equal(metrics.total,1);assert.equal(metrics.fresh,false);assert.equal(dailySummaryTitle(metrics),'当前数据已过期');
  assert.equal(JSON.stringify(response),original);
  response.snapshotMeta={available:true,fresh:true,generationStale:false};
  assert.equal(overviewMetrics(projectOverviewSnapshot(response),now).fresh,true);
});

test('a cancelled account cannot keep an otherwise complete nested overview awaiting evidence',()=>{
  const now=Date.parse('2026-10-02T08:00:00Z'),cancelled={observedStatus:'not_available',condition:'task_disabled',
    evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}};
  const response={snapshot:{businessDate:'2026-10-02',generatedAt:'2026-10-02T07:55:00Z',counts:{executionUnits:25}},
    tasks:[...Array.from({length:19},()=>({observedStatus:'signed'})),...Array.from({length:5},()=>({observedStatus:'not_available'})),cancelled],
    status:{signed:19,not_available:6},evidenceQuality:{verifiedSuccess:19,verifiedUnavailable:5,cancelled:1}};
  const data=projectOverviewSnapshot(response),metrics=overviewMetrics(data,now);
  assert.deepEqual(overviewStatusCounts(data),{signed:19,not_available:5,cancelled:1});
  assert.deepEqual(overviewStatusCounts({...data,tasks:undefined}),{signed:19,not_available:5,cancelled:1});
  assert.equal(metrics.cancelled,1);assert.equal(metrics.unavailable,5);assert.equal(metrics.pending,0);
  assert.equal(metrics.unverifiedUnavailable,0);assert.equal(metrics.allResolved,true);assert.equal(metrics.rate,100);
  assert.equal(dailySummaryTitle(metrics),'今日签到项已全部确认');
  assert.equal(response.status.not_available,6);assert.equal(cancelled.observedStatus,'not_available');
});
