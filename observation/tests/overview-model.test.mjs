import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewMetrics, dailySummaryTitle, statusGradient } from '../public/overview-model.mjs';

test('success, disabled and outstanding counts do not overlap', () => {
  const now = Date.now();
  const data = { generatedAt: new Date(now).toISOString(), counts:{executionUnits:23}, status:{signed:14,already_signed:3,not_available:4,deferred:2}, source:{executionComplete:true}, health:{healthy:true,sourceCheckedAt:new Date(now).toISOString(),freshness:{fresh:true}} };
  data.evidenceQuality={verifiedSuccess:17,verifiedUnavailable:4};
  const m = overviewMetrics(data,now);
  assert.equal(m.success,17); assert.equal(m.unavailable,4); assert.equal(m.pending,2); assert.equal(m.rate,89);
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
