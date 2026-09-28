import test from "node:test";
import assert from "node:assert/strict";
import { pendingQuotaClaim, quotaClaimState } from "../src/quota-claim-guard.mjs";
import { updateSiteState } from "../src/site-state.mjs";

const origin = "https://new.sharedchat.cc";
const target = { origin, accountKey: "site-default" };
const config = { quotaRequestRules: { [origin]: { reason: "fixture" } } };
const unknown = { origin, status: "needs_attention", failureCode: "submission_outcome_unknown", submissionAttempted: true };
const day = new Date("2026-09-28T02:00:00Z");

test("yesterday's uncertain quota claim blocks today's browser submission", () => {
  const state = updateSiteState({ sites: {} }, [unknown], day, config);
  const previous = { runState: "final", isComplete: true, results: [unknown] };
  const guarded = pendingQuotaClaim(target, state, previous, config);
  assert.equal(guarded.status, "needs_attention");
  assert.equal(guarded.submissionAttempted, true);
  assert.equal(guarded.retryable, false);
  const nextDayState = updateSiteState(state, [{ ...unknown, ...guarded }], new Date("2026-09-29T02:00:00Z"), config);
  assert.equal(nextDayState.sites[origin].pendingQuotaClaimAt, day.toISOString());
  assert.equal(pendingQuotaClaim(target, nextDayState, null, config).failureCode, "submission_outcome_unknown");
  assert.equal(pendingQuotaClaim({ origin: "https://daily.example" }, nextDayState, previous, config), null);
  assert.equal(pendingQuotaClaim({ ...target, accountKey: "secondary" }, nextDayState, previous, config), null);
});

test("only the matching authoritative dated claim receipt clears the quarantine", () => {
  const state = updateSiteState({ sites: {} }, [unknown], day, config);
  const receipt = { origin, status: "signed", evidence: {
    source: "vibe_claim_response", authoritative: true,
    endpoint: "/frontend-api/vibe-code/codex/claim", statusSignal: "claimed_true",
    businessDate: "2026-09-29", confirmedAt: "2026-09-29T02:00:00Z",
  } };
  assert.equal(quotaClaimState(state.sites[origin].pendingQuotaClaimAt, receipt, new Date("2026-09-29T02:00:00Z"), config), null);
  for (const bad of [
    { ...receipt, evidence: { ...receipt.evidence, endpoint: "/other" } },
    { ...receipt, evidence: { ...receipt.evidence, confirmedAt: "2026-09-28T02:00:00Z" } },
    { ...receipt, evidence: { ...receipt.evidence, authoritative: false } },
    { ...receipt, evidence: undefined },
  ]) {
    assert.equal(quotaClaimState(state.sites[origin].pendingQuotaClaimAt, bad, new Date("2026-09-29T02:00:00Z"), config), day.toISOString());
  }
});
