import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLiveSnapshot } from '../scripts/live-smoke.mjs';

function snapshot(overrides = {}) {
  return {
    mode: 'shadow_read_only',
    businessDate: '2026-09-04',
    generatedAt: '2026-09-04T12:00:00.000Z',
    counts: { logicalSites: 1, executionUnits: 1 },
    tasks: [{ taskId: 'task_0123456789abcdef01234567', planUnitId: 'unit_0123456789abcdef01234567' }],
    health: { freshness: { fresh: true }, healthy: true, sourceCheckedAt: '2026-09-04T12:00:00.000Z' },
    ...overrides
  };
}

test('live smoke accepts only a fresh healthy read-only snapshot', () => {
  assert.deepEqual(validateLiveSnapshot(snapshot(), { now: '2026-09-04T12:10:00Z' }), {
    ok: true,
    mode: 'shadow_read_only',
    businessDate: '2026-09-04',
    logicalSites: 1,
    executionUnits: 1,
    healthFresh: true,
    healthHealthy: true
  });
});

test('live smoke rejects stale or unhealthy source health', () => {
  assert.throws(() => validateLiveSnapshot(snapshot({ health: { freshness: { fresh: false }, healthy: true } })), /stale/);
  assert.throws(() => validateLiveSnapshot(snapshot({ health: { freshness: { fresh: true }, healthy: false } })), /unhealthy/);
});
