import { compatiblePriorResult } from "./result-identity.mjs";

const VIBE_CLAIM_ORIGIN = "https://new.sharedchat.cc";
const OPEN_CD_ORIGIN = "https://open.cd";
const OPEN_CD_UNCERTAIN_REASON = "OpenCD 验证码已提交，但未收到成功结果";

function confirmedClaim(result) {
  const evidence = result?.evidence;
  if (!["signed", "already_signed"].includes(result?.status)
    || evidence?.authoritative !== true
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(evidence.businessDate ?? ""))) return false;
  if (evidence.source === "vibe_claim_response") {
    const at = Date.parse(evidence.confirmedAt ?? "");
    return evidence.endpoint === "/frontend-api/vibe-code/codex/claim"
      && Boolean(evidence.accountId||evidence.userId)
      && evidence.requestMethod === 'POST' && evidence.actionType === 'daily_entitlement_claim'
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
    ...(Number.isFinite(Date.parse(persisted??''))?{observedAt:persisted}:{}),
    ...(prior?.candidateHistory ? { candidateHistory: prior.candidateHistory } : {}),
  };
}

export function quotaClaimState(previous, result, finishedAt, config = {}) {
  if (result?.origin !== VIBE_CLAIM_ORIGIN || !config.quotaRequestRules?.[result.origin]) return previous ?? undefined;
  if (confirmedClaim(result)) return null;
  if (uncertainClaim(result)) return previous ?? finishedAt.toISOString();
  return previous ?? null;
}

function confirmedOpenCd(result) {
  const evidence = result?.evidence;
  const at = Date.parse(evidence?.confirmedAt ?? evidence?.createdAt ?? "");
  return ["signed", "already_signed"].includes(result?.status)
    && evidence?.authoritative === true
    && ["page_text", "pt_page"].includes(evidence.source)
    && /^\d{4}-\d{2}-\d{2}$/.test(String(evidence.businessDate ?? ""))
    && Number.isFinite(at)
    && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(at)) === evidence.businessDate;
}

function uncertainOpenCd(result) {
  return result?.origin === OPEN_CD_ORIGIN && (
    uncertainClaim(result) ||
    (result.status === "interactive_challenge" && result.reason === OPEN_CD_UNCERTAIN_REASON)
  );
}

// A historical captcha result lacked the unknown-submission flag even though
// the form POST had already been sent. Quarantine that exact legacy outcome.
export function pendingOpenCdSubmission(target, state, previousReport) {
  if (target?.origin !== OPEN_CD_ORIGIN || String(target.accountKey ?? "site-default") !== "site-default") return null;
  const prior = compatiblePriorResult(target, previousReport?.results ?? []);
  if (confirmedOpenCd(prior)) return null;
  const persisted = state?.sites?.[target.origin]?.pendingOpenCdAt;
  if (!uncertainOpenCd(prior) && !Number.isFinite(Date.parse(persisted ?? ""))) return null;
  return {
    status: "needs_attention",
    reason: "OpenCD 验证码提交结果不明，先核验今日签到记录",
    ...(Number.isFinite(Date.parse(persisted??''))?{observedAt:persisted}:{}),
    failureCode: "submission_outcome_unknown",
    submissionAttempted: true,
    retryable: false,
  };
}

export function openCdSubmissionState(previous, result, finishedAt) {
  if (result?.origin !== OPEN_CD_ORIGIN) return previous ?? undefined;
  if (confirmedOpenCd(result)) return null;
  if (uncertainOpenCd(result)) return previous ?? finishedAt.toISOString();
  return previous ?? null;
}
