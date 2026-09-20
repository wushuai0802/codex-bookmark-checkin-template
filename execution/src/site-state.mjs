import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./security.mjs";
import { isConfirmedNotAvailable } from "./result-contract.mjs";

const SUCCESSFUL = new Set(["signed", "already_signed"]);

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

export function updateSiteState(previous, results, finishedAt = new Date()) {
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
    };
  }
  return { version: 1, updatedAt: timestamp, sites };
}

export async function writeSiteState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWriteJson(filePath, state);
}
