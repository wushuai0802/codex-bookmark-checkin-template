import test from "node:test";
import assert from "node:assert/strict";
import { pendingOpenCdSubmission, pendingQuotaClaim, quotaClaimState } from "../src/quota-claim-guard.mjs";
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
    accountId:'7',requestMethod:'POST',actionType:'daily_entitlement_claim',
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

test("a previously submitted OpenCD captcha with no receipt is quarantined across later runs", () => {
  const openCd={origin:"https://open.cd",accountKey:"site-default"};
  const legacy={origin:openCd.origin,status:"interactive_challenge",
    reason:"OpenCD 验证码已提交，但未收到成功结果"};
  const prior={runState:"final",isComplete:true,results:[legacy]};
  const blocked=pendingOpenCdSubmission(openCd,{sites:{}},prior);
  assert.equal(blocked.failureCode,"submission_outcome_unknown");
  assert.equal(blocked.submissionAttempted,true);
  const updated=updateSiteState({sites:{}},[{...legacy,...blocked}],day,config);
  assert.equal(pendingOpenCdSubmission(openCd,updated,null).retryable,false);
  assert.equal(pendingOpenCdSubmission({origin:"https://other.example"},updated,prior),null);
});

test("an older signed latest report cannot bypass a still-persisted pending OpenCD intent", () => {
  const openCd={origin:"https://open.cd",accountKey:"site-default"};
  const pendingAt="2026-10-06T02:07:17.918Z";
  const state={sites:{[openCd.origin]:{pendingOpenCdAt:pendingAt}}};
  const prior={runState:"final",isComplete:true,finishedAt:"2026-10-06T05:30:40.854Z",results:[{
    origin:openCd.origin,status:"already_signed",observedAt:"2026-10-06T05:30:40.854Z",
    evidence:{source:"pt_page",authoritative:true,businessDate:"2026-10-06",confirmedAt:"2026-10-06T05:30:40.854Z",
      statusSignal:"open_cd_daily_record_entry",evidenceScope:"site_account_day",pagePath:"/index.php"},
  }]};
  const today=new Date("2026-10-07T02:00:00Z");
  assert.equal(pendingOpenCdSubmission(openCd,state,prior,{now:today}).failureCode,"submission_outcome_unknown");
});

test("an inactive profile recovery is audit-only when a current binding is supplied", () => {
  const openCd={origin:"https://open.cd",accountKey:"site-default"};
  const state={sites:{[openCd.origin]:{
    pendingOpenCdAt:"2026-10-07T01:00:00Z",pendingOpenCdProfileBinding:"a".repeat(64),
    openCdRecoveryAttempts:[{claimId:"old",accountKey:"site-default",profileBinding:"a".repeat(64),
      businessDate:"2026-10-07",claimedAt:"2026-10-07T01:00:00Z",state:"claimed"}],
  }}};
  const prior={results:[{origin:openCd.origin,status:"needs_attention",failureCode:"submission_outcome_unknown",
    submissionAttempted:true,observedAt:"2026-10-07T01:00:00Z"}]};
  const blocked=pendingOpenCdSubmission(openCd,state,prior,{now:new Date("2026-10-07T02:00:00Z"),
    profileBinding:"b".repeat(64),allowInactiveRecovery:true});
  assert.equal(blocked.recoveryEligible,true);
  assert.equal(blocked.inactiveProfile,true);
});

test("malformed persisted OpenCD quarantine fails closed", () => {
  const openCd={origin:"https://open.cd",accountKey:"site-default"};
  const state={sites:{[openCd.origin]:{pendingOpenCdAt:"not-a-date"}}};
  const result=pendingOpenCdSubmission(openCd,state,{results:[]},{now:new Date("2026-10-07T02:00:00Z")});
  assert.equal(result.failureCode,"submission_outcome_unknown");
  assert.equal(result.submissionAttempted,true);
  assert.equal(result.stateCorrupt,true);
});

test("current bound OpenCD success closes the daily guard while retaining the historical pending record", () => {
  const openCd={origin:"https://open.cd",accountKey:"site-default"},binding="b".repeat(64);
  const state={sites:{[openCd.origin]:{pendingOpenCdAt:"2026-10-06T02:07:17.918Z"}}};
  const now=new Date("2026-10-07T02:30:00Z");
  const prior={results:[{origin:openCd.origin,accountKey:"site-default",profileBinding:binding,status:"already_signed",
    observedAt:"2026-10-07T02:21:14Z",submissionAttempted:false,evidence:{source:"pt_page",authoritative:true,
      businessDate:"2026-10-07",confirmedAt:"2026-10-07T02:21:14Z",evidenceScope:"site_account_day",pagePath:"/index.php",
      statusSignal:"open_cd_daily_record_entry"}}]};
  assert.equal(pendingOpenCdSubmission(openCd,state,prior,{now,profileBinding:binding}),null);
});
