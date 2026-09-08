import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewMetrics, statusGradient } from '../public/overview-model.mjs';

test('success, disabled and outstanding counts do not overlap', () => {
  const now = Date.now();
  const data = { generatedAt: new Date(now).toISOString(), counts:{executionUnits:23}, status:{signed:14,already_signed:3,not_available:4,deferred:2}, source:{executionComplete:true}, health:{healthy:true,sourceCheckedAt:new Date(now).toISOString(),freshness:{fresh:true}} };
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
