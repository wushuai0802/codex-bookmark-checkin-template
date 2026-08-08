import { compatiblePriorResult, resultIdentity } from "./result-identity.mjs";

export const RECOVERABLE_STATUSES = new Set([
  "error", "login_required", "interactive_challenge", "managed_challenge_timeout",
  "visited", "clicked", "no_action", "unconfirmed", "deferred",
]);

export const TERMINAL_STATUSES = new Set(["signed", "already_signed", "not_available"]);

export function applyManualConfirmations(results, confirmedOrigins, now = new Date()) {
  const confirmed = confirmedOrigins instanceof Set ? confirmedOrigins : new Set(confirmedOrigins ?? []);
  const confirmedAt = now.toISOString();
  const originCounts = new Map();
  for (const result of results ?? []) {
    originCounts.set(result?.origin, (originCounts.get(result?.origin) ?? 0) + 1);
  }
  return (results ?? []).map((result) => {
    if (!confirmed.has(result?.origin)
      || originCounts.get(result?.origin) !== 1
      || TERMINAL_STATUSES.has(result?.status)) return result;
    const {
      retryCause: _retryCause,
      nextEligibleAt: _nextEligibleAt,
      retrySequence: _retrySequence,
      retrySequenceDate: _retrySequenceDate,
      retryExhaustedForDay: _retryExhaustedForDay,
      ...preserved
    } = result;
    return {
      ...preserved,
      status: "already_signed",
      reason: "用户已确认手动完成",
      manualConfirmation: true,
      manualConfirmedAt: confirmedAt,
    };
  });
}

function shanghaiParts(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((value, part) => {
    if (part.type !== "literal") value[part.type] = part.value;
    return value;
  }, {});
}

export function localRunDate(date = new Date()) {
  const parts = shanghaiParts(date);
  return `${parts.year}${parts.month}${parts.day}`;
}

export function isCurrentLocalRunId(runId, date = new Date()) {
  return String(runId ?? "").startsWith(`${localRunDate(date)}-`);
}

export function nextShanghaiTime(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  const dayOffset = requestedMinutes <= currentMinutes ? 1 : 0;
  const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset);
  return new Date(utcMidnight - 8 * 60 * 60 * 1000 + requestedMinutes * 60 * 1000).toISOString();
}

export function nextShanghaiTimeNextDay(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  const utcMidnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + 1);
  return new Date(utcMidnight - 8 * 60 * 60 * 1000 + requestedMinutes * 60 * 1000).toISOString();
}

export function withRetrySchedule(result, config = {}, now = new Date()) {
  if (result?.status !== "deferred") return result;
  const existing = Date.parse(result.nextEligibleAt ?? "");
  if (Number.isFinite(existing)) return result;
  const requestedTime = String(result.reason ?? "").match(/(?:要求|需在)\s*([0-2]\d:[0-5]\d)\s*后/)?.[1];
  const configuredDelay = Number(
    result.retryCause === "rate_limit"
      ? (config.rateLimitRetryDelayMs ?? config.deferredRetryDelayMs)
      : result.retryCause === "managed_challenge_timeout"
        ? (config.challengeRetryDelayMs ?? config.deferredRetryDelayMs)
        : config.deferredRetryDelayMs,
  );
  const delayMs = Math.max(60_000, Math.min(6 * 60 * 60 * 1000,
    Number.isFinite(configuredDelay) ? configuredDelay : 30 * 60 * 1000));
  return {
    ...result,
    nextEligibleAt: (requestedTime ? nextShanghaiTime(requestedTime, now) : null)
      ?? new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function advanceDeferredRetry(result, previous, config = {}, now = new Date()) {
  if (result?.status !== "deferred") return result;
  const sameCause = previous?.status === "deferred"
    && String(previous.retryCause || "") === String(result.retryCause || "");
  const currentDate = localRunDate(now);
  const sameDate = String(previous?.retrySequenceDate || "") === currentDate;
  const previousSequence = Math.max(0, Number(previous?.retrySequence) || (sameCause && sameDate ? 1 : 0));
  const retrySequence = sameCause && sameDate ? previousSequence + 1 : 1;
  if (result.retryCause !== "rate_limit") return { ...result, retrySequence, retrySequenceDate: currentDate };

  const baseDelay = Math.max(60_000, Number(config.rateLimitRetryDelayMs) || 60 * 60 * 1000);
  const maxDelay = Math.max(baseDelay, Number(config.rateLimitMaxDelayMs) || 6 * 60 * 60 * 1000);
  const maxDailyAttempts = Math.max(1, Math.min(6, Number(config.rateLimitMaxDailyAttempts) || 3));
  if (retrySequence >= maxDailyAttempts) {
    const nextDayTime = [config.rateLimitNextDayTime, config.schedule, "08:05"]
      .map((value) => String(value ?? ""))
      .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || "08:05";
    return {
      ...result,
      retrySequence,
      retrySequenceDate: currentDate,
      retryExhaustedForDay: true,
      nextEligibleAt: nextShanghaiTimeNextDay(nextDayTime, now),
    };
  }
  const delayMs = Math.min(maxDelay, baseDelay * (2 ** (retrySequence - 1)));
  return {
    ...result,
    retrySequence,
    retrySequenceDate: currentDate,
    retryExhaustedForDay: false,
    nextEligibleAt: new Date(now.getTime() + delayMs).toISOString(),
  };
}

export function advanceAttemptedDeferredRetries(results, attemptedOrigins, previousResults, config = {}, now = new Date()) {
  const attempted = attemptedOrigins instanceof Set ? attemptedOrigins : new Set(attemptedOrigins ?? []);
  return (results ?? []).map((result) => attempted.has(resultIdentity(result))
    ? advanceDeferredRetry(result, compatiblePriorResult(result, previousResults ?? []), config, now)
    : result);
}

export function deferUnresolvedLogin(result, config = {}, now = new Date()) {
  if (result?.status !== "login_required") return result;
  return withRetrySchedule({
    ...result,
    status: "deferred",
    retryCause: "login_required",
    reason: "自动登录恢复未成功，已安排低频重试",
  }, {
    deferredRetryDelayMs: config.loginRetryDelayMs ?? config.deferredRetryDelayMs,
  }, now);
}

export function isRetryEligible(result, now = new Date()) {
  if (!RECOVERABLE_STATUSES.has(result?.status)) return false;
  if (result.status !== "deferred") return true;
  const next = Date.parse(result.nextEligibleAt ?? "");
  return !Number.isFinite(next) || next <= now.getTime();
}

export function resumeSelectedOrigins(currentTargets, previousResults, config = {}, now = new Date()) {
  const currentOrigins = new Set((currentTargets ?? []).map((target) => target.origin));
  const previousOrigins = new Set((previousResults ?? []).map((result) => result.origin));
  return new Set([
    ...(previousResults ?? []).filter((result) => isRetryEligible(result, now)).map((result) => result.origin),
    ...[...currentOrigins].filter((origin) => !previousOrigins.has(origin)),
    ...(config.disabledCheckinOrigins ?? []).filter((origin) => currentOrigins.has(origin)),
  ]);
}

export function nextDeferredRetryAt(results, now = new Date()) {
  const values = (results ?? []).filter((result) => result?.status === "deferred")
    .map((result) => Date.parse(result.nextEligibleAt ?? ""))
    .filter((value) => Number.isFinite(value) && value > now.getTime());
  return values.length > 0 ? new Date(Math.min(...values)).toISOString() : null;
}
