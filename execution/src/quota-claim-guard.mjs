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

export function confirmedOpenCd(result, now) {
  const evidence = result?.evidence;
  const at = Date.parse(evidence?.confirmedAt ?? evidence?.createdAt ?? "");
  const signal = String(evidence?.statusSignal ?? '');
  return ["signed", "already_signed"].includes(result?.status)
    && evidence?.authoritative === true
    && ["page_text", "pt_page"].includes(evidence.source)
    && ['open_cd_daily_record_entry','submitted_success_response','same_day_page_text'].includes(signal)
    && (!evidence.evidenceScope || evidence.evidenceScope === 'site_account_day')
    && (!evidence.pagePath || evidence.pagePath === '/index.php')
    && /^\d{4}-\d{2}-\d{2}$/.test(String(evidence.businessDate ?? ""))
    && Number.isFinite(at)
    && new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date(at)) === evidence.businessDate
    && (!now || at <= now.getTime() && evidence.businessDate === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now));
}

function uncertainOpenCd(result) {
  return result?.origin === OPEN_CD_ORIGIN && (
    uncertainClaim(result) ||
    (result.status === "interactive_challenge" && result.reason === OPEN_CD_UNCERTAIN_REASON)
  );
}

// A historical captcha result lacked the unknown-submission flag even though
// the form POST had already been sent. Quarantine that exact legacy outcome.
export function pendingOpenCdSubmission(target, state, previousReport, { now = new Date(), profileBinding, allowInactiveRecovery = false } = {}) {
  if (target?.origin !== OPEN_CD_ORIGIN || String(target.accountKey ?? "site-default") !== "site-default") return null;
  const prior = compatiblePriorResult(target, previousReport?.results ?? []);
  const site = state?.sites?.[target.origin];
  const persisted = site?.pendingOpenCdAt;
  const persistedPresent = persisted !== undefined && persisted !== null && String(persisted).trim() !== '';
  const persistedAt = Date.parse(persisted ?? '');
  const persistedProfile = site?.pendingOpenCdProfileBinding;
  const persistedProfilePresent = persistedProfile !== undefined && persistedProfile !== null && String(persistedProfile).trim() !== '';
  const historyCandidates=(site?.openCdPendingHistory??[]).filter(item=>
    !['historical_confirmed','resolved_current_day'].includes(item?.status)&&
    Number.isFinite(Date.parse(item?.pendingAt??'')));
  const priorAt = prior?.observedAt ?? previousReport?.finishedAt;
  const resolvedPrior = (site?.openCdSubmissionResolutions ?? []).some(resolution =>
    ['historical_confirmed', 'current_day_confirmed'].includes(resolution.kind)
    && resolution.pendingAt === priorAt && resolution.accountKey === 'site-default'
    && /^[a-f0-9]{64}$/.test(resolution.profileBinding ?? '')
    && Number.isFinite(Date.parse(resolution.resolvedAt)) && Date.parse(resolution.resolvedAt) <= now.getTime()
    && (!profileBinding || resolution.profileBinding === profileBinding));
  const activeRecovery = (site?.openCdRecoveryAttempts ?? []).filter(recovery =>
    ['claimed', 'outcome_unknown'].includes(recovery.state) && recovery.accountKey === 'site-default'
    && Number.isFinite(Date.parse(recovery.claimedAt))
    && recovery.businessDate === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now)
    && (!profileBinding || recovery.profileBinding === profileBinding))
    .sort((a, b) => Date.parse(b.claimedAt) - Date.parse(a.claimedAt))[0];
  const pendingResolution = (site?.openCdSubmissionResolutions ?? []).some(resolution =>
    resolution.kind === 'current_day_confirmed' && resolution.accountKey === 'site-default'
    && resolution.businessDate === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now)
    && resolution.pendingAt === persisted
    && (!profileBinding || resolution.profileBinding === profileBinding));
  const linkedResolvedHistory=(site?.openCdPendingHistory??[]).some(item=>
    item.status==='resolved_current_day'&&item.pendingAt===priorAt&&
    (site?.openCdSubmissionResolutions??[]).some(resolution=>resolution.resolutionId===item.resolutionId));
  const currentResolution=(site?.openCdSubmissionResolutions??[]).some(resolution=>
    resolution.kind==='current_day_confirmed'&&resolution.accountKey==='site-default'&&
    Number.isFinite(Date.parse(resolution.resolvedAt))&&Date.parse(resolution.resolvedAt)<=now.getTime()&&
    (!profileBinding||resolution.profileBinding===profileBinding)&&
    (resolution.businessDate===new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now)||
      resolution.pendingAt===priorAt||linkedResolvedHistory));
  const inactivePending = Boolean(allowInactiveRecovery && profileBinding && (!persistedProfile || persistedProfile !== profileBinding));
  if (persistedPresent && !Number.isFinite(persistedAt)) return {
    status:'needs_attention',reason:'OpenCD 历史隔离记录损坏，先修复状态，禁止自动重放',
    failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,stateCorrupt:true,
  };
  if (persistedProfilePresent && !/^[a-f0-9]{64}$/i.test(String(persistedProfile))) return {
    status:'needs_attention',reason:'OpenCD 历史 Profile 绑定损坏，先修复状态，禁止自动重放',
    failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,stateCorrupt:true,
  };
  const unresolvedHistory=historyCandidates.filter(item=>
    !profileBinding||!item.profileBinding||item.profileBinding===profileBinding);
  const historyBlockedAt=unresolvedHistory.map(item=>Date.parse(item.pendingAt)).sort((a,b)=>b-a)[0];
  // A dated completion from an older report cannot release a still-persisted
  // pending intent. A current-day resolution or an explicitly allowed inactive
  // profile may release the current guard without rewriting the old audit.
  if (inactivePending && !activeRecovery) return {
    status:'needs_attention',reason:'OpenCD 旧提交未绑定当前 Profile；仅允许当前日 fresh 未签到证据授权一次恢复',
    ...(Number.isFinite(Date.parse(persisted??priorAt??''))?{observedAt:new Date(persisted??priorAt).toISOString()}:{}),
    failureCode:'submission_outcome_unknown',submissionAttempted:true,
    retryable:false,recoveryEligible:true,inactiveProfile:true,
  };
  if (currentResolution&&!activeRecovery&&!Number.isFinite(Date.parse(persisted??''))) return null;
  if (Number.isFinite(historyBlockedAt)&&!inactivePending&&!Number.isFinite(Date.parse(persisted??''))) return {
    status:'needs_attention',reason:'OpenCD 历史提交仍未绑定可核验 Profile，先只读核验，禁止自动重放',
    observedAt:new Date(historyBlockedAt).toISOString(),failureCode:'submission_outcome_unknown',submissionAttempted:true,retryable:false,
  };
  const currentSuccessBinding=Boolean(profileBinding&&prior?.profileBinding===profileBinding);
  if (confirmedOpenCd(prior, now) &&
      (currentSuccessBinding||!Number.isFinite(Date.parse(persisted ?? ""))||pendingResolution||inactivePending&&!activeRecovery)) return null;
  if (!activeRecovery && (!uncertainOpenCd(prior) || resolvedPrior) &&
      (!Number.isFinite(Date.parse(persisted ?? "")) || inactivePending)) return null;
  const blockedAt = activeRecovery?.claimedAt ?? persisted ?? priorAt;
  return {
    status: "needs_attention",
    reason: "OpenCD 验证码提交结果不明，先核验今日签到记录",
    ...(Number.isFinite(Date.parse(blockedAt??''))?{observedAt:blockedAt}:{}),
    failureCode: "submission_outcome_unknown",
    submissionAttempted: true,
    retryable: false,
  };
}

export function openCdSubmissionState(previous, result, finishedAt) {
  if (result?.origin !== OPEN_CD_ORIGIN || String(result.accountKey ?? 'site-default') !== 'site-default') return previous ?? undefined;
  if (confirmedOpenCd(result, finishedAt)) return null;
  if (uncertainOpenCd(result)) return previous ?? finishedAt.toISOString();
  return previous ?? null;
}
