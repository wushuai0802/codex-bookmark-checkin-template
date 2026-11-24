import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dayVerdict, shanghaiDay} from '../public/day-verdict.mjs';
import {attentionReason} from '../public/notice-state.mjs';
import {ptEvidenceCandidates, repairPtEvidence} from '../src/pt-evidence-repair.mjs';
import {pendingHarvestFallbackAttempts, planHarvestFallback} from '../src/harvest-fallback.mjs';
import {recordPtVerification} from '../src/pt-verification.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {evaluateReleaseGate} from '../../tools/release-gate.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const save = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };

test('WO-23 T3/T5: dayVerdict classifies notice_acknowledgement_required as actionNeeded and excludes daily_open_limit from actionNeeded', () => {
  const now = new Date('2026-11-24T04:00:00Z');
  const businessDate = shanghaiDay(now);
  const verdict = dayVerdict({
    businessDate,
    receipts: [],
    ptStatus: { businessDate, sites: [] },
    tasks: [
      {
        taskId: 't-notice',
        origin: 'https://piggo.me',
        accountRef: 'acct_1',
        observedStatus: 'needs_attention',
        failureCode: 'notice_acknowledgement_required',
        observedAt: now.toISOString(),
        retryable: false,
        retryableLoginRecovery: false,
        submissionAttempted: false,
        evidence: { source: 'none', authoritative: false },
      },
      {
        taskId: 't-limit',
        origin: 'https://example-pt.test',
        accountRef: 'acct_2',
        observedStatus: 'deferred',
        failureCode: 'daily_open_limit',
        observedAt: now.toISOString(),
        retryable: false,
        retryExhaustedForDay: true,
        nextEligibleAt: '2026-11-25T00:05:00Z',
        submissionAttempted: false,
        evidence: { source: 'none', authoritative: false },
      },
    ],
  }, { now });

  assert.equal(verdict.counts.actionNeeded, 1);
  assert.equal(verdict.items.find(i => i.taskId === 't-notice').class, 'actionNeeded');
  assert.equal(verdict.items.find(i => i.taskId === 't-limit').class, 'verifying');
  assert.equal(attentionReason({ observedStatus: 'needs_attention', failureCode: 'notice_acknowledgement_required', condition: 'notice_acknowledgement_required' }).label, '需确认公告');
  assert.equal(attentionReason({ observedStatus: 'deferred', failureCode: 'daily_open_limit', condition: 'daily_open_limit' }).label, '已达日上限');
});

test('WO-23 T3: pt-status and pt-verification preserve same-day notice_acknowledgement_required and signed verdicts against later daily_open_limit', t => {
  const obsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wo23-obs-verify-'));
  t.after(() => fs.rmSync(obsRoot, { recursive: true, force: true }));
  const now = new Date();
  const businessDate = shanghaiDay(now);
  const binding = 'a'.repeat(64);
  const base = {
    origin: 'https://piggo.me',
    accountKey: 'site-default',
    profileBinding: binding,
    businessDate,
    operationMode: 'safe_history_page',
    readSafety: 'reviewed_passive',
    submissionAttempted: false,
    evidence: { source: 'none', authoritative: false, summary: 'test' },
  };
  const r1 = recordPtVerification(obsRoot, {
    ...base,
    status: 'needs_attention',
    failureCode: 'notice_acknowledgement_required',
    observedAt: new Date(now.getTime() - 20_000).toISOString(),
  }, { now });
  assert.equal(r1.recorded, true);

  const r2 = recordPtVerification(obsRoot, {
    ...base,
    status: 'unknown',
    failureCode: 'daily_open_limit',
    observedAt: now.toISOString(),
  }, { now });
  assert.equal(r2.recorded, false);

  const statusReport = buildPtStatus({
    generatedAt: now.toISOString(),
    businessDate,
    planTargets: [{ origin: 'https://piggo.me', folderNames: ['PT'], accountKey: 'site-default' }],
    externalReport: {
      source: 'harvest',
      generatedAt: now.toISOString(),
      businessDate,
      sites: [
        { origin: 'https://piggo.me', status: 'needs_attention', failureCode: 'notice_acknowledgement_required', observedAt: new Date(now.getTime() - 20_000).toISOString(), evidence: { source: 'none', authoritative: false } },
      ],
    },
    fallbackReport: {
      source: 'execution-supplement',
      generatedAt: now.toISOString(),
      businessDate,
      sites: [
        { origin: 'https://piggo.me', status: 'unknown', failureCode: 'daily_open_limit', observedAt: now.toISOString(), evidence: { source: 'none', authoritative: false } },
      ],
    },
  });
  assert.equal(statusReport.sites[0].effective.failureCode, 'notice_acknowledgement_required');
});

test('WO-23 T3: pt-evidence-repair, harvest-fallback, and release-probe ignore budget-exhausted sites while active_fallback/wakeups still block release', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wo23-release-probe-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const execRoot = path.join(tmp, 'execution');
  const obsRoot = path.join(tmp, 'observation');
  const opsRoot = path.join(tmp, 'operations');
  const now = new Date();
  const today = shanghaiDay(now);
  const runId = today.replaceAll('-', '') + '-080500-001-abcdef';
  const origin = 'https://piggo.me';
  const catalogFile = path.join(opsRoot, 'tmp/nas-sync/pt-monitor-catalog.json');

  save(path.join(obsRoot, 'config/runtime.local.json'), { executionEngine: 'v1', legacyRoot: execRoot, ptFallbackOnlyEnabled: true });
  save(path.join(execRoot, 'config/config.json'), { ptReadOnlyPolicies: { [origin]: { reviewed: true, mode: 'safe_history_page', piggoCalendar: true, dailyOpenLimit: 1 } } });
  save(path.join(execRoot, 'data/native-pt-opens.json'), {
    schemaVersion: 1,
    opens: [{ openId: 'op-1', origin, businessDate: today, openedAt: now.toISOString(), source: 'recover_native_login' }],
    notices: [],
  });
  save(path.join(opsRoot, 'config/pt-monitor.local.json'), { harvestDatabase: 'synthetic.db' });
  save(catalogFile, { sites: [{ origin, entryUrl: `${origin}/calendar`, displayName: 'PigGo' }] });
  save(path.join(obsRoot, 'data/pt-evidence-repair.json'), { schemaVersion: 1, sites: {} });
  save(path.join(obsRoot, 'outputs/shadow-beta-snapshot.json'), {
    businessDate: today,
    tasks: [{ taskId: 't-1', origin, accountKey: 'site-default', observedStatus: 'signed', submissionAttempted: false }],
    receipts: [],
    ptStatus: {
      harvestWindow: null,
      sites: [{
        origin,
        inLegacyPlan: false,
        fallbackEnabled: true,
        disabledByConfig: false,
        capabilities: { read: true },
        evidenceState: 'verification_pending',
        effective: { status: 'signed', failureCode: 'daily_open_limit', fresh: true, observedAt: new Date(now.getTime() - 120_000).toISOString(), evidence: { profileBinding: 'b'.repeat(64) } },
      }],
    },
  });

  // 1) pt-evidence-repair excludes exhausted origin
  const candidates = ptEvidenceCandidates(
    JSON.parse(fs.readFileSync(path.join(obsRoot, 'outputs/shadow-beta-snapshot.json'), 'utf8')),
    JSON.parse(fs.readFileSync(catalogFile, 'utf8')),
    { schemaVersion: 1, sites: {} },
    now,
    { exhaustedOrigins: new Set([origin]) },
  );
  assert.deepEqual(candidates, []);
  let repairRuns = 0;
  const repaired = await repairPtEvidence({
    root: obsRoot,
    catalogFile,
    clock: () => now,
    runSite: async () => { repairRuns += 1; return {}; },
    refreshCatalog: async () => catalogFile,
  });
  assert.equal(repairRuns, 0);
  assert.equal(repaired.results.length, 0);

  // 2) harvest-fallback blocks exhausted origin from eligible/pending
  const harvest = { source: 'harvest', businessDate: today, generatedAt: now.toISOString(), taskCompletion: { status: 'failed' }, sites: [{ origin, status: 'failed', observedAt: now.toISOString() }] };
  const plan = { targets: [{ origin, accountKey: 'site-default', folderNames: ['PT'] }] };
  const latest = { runId, runState: 'final', isComplete: true, results: [{ origin, accountKey: 'site-default', status: 'deferred', failureCode: 'daily_open_limit', retryExhaustedForDay: true, nextEligibleAt: '2026-11-25T00:05:00Z' }] };
  const preview = planHarvestFallback({ harvest, catalog: { sites: [{ origin, entryUrl: `${origin}/calendar` }] }, plan, latest, now, exhaustedOrigins: new Set([origin]) });
  assert.equal(preview.eligible.length, 0);
  assert.equal(preview.blocked.some(b => b.origin === origin && b.reason === 'daily_open_limit'), true);
  save(path.join(obsRoot, `outputs/harvest-fallback-attempts-${today}.json`), { businessDate: today, attempts: [] });
  assert.equal(pendingHarvestFallbackAttempts(obsRoot, preview, { now, exhaustedOrigins: new Set([origin]) }).length, 0);

  // 3) release-probe.ps1 emits no evidence candidates and no scheduled/unsettled budget blocks for exhausted origin...
  const finishedAt = new Date(now.getTime() - 60_000).toISOString();
  const startedAt = `${today}T00:00:00+08:00`;
  save(path.join(execRoot, 'logs/latest.json'), {
    runId, runState: 'final', isComplete: true, executionComplete: true, finishedAt, nextRetryAt: null,
    results: [{ status: 'deferred', retryable: false, submissionAttempted: false, retryExhaustedForDay: true, nextEligibleAt: '2026-11-25T00:05:00Z' }],
  });
  save(path.join(execRoot, 'data/scheduler-state.json'), {
    phase: 'finished', lastAttemptDate: today, lastRunId: runId, reportValid: true, reportExecutionComplete: true, automaticRetryCount: 0, nextEligibleAt: null,
  });
  save(path.join(opsRoot, 'tmp/nas-sync/harvest-pt-status.json'), {
    source: 'harvest', businessDate: today, generatedAt: finishedAt,
    taskCompletion: { resultId: 1, status: 'completed', activeTaskCount: 0, activityCoverage: 'recorded_results', startedAt: new Date(now.getTime() - 90_000).toISOString(), completedAt: finishedAt },
  });
  save(path.join(execRoot, 'data/notification-outbox/item.json'), { delivered: true });
  save(path.join(obsRoot, `outputs/harvest-fallback-attempts-${today}.json`), {
    businessDate: today,
    attempts: [],
    verifications: [{ origin, accountKey: 'site-default', state: 'deferred_busy', startedAt, nextEligibleAt: startedAt, outcome: { failureCode: 'daily_open_limit' } }],
  });
  const runProbe = () => {
    const out = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(project, 'tools/release-probe.ps1'),
      '-ExecutionRoot', execRoot, '-ObservationRoot', obsRoot, '-OpsRoot', opsRoot, '-TaskNamesJson', '["main","sync"]'], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const settledProbe = runProbe();
  assert.equal(settledProbe.evidence.value.candidates.length, 0);
  assert.equal(settledProbe.fallback.value.pending.length, 0);
  assert.equal(evaluateReleaseGate({
    ...settledProbe,
    tasks: { ok: true, value: ['main', 'sync'].map(role => ({ role, state: 'Ready', nextRunMs: Date.now() + 300_000, lastRun: finishedAt, lastResult: 0, definitionHash: 'b'.repeat(64) })) },
    processes: { ok: true, value: { count: 0, roles: [] } },
    lifecycle: { ok: true, value: { exists: false } },
    manualSessions: { ok: true, value: Array.from({ length: 3 }, () => ({ exists: false })) },
  }, { now: new Date() }).checks.no_retry_pending.ok, true);

  // ...while active_fallback or unsigned/harvest wakeup STILL blocks release!
  save(path.join(obsRoot, `outputs/harvest-fallback-attempts-${today}.json`), {
    businessDate: today,
    attempts: [{ origin, accountKey: 'site-default', state: 'in_progress', startedAt }],
    verifications: [{ origin, accountKey: 'site-default', state: 'deferred_busy', startedAt, nextEligibleAt: startedAt, outcome: { failureCode: 'daily_open_limit' } }],
  });
  const activeProbe = runProbe();
  assert.equal(activeProbe.fallback.value.pending.some(p => p.kind === 'active_fallback'), true);

  save(path.join(obsRoot, `outputs/harvest-fallback-attempts-${today}.json`), {
    businessDate: today,
    attempts: [{ origin, accountKey: 'site-default', state: 'completed', submissionState: 'not_submitted', v1Status: 'deferred', outcome: { retryCause: 'harvest_waiting' } }],
    verifications: [],
  });
  const wakeupProbe = runProbe();
  assert.equal(wakeupProbe.fallback.value.pending.some(p => p.kind === 'harvest_wakeup'), true);
});
