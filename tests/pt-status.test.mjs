import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPtStatus, normalizePtStatusReport } from '../src/pt-status.mjs';

const accountRef = 'acct_0123456789abcdef';
const taskId = 'task_0123456789abcdef01234567';

test('PT status merges legacy plan sites with Harvest-only observations', () => {
  const result = buildPtStatus({
    generatedAt: '2026-09-04T04:00:00.000Z',
    businessDate: '2026-09-04',
    planTargets: [
      { origin: 'https://kylin.example/checkin', title: '麒麟', folderNames: ['PT白名单'] }
    ],
    tasks: [{ taskId, origin: 'https://kylin.example', accountRef, observedStatus: 'signed' }],
    receipts: [{ taskId, observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '今日已签到', redacted: true } }],
    externalReport: {
      generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', businessDate: '2026-09-04',
      sites: [{ origin: 'https://baozi.example/', displayName: '包子', status: 'not_signed', observedAt: '2026-09-04T03:30:00.000Z', evidence: { source: 'api', authoritative: true, summary: '今日未签到' } }]
    }
  });
  assert.equal(result.mode, 'status_observe_only');
  assert.equal(result.executionEnabled, false);
  assert.equal(result.counts.sites, 2);
  assert.equal(result.counts.inLegacyPlan, 1);
  assert.equal(result.counts.externalOnly, 1);
  assert.equal(result.counts.supplementCandidates, 1);
  const harvest = result.sites.find((site) => site.origin === 'https://baozi.example');
  assert.equal(harvest.effective.status, 'not_signed');
  assert.equal(harvest.supplementCandidate, true);
  assert.equal(harvest.supplementAction, 'manual_review_only');
  const legacy = result.sites.find((site) => site.origin === 'https://kylin.example');
  assert.equal(legacy.inLegacyPlan, true);
  assert.equal(legacy.effective.status, 'signed');
});

test('conflicting sources are visible and stale observations are never supplement candidates', () => {
  const result = buildPtStatus({
    generatedAt: '2026-09-04T04:00:00.000Z', businessDate: '2026-09-04',
    planTargets: [{ origin: 'https://piggo.example', title: '猪猪', folderNames: ['PT白名单'] }],
    tasks: [{ taskId, origin: 'https://piggo.example', accountRef: null, observedStatus: 'signed' }],
    receipts: [{ taskId, observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'page_text', authoritative: true, summary: '已签到', redacted: true } }],
    externalReport: {
      generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', sites: [
        { origin: 'https://piggo.example', status: 'not_signed', observedAt: '2026-09-03T03:00:00.000Z', evidence: { source: 'api', authoritative: true, summary: '旧状态' } }
      ]
    }
  });
  const site = result.sites[0];
  assert.equal(site.discrepancy, true);
  assert.equal(site.supplementCandidate, false);
  assert.equal(site.effective.fresh, true);
  assert.equal(site.sourceStatuses.length, 2);
});

test('PT status rejects credential-bearing reports and normalizes safe aliases', () => {
  assert.throws(() => normalizePtStatusReport({ source: 'harvest', sites: [{ origin: 'https://example.com', status: 'signed', password: 'secret' }] }), /sensitive field/);
  const report = normalizePtStatusReport({ generatedAt: '2026-09-04T04:00:00.000Z', source: 'harvest', sites: [{ origin: 'https://example.com', status: 'checked_in', observedAt: '2026-09-04T03:00:00.000Z', evidence: { source: 'api', authoritative: true, summary: 'ok' } }] });
  assert.equal(report.sites[0].status, 'signed');
  assert.equal(report.sites[0].evidence.redacted, true);
});
