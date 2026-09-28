import { compatiblePriorResult } from "./result-identity.mjs";

const VIBE_CLAIM_ORIGIN = "https://new.sharedchat.cc";

function confirmedClaim(result) {
  const evidence = result?.evidence;
  if (!["signed", "already_signed"].includes(result?.status)
    || evidence?.authoritative !== true
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(evidence.businessDate ?? ""))) return false;
  if (evidence.source === "vibe_claim_response") {
    const at = Date.parse(evidence.confirmedAt ?? "");
    return evidence.endpoint === "/frontend-api/vibe-code/codex/claim"
      && evidence.statusSignal === "claimed_true" && Number.isFinite(at)
      && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(at)) === evidence.businessDate;
  }
  return evidence.source === "vibe_entitlement_status"
    && evidence.claimDate === evidence.businessDate
    && evidence.dailyRewardVerified === true;
}

function uncertainClaim(result) {
  return result?.failureCode === "submission_outcome_unknown"
    && result?.submissionAttempted === true;
}

// The frontend claim may grant a persistent entitlement. A new calendar day
// does not prove that the previous POST was rejected, so only a dated and
// authoritative claim receipt can release the quarantine.
export function pendingQuotaClaim(target, state, previousReport, config = {}) {
  if (target?.origin !== VIBE_CLAIM_ORIGIN || !config.quotaRequestRules?.[target.origin]) return null;
  if (String(target.accountKey ?? "site-default") !== "site-default") return null;
  const prior = compatiblePriorResult(target, previousReport?.results ?? []);
  if (confirmedClaim(prior)) return null;
  const persisted = state?.sites?.[target.origin]?.pendingQuotaClaimAt;
  if (!uncertainClaim(prior) && !Number.isFinite(Date.parse(persisted ?? ""))) return null;
  return {
    status: "needs_attention",
    reason: "此前权益领取提交结果不明；需先只读核验权威领取状态",
    failureCode: "submission_outcome_unknown",
    submissionAttempted: true,
    retryable: false,
    ...(prior?.candidateHistory ? { candidateHistory: prior.candidateHistory } : {}),
  };
}

export function quotaClaimState(previous, result, finishedAt, config = {}) {
  if (result?.origin !== VIBE_CLAIM_ORIGIN || !config.quotaRequestRules?.[result.origin]) return previous ?? undefined;
  if (confirmedClaim(result)) return null;
  if (uncertainClaim(result)) return previous ?? finishedAt.toISOString();
  return previous ?? null;
}
