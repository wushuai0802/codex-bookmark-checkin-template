import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { atomicWriteJson } from "./security.mjs";
import { isConfirmedNotAvailable } from "./result-contract.mjs";
import { confirmedOpenCd, openCdSubmissionState, quotaClaimState } from "./quota-claim-guard.mjs";

const SUCCESSFUL = new Set(["signed", "already_signed"]);
const dayAt=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(value));

function openCdAuditState(prior,result,finishedAt){
  if(result.origin!=='https://open.cd'||String(result.accountKey??'site-default')!=='site-default')return {};
  const binding=result.profileBinding,validBinding=/^[a-f0-9]{64}$/.test(binding??'');
  const recovery=(prior.openCdRecoveryAttempts??[]).find(item=>item.claimId===result.ptRecovery?.claimId&&
    item.accountKey==='site-default'&&item.profileBinding===binding&&item.businessDate===dayAt(finishedAt));
  const confirmed=confirmedOpenCd(result,finishedAt)&&validBinding;
  // A current success without the durable recovery claim is independent of an
  // older unresolved write intent. Keep that intent blocked and auditable.
  const pendingAtTime=Date.parse(prior.pendingOpenCdAt??'');
  const sameDayPending=Number.isFinite(pendingAtTime)&&
    dayAt(pendingAtTime)===result.evidence?.businessDate&&
    prior.pendingOpenCdAccountKey==='site-default'&&
    /^[a-f0-9]{64}$/.test(prior.pendingOpenCdProfileBinding??'')&&
    prior.pendingOpenCdProfileBinding===binding;
  const confirmedAt=Date.parse(result.evidence?.confirmedAt??'');
  const recoveryTimes=recovery?[Date.parse(recovery.claimedAt??''),Date.parse(recovery.proofConfirmedAt??'')]:[];
  const recoveryMalformed=Boolean(recovery)&&recoveryTimes.some(value=>!Number.isFinite(value));
  const recoveryTime=recovery?Math.max(...recoveryTimes):-Infinity;
  const recoveryProofIsNewer=!recovery||!recoveryMalformed&&Number.isFinite(confirmedAt)&&confirmedAt>=recoveryTime;
  const pendingProofIsNewer=!sameDayPending||Number.isFinite(confirmedAt)&&confirmedAt>=pendingAtTime;
  const resolvesCurrentRecovery=confirmed&&(
    recoveryProofIsNewer&&Boolean(recovery)&&result.ptRecovery?.claimId===recovery.claimId&&recovery.businessDate===result.evidence.businessDate
    || recoveryProofIsNewer&&pendingProofIsNewer&&sameDayPending);
  const uncertain=result.failureCode==='submission_outcome_unknown'&&result.submissionAttempted===true;
  const pendingAt=recovery&&uncertain?finishedAt.toISOString():openCdSubmissionState(prior.pendingOpenCdAt,result,finishedAt);
  const next={pendingOpenCdAt:resolvesCurrentRecovery?null:
    confirmed&&prior.pendingOpenCdAt?prior.pendingOpenCdAt:
    confirmedOpenCd(result,finishedAt)&&prior.pendingOpenCdAt&&!validBinding?prior.pendingOpenCdAt:pendingAt};
  const previousPendingAt=prior.pendingOpenCdAt;
  if (previousPendingAt && next.pendingOpenCdAt !== previousPendingAt) {
    const history=prior.openCdPendingHistory??[];
    const entry={pendingAt:previousPendingAt,accountKey:'site-default',
      profileBinding:prior.pendingOpenCdProfileBinding??null,originalOutcome:'unknown',
      supersededAt:finishedAt.toISOString(),status:'superseded_by_new_attempt'};
    next.openCdPendingHistory=history.some(item=>item.pendingAt===entry.pendingAt&&
      item.profileBinding===entry.profileBinding)?history:[...history,entry];
  }
  if(uncertain&&validBinding&&(recovery||!Number.isFinite(Date.parse(prior.pendingOpenCdAt??'')))){
    next.pendingOpenCdProfileBinding=binding;next.pendingOpenCdAccountKey='site-default';
  }
  if(resolvesCurrentRecovery){
    next.pendingOpenCdProfileBinding=null;next.pendingOpenCdAccountKey=null;
    if(Number.isFinite(Date.parse(prior.pendingOpenCdAt??''))){
      const resolution={kind:'current_day_confirmed',origin:result.origin,accountKey:'site-default',profileBinding:binding,
        pendingAt:prior.pendingOpenCdAt,originalOutcome:'unknown',
        businessDate:result.evidence.businessDate,originalBusinessDate:dayAt(recovery?.originalPendingAt??prior.pendingOpenCdAt),
        confirmedAt:result.evidence.confirmedAt,
        resolvedAt:finishedAt.toISOString(),...(recovery?{recoveryClaimId:recovery.claimId}:{}),
        evidence:{source:result.evidence.source,authoritative:true,businessDate:result.evidence.businessDate,
          confirmedAt:result.evidence.confirmedAt,...(result.evidence.statusSignal?{statusSignal:result.evidence.statusSignal}:{})}};
      resolution.resolutionId=crypto.createHash('sha256').update(JSON.stringify([result.origin,binding,resolution.pendingAt,
        resolution.businessDate,resolution.kind])).digest('hex');
      const audits=prior.openCdSubmissionResolutions??[];
      next.openCdSubmissionResolutions=audits.some(item=>item.resolutionId===resolution.resolutionId)?audits:[...audits,resolution];
      const linkedPendingAt=recovery?.originalPendingAt??previousPendingAt;
      const resolvedPendingAts=new Set([linkedPendingAt,previousPendingAt].filter(Boolean));
      if(linkedPendingAt)next.openCdPendingHistory=(next.openCdPendingHistory??[]).map(item=>
        resolvedPendingAts.has(item.pendingAt)&&item.status!=='historical_confirmed'?
          {...item,status:'resolved_current_day',resolutionId:resolution.resolutionId}:item);
    }
  }
  if(confirmed&&previousPendingAt&&!prior.pendingOpenCdProfileBinding&&!resolvesCurrentRecovery){
    const resolution={kind:'pending_manual_binding',origin:result.origin,accountKey:'site-default',
      profileBinding:binding,pendingAt:previousPendingAt,originalBusinessDate:dayAt(previousPendingAt),
      originalOutcome:'unknown',businessDate:result.evidence.businessDate,confirmedAt:result.evidence.confirmedAt,
      resolvedAt:finishedAt.toISOString(),status:'unknown',
      evidence:{source:result.evidence.source,authoritative:true,businessDate:result.evidence.businessDate,
        confirmedAt:result.evidence.confirmedAt,statusSignal:result.evidence.statusSignal}};
    resolution.resolutionId=crypto.createHash('sha256').update(JSON.stringify([result.origin,binding,previousPendingAt,
      result.evidence.businessDate,resolution.kind])).digest('hex');
    const audits=prior.openCdSubmissionResolutions??[];
    next.openCdSubmissionResolutions=audits.some(item=>item.resolutionId===resolution.resolutionId)?audits:[...audits,resolution];
  }
  if(recovery||confirmed&&(prior.openCdRecoveryAttempts??[]).length)next.openCdRecoveryAttempts=prior.openCdRecoveryAttempts.map(item=>{
    if(resolvesCurrentRecovery&&item.accountKey==='site-default'&&item.profileBinding===binding&&
      Date.parse(item.claimedAt)<=Date.parse(result.evidence.confirmedAt)&&['claimed','outcome_unknown'].includes(item.state))
      return {...item,state:item.businessDate===result.evidence.businessDate?'confirmed_current_day':'superseded_for_current_binding',
        finishedAt:finishedAt.toISOString(),confirmedAt:result.evidence.confirmedAt,resolutionBusinessDate:result.evidence.businessDate};
    return item.claimId===recovery?.claimId?{...item,state:uncertain?'outcome_unknown':result.submissionAttempted===false?'not_submitted':'claimed',
      finishedAt:finishedAt.toISOString()}:item;
  });
  return next;
}

export async function loadSiteState(filePath) {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!value || typeof value !== "object" || typeof value.sites !== "object") throw new Error("invalid state");
    return value;
  } catch {
    return { version: 1, updatedAt: null, sites: {} };
  }
}

export function applyPreferredCandidates(targets, state) {
  return targets.map((target) => {
    const preferredUrl = state?.sites?.[target.origin]?.preferredUrl;
    if (!preferredUrl) return target;
    try {
      const preferred = new URL(preferredUrl);
      const allowedOrigins = new Set(target.allowedOrigins ?? [target.origin]);
      if (!/^https?:$/.test(preferred.protocol) || !allowedOrigins.has(preferred.origin)) return target;
      return {
        ...target,
        candidates: [preferred.href, ...target.candidates.filter((candidate) => candidate !== preferred.href)],
      };
    } catch {
      return target;
    }
  });
}

export function reuseRecentNotAvailable(target, state, config = {}, now = new Date()) {
  if (!(config.knownNoCheckinFeatureOrigins ?? []).includes(target.origin)) return null;
  const prior = state?.sites?.[target.origin];
  const stateConfirmedAt = Date.parse(prior?.lastConfirmedAt ?? "");
  const evidenceConfirmedAt = Date.parse(prior?.lastConfirmedEvidence?.confirmedAt ?? "");
  const nowTimestamp = now.getTime();
  if (!Number.isFinite(stateConfirmedAt)
    || !Number.isFinite(evidenceConfirmedAt)
    || stateConfirmedAt > nowTimestamp + 5 * 60 * 1000
    || evidenceConfirmedAt > stateConfirmedAt + 5 * 60 * 1000
    || !isConfirmedNotAvailable({
      status: prior?.lastConfirmedStatus,
      availabilityKind: prior?.lastAvailabilityKind,
      evidence: prior?.lastConfirmedEvidence,
    }, now)) return null;

  const configuredHours = Number(config.knownNoCheckinRecheckHours);
  const recheckHours = Math.max(24, Math.min(24 * 30,
    Number.isFinite(configuredHours) ? configuredHours : 24 * 7));
  if (nowTimestamp - evidenceConfirmedAt >= recheckHours * 60 * 60 * 1000) return null;

  return {
    status: "not_available",
    reason: `近期已确认未开放签到，按 ${recheckHours} 小时周期复核`,
    cached: true,
    attempt: 0,
    availabilityKind: "feature_disabled",
    evidence: {
      source: "cached_confirmation",
      originalSource: String(prior.lastConfirmedEvidence.source),
      outcome: String(prior.lastConfirmedEvidence.outcome),
      authoritative: true,
      confirmedAt: new Date(evidenceConfirmedAt).toISOString(),
    },
  };
}

export async function runWithRecentNotAvailableCache(target, state, config, run, now = new Date()) {
  const cached = reuseRecentNotAvailable(target, state, config, now);
  return cached ?? run();
}

function reusablePreferredUrl(result) {
  if (!SUCCESSFUL.has(result.status) || !result.url) return null;
  try {
    const url = new URL(result.url);
    if (!/^https?:$/.test(url.protocol) || url.search || url.hash) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function updateSiteState(previous, results, finishedAt = new Date(), config = {}) {
  const sites = { ...(previous?.sites ?? {}) };
  const timestamp = finishedAt.toISOString();
  for (const result of results) {
    const prior = sites[result.origin] ?? {};
    const runCount = Number(prior.runCount ?? 0) + 1;
    const durationMs = Math.max(0, Number(result.durationMs) || 0);
    const priorAverage = Math.max(0, Number(prior.averageDurationMs) || 0);
    const averageDurationMs = Math.round(((priorAverage * (runCount - 1)) + durationMs) / runCount);
    const confirmed = SUCCESSFUL.has(result.status) || isConfirmedNotAvailable(result);
    const successful = SUCCESSFUL.has(result.status);
    const cachedConfirmation = result.status === "not_available" && result.cached === true;
    const shouldRefreshConfirmation = confirmed && !cachedConfirmation;
    const preferredUrl = reusablePreferredUrl(result) ?? prior.preferredUrl ?? null;
    const pendingQuotaClaimAt = quotaClaimState(prior.pendingQuotaClaimAt, result, finishedAt, config);
    const openCdState = openCdAuditState(prior,result,finishedAt);
    sites[result.origin] = {
      ...prior,
      lastStatus: result.status,
      lastReason: String(result.reason ?? "").slice(0, 240),
      lastRunAt: timestamp,
      lastConfirmedAt: shouldRefreshConfirmation ? timestamp : (prior.lastConfirmedAt ?? null),
      lastConfirmedStatus: shouldRefreshConfirmation ? result.status : (prior.lastConfirmedStatus ?? null),
      lastConfirmedReason: shouldRefreshConfirmation
        ? String(result.reason ?? "").slice(0, 240)
        : (prior.lastConfirmedReason ?? null),
      lastAvailabilityKind: shouldRefreshConfirmation && result.status === "not_available"
        ? result.availabilityKind
        : (prior.lastAvailabilityKind ?? null),
      lastConfirmedEvidence: shouldRefreshConfirmation && result.status === "not_available"
        ? {
          source: String(result.evidence.source).slice(0, 80),
          outcome: String(result.evidence.outcome ?? "").slice(0, 80),
          authoritative: true,
          confirmedAt: String(result.evidence.confirmedAt),
        }
        : (prior.lastConfirmedEvidence ?? null),
      lastSuccessAt: successful ? timestamp : (prior.lastSuccessAt ?? null),
      failureStreak: confirmed ? 0 : Number(prior.failureStreak ?? 0) + 1,
      runCount,
      confirmedCount: Number(prior.confirmedCount ?? 0) + (shouldRefreshConfirmation ? 1 : 0),
      averageDurationMs,
      lastDurationMs: durationMs,
      preferredUrl,
      ...(pendingQuotaClaimAt === undefined ? {} : { pendingQuotaClaimAt }),
      ...openCdState,
    };
  }
  return { version: 1, updatedAt: timestamp, sites };
}

export async function writeSiteState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, state);
}
