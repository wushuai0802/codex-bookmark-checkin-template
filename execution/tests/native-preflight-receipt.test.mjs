import assert from "node:assert/strict";
import test from "node:test";
import { currentNativePreflightResults, completedNativeRecovery } from "../src/native-preflight-receipt.mjs";
import { isTerminalResult } from "../src/result-contract.mjs";
import { reuseRecentNotAvailable } from "../src/site-state.mjs";

const origin = "https://pt.example";
const now = new Date("2026-10-02T04:00:00.000Z");
const generatedAt = "2026-10-02T03:59:59.000Z";
function completed(overrides = {}) {
  return {
    origin, status: "already_signed", submissionAttempted: false,
    evidence: {
      source: "page_text", authoritative: true,
      confirmedAt: "2026-10-02T03:59:58.000Z", businessDate: "2026-10-02",
      statusSignal: "nexus_daily_header_signed",
    },
    ...overrides,
  };
}
function read(results, options = {}) {
  return currentNativePreflightResults({ generatedAt, results }, { allowedOrigins: [origin], now, ...options });
}

test("native preflight retains authoritative same-day completion in the configured scope", () => {
  for (const status of ["signed", "already_signed"]) {
    const result = completed({ status });
    assert.equal(read([result]).get(origin), result);
    assert.equal(isTerminalResult(read([result]).get(origin)), true);
  }
  assert.equal(read([completed({ origin: "https://outside.example" })]).size, 0);
});

test('a dated native completion repairs a lost response without making the old submission retryable', () => {
  const prior={origin,status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false};
  const receipt=completed();
  assert.equal(completedNativeRecovery({origin},prior,read([receipt])),receipt);
  assert.equal(prior.status,'needs_attention');
  assert.equal(prior.retryable,false);
  assert.equal(completedNativeRecovery({origin,accountKey:'other-account'},prior,read([receipt])),null);
  assert.equal(completedNativeRecovery({origin},{...prior,status:'already_signed'},read([receipt])),null);
});

test('invalid native completion cannot reopen the recovery path for an uncertain submission', () => {
  const prior={origin,status:'needs_attention',submissionAttempted:true,retryable:false};
  for(const evidence of [undefined,{...completed().evidence,authoritative:false},
    {...completed().evidence,businessDate:'2026-10-01',confirmedAt:'2026-10-01T03:59:58.000Z'}]){
    assert.equal(completedNativeRecovery({origin},prior,read([completed({evidence})])),null);
  }
});

test("a native report from two seconds before midnight cannot complete the new Shanghai day", () => {
  const result = completed({ evidence: {
    ...completed().evidence, confirmedAt: "2026-10-02T15:59:58.000Z",
  } });
  const report = { generatedAt: "2026-10-02T15:59:59.000Z", results: [result] };
  const afterMidnight = new Date("2026-10-02T16:00:01.000Z");
  assert.equal(currentNativePreflightResults(report, {
    allowedOrigins: [origin], now: afterMidnight,
  }).size, 0);
});

test("fresh report generation does not refresh yesterday's individual receipt", () => {
  const result = completed({ evidence: {
    ...completed().evidence, confirmedAt: "2026-10-01T15:59:58.000Z", businessDate: "2026-10-01",
  } });
  const value = read([result]).get(origin);
  assert.equal(isTerminalResult(value), false);
  assert.equal(value.evidence.authoritative, false);
  assert.equal(value.submissionAttempted, false);
});

test("invalid, stale and future native report times cannot authorize completion", () => {
  for (const timestamp of [undefined, "invalid", "2026-10-02T03:49:59.999Z", "2026-10-02T04:00:00.001Z"]) {
    assert.equal(currentNativePreflightResults({ generatedAt: timestamp, results: [completed()] }, {
      allowedOrigins: [origin], now,
    }).size, 0, String(timestamp));
  }
});

test("completion requires authoritative dated evidence no later than its report", () => {
  const evidence = completed().evidence;
  for (const candidate of [
    undefined,
    { ...evidence, authoritative: false },
    { ...evidence, confirmedAt: "invalid" },
    { ...evidence, confirmedAt: "2026-10-02T03:59:59.001Z" },
    { ...evidence, confirmedAt: "2026-10-02T04:00:01.000Z" },
    { ...evidence, businessDate: undefined },
    { ...evidence, businessDate: "2026-10-01" },
  ]) {
    const value = read([completed({ evidence: candidate })]).get(origin);
    assert.equal(value.status, "unconfirmed");
    assert.equal(isTerminalResult(value), false);
  }
});

test("rejecting a completion receipt retains uncertain submission protection", () => {
  const value = read([completed({ submissionAttempted: true, evidence: undefined })]).get(origin);
  assert.equal(value.status, "needs_attention");
  assert.equal(value.failureCode, "submission_outcome_unknown");
  assert.equal(value.submissionAttempted, true);
  assert.equal(value.retryable, false);
});

test("a stale or cross-day native report never discards a possible submission", () => {
  for (const timestamp of ["2026-10-01T15:59:59.000Z", "2026-10-02T03:49:59.999Z", "2026-10-02T04:00:01.000Z"]) {
    const report = { generatedAt: timestamp, results: [completed({ submissionAttempted: true })] };
    const value = currentNativePreflightResults(report, { allowedOrigins: [origin], now }).get(origin);
    assert.equal(value.status, "needs_attention");
    assert.equal(value.failureCode, "submission_outcome_unknown");
    assert.equal(value.submissionAttempted, true);
    assert.equal(value.evidence.authoritative, false);
    assert.equal(value.retryable, false);
  }
});

test("valid earlier feature-disabled evidence remains reusable without becoming a daily reward", () => {
  const priorEvidence = {
    source: "new_api_checkin_status", outcome: "message_not_enabled",
    authoritative: true, confirmedAt: "2026-10-01T03:00:00.000Z",
  };
  const cached = reuseRecentNotAvailable({ origin }, { sites: {
    [origin]: {
      lastConfirmedStatus: "not_available", lastAvailabilityKind: "feature_disabled",
      lastConfirmedAt: priorEvidence.confirmedAt, lastConfirmedEvidence: priorEvidence,
    },
  } }, { knownNoCheckinFeatureOrigins: [origin], knownNoCheckinRecheckHours: 168 }, now);
  assert.ok(cached);
  const result = { origin, ...cached };
  assert.equal(read([result]).get(origin), result);
  assert.equal(isTerminalResult(read([result]).get(origin)), true);
  assert.equal(read([completed({ status: "not_available", evidence: undefined })]).size, 0);
});

test("explicit configuration cancellation keeps the established availability contract", () => {
  const result = {
    origin, status: "not_available", availabilityKind: "task_disabled", disabledByConfig: true,
    evidence: { source: "configuration", authoritative: true, confirmedAt: "2026-10-01T03:00:00.000Z" },
  };
  assert.equal(read([result]).get(origin), result);
  assert.equal(isTerminalResult(read([result]).get(origin)), true);
  assert.equal(read([{ ...result, disabledByConfig: false }]).size, 0);
});

test("current non-success diagnostics preserve login and unknown-outcome recovery metadata", () => {
  for (const result of [
    { origin, status: "login_required", submissionAttempted: false },
    { origin, status: "needs_attention", submissionAttempted: true, failureCode: "submission_outcome_unknown" },
    { origin, status: "deferred", retryCause: "harvest_waiting", submissionAttempted: false },
  ]) assert.equal(read([result]).get(origin), result);
});
