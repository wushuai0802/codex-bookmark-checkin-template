import { compatiblePriorResult, resultIdentity } from "./result-identity.mjs";
import { isTerminalResult } from "./result-contract.mjs";

export const RECOVERABLE_STATUSES = new Set([
  "error", "login_required", "interactive_challenge", "managed_challenge_timeout",
  "no_action", "deferred",
]);

// Credentials explicitly rejected by the site are operator-attention states,
// not transient browser failures. They must not be retried every hour.
export const ATTENTION_STATUSES = new Set(["needs_attention"]);

export const TERMINAL_STATUSES = new Set(["signed", "already_signed"]);

export function terminalResultReenabled(prior, target, config = {}) {
  if (prior?.status !== "not_available") return false;
  const origin = String(target?.origin ?? prior?.origin ?? "");
  const disabledOriginReenabled = prior.disabledByConfig === true
    && !(config.disabledCheckinOrigins ?? []).includes(origin);
  const cachedNoFeatureReenabled = prior.cached === true
    && !(config.knownNoCheckinFeatureOrigins ?? []).includes(origin);
  return disabledOriginReenabled || cachedNoFeatureReenabled;
}

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
      || isTerminalResult(result)) return result;
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

export function applyTemporaryUnavailableConfirmations(results, confirmedOrigins, now = new Date()) {
  const confirmed = confirmedOrigins instanceof Set ? confirmedOrigins : new Set(confirmedOrigins ?? []);
  const unavailableDate = localRunDate(now);
  const originCounts = new Map();
  for (const result of results ?? []) {
    originCounts.set(result?.origin, (originCounts.get(result?.origin) ?? 0) + 1);
  }
  return (results ?? []).map((result) => {
    if (!confirmed.has(result?.origin)
      || originCounts.get(result?.origin) !== 1
      || isTerminalResult(result)) return result;
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
      status: "not_available",
      reason: "用户确认站点维护或网络不可用，今日停止重试，明日自动恢复",
      temporarilyUnavailable: true,
      unavailableDate,
      operatorConfirmedUnavailable: true,
      availabilityKind: "temporary_unavailable",
      evidence: {
        source: "operator_confirmation",
        authoritative: true,
        confirmedAt: now.toISOString(),
      },
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

function normalizedGroupPart(value, fallback = "unknown") {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized || fallback;
}

function configuredShanghaiTime(names, fallback) {
  return [...names, fallback]
    .map((value) => String(value ?? ""))
    .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || fallback;
}

function nextSameDayShanghaiTime(time, now = new Date()) {
  const match = String(time ?? "").match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const parts = shanghaiParts(now);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const requestedMinutes = Number(match[1]) * 60 + Number(match[2]);
  return requestedMinutes > currentMinutes ? nextShanghaiTime(time, now) : null;
}

function nextUpstreamLateRetryAt(config = {}, now = new Date()) {
  return nextSameDayShanghaiTime(
    configuredShanghaiTime(
      [config.upstreamUnavailableLateRetryTime, config.rateLimitNextDayTime, config.schedule],
      "21:05",
    ),
    now,
  );
}

function oauthFailureCode(result) {
  if (String(result?.failureCode ?? "").startsWith("oauth_")) return String(result.failureCode);
  const history = Array.isArray(result?.recovery?.history) ? result.recovery.history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const code = String(history[index]?.login?.terminalLoginFailure ?? "");
    if (code.startsWith("oauth_")) return code;
  }
  return "";
}

function recoveryOAuthAccount(config, origin) {
  const accountKey = String(config.oauthRecoveryAccountBindings?.[origin] ?? "").trim();
  if (!accountKey) return null;
  for (const [configuredOrigin, identity] of Object.entries(config.oauthAccountIdentities ?? {})) {
    if (String(identity?.accountKey ?? "").trim() === accountKey) {
      return { ...identity, origin: new URL(configuredOrigin).origin };
    }
  }
  return (config.supplementalOAuthAccounts ?? []).find(
    (account) => String(account?.accountKey ?? "").trim() === accountKey,
  ) ?? null;
}

export function upstreamRetryGroup(result, config = {}) {
  if (result?.retryCause !== "upstream_unavailable") return null;
  const origin = new URL(String(result.origin)).origin;
  const explicit = String(result.retryGroup ?? config.upstreamFailureGroups?.[origin] ?? "").trim();
  if (explicit) return normalizedGroupPart(explicit);
  if (["oauth_upstream_unavailable", "oauth_upstream_circuit_open"].includes(oauthFailureCode(result))) {
    const recoveryAccount = recoveryOAuthAccount(config, origin);
    const provider = result.provider ?? config.automaticOAuthProviders?.[origin] ?? recoveryAccount?.provider;
    const upstream = result.upstreamProvider
      ?? config.oauthUpstreamProviders?.[origin]
      ?? recoveryAccount?.upstreamProvider;
    return `oauth:${normalizedGroupPart(provider)}:${normalizedGroupPart(upstream, "shared")}`;
  }
  return `origin:${origin}`;
}

export function applyUpstreamGroupCircuitBreakers(results, config = {}, now = new Date()) {
  const configuredLimit = Number(config.upstreamFailureGroupMaxDailyAttempts);
  const limit = Math.max(1, Math.min(12, Number.isFinite(configuredLimit) ? configuredLimit : 3));
  const groups = new Map();
  const annotated = (results ?? []).map((result) => {
    const retryGroup = upstreamRetryGroup(result, config);
    if (!retryGroup) return result;
    const value = { ...result, retryGroup };
    const attempts = Math.max(1, Number(value.retrySequence) || 1);
    groups.set(retryGroup, (groups.get(retryGroup) ?? 0) + attempts);
    return value;
  });
  const nextDayTime = [config.rateLimitNextDayTime, config.schedule, "08:05"]
    .map((value) => String(value ?? ""))
    .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || "08:05";
  return annotated.map((result) => {
    const attempts = result.retryGroup ? groups.get(result.retryGroup) ?? 0 : 0;
    if (!result.retryGroup || attempts < limit) return result;
    // Keep one bounded late-day recovery window.  This prevents a transient
    // OAuth/upstream outage in the morning from being postponed until the
    // next day, while retaining the daily circuit breaker.
    if (!result.lateRetryPending) {
      const lateRetryAt = nextUpstreamLateRetryAt(config, now);
      if (lateRetryAt) {
        return {
          ...result,
          retryGroupAttempts: attempts,
          lateRetryPending: true,
          retryExhaustedForDay: false,
          nextEligibleAt: lateRetryAt,
          reason: String(result.reason || "上游服务暂时不可用")
            .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
            .replace(/；?同一上游本日自动探测已达到上限，次日再检查$/, "")
            .concat("；上午探测达到上限，晚间再检查"),
        };
      }
    }
    return {
      ...result,
      retryGroupAttempts: attempts,
      upstreamCircuitOpen: true,
      retryExhaustedForDay: true,
      nextEligibleAt: nextShanghaiTimeNextDay(nextDayTime, now),
      reason: String(result.reason || "上游服务暂时不可用")
        .replace(/；?同一上游本日自动探测已达到上限，次日再检查$/, "")
        .concat("；同一上游本日自动探测已达到上限，次日再检查"),
    };
  });
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
  if (result.retryCause === "upstream_unavailable") {
    const maxDailyAttempts = Math.max(1, Math.min(6,
      Number(config.upstreamUnavailableMaxDailyAttempts) || 3));
    if (retrySequence >= maxDailyAttempts) {
      const lateRetryAt = previous?.lateRetryPending ? null : nextUpstreamLateRetryAt(config, now);
      if (lateRetryAt) {
        return {
          ...result,
          retrySequence,
          retrySequenceDate: currentDate,
          lateRetryPending: true,
          retryExhaustedForDay: false,
          nextEligibleAt: lateRetryAt,
          reason: String(result.reason || "站点维护或网络不可用")
            .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
            .concat("；上午探测达到上限，晚间再检查"),
        };
      }
      return {
        ...result,
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
        nextEligibleAt: nextShanghaiTimeNextDay(
          [config.rateLimitNextDayTime, config.schedule, "08:05"]
            .map((value) => String(value ?? ""))
            .find((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) || "08:05",
          now,
        ),
        reason: String(result.reason || "站点维护或网络不可用")
          .replace(/；?本日自动探测已达到上限，次日再检查$/, "")
          .concat("；本日自动探测已达到上限，次日再检查"),
      };
    }
    return {
      ...result,
      retrySequence,
      retrySequenceDate: currentDate,
      retryExhaustedForDay: false,
    };
  }
  if (result.retryCause === "login_required") {
    const maxDailyAttempts = Math.max(1, Math.min(4,
      Number(config.loginRetryMaxDailyAttempts) || 2));
    if (retrySequence >= maxDailyAttempts) {
      const {
        nextEligibleAt: _nextEligibleAt,
        retryExhaustedForDay: _retryExhaustedForDay,
        ...preserved
      } = result;
      return {
        ...preserved,
        status: "needs_attention",
        reason: String(result.reason || "自动登录恢复未成功")
          .replace(/；?已安排低频重试$/, "")
          .concat("；本日自动恢复已达到上限，不再盲目重试"),
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
      };
    }
    return { ...result, retrySequence, retrySequenceDate: currentDate };
  }
  if (result.retryCause === "managed_challenge_timeout") {
    const maxDailyAttempts = Math.max(1, Math.min(4,
      Number(config.challengeRetryMaxDailyAttempts) || 2));
    if (retrySequence >= maxDailyAttempts) {
      const {
        nextEligibleAt: _nextEligibleAt,
        retryExhaustedForDay: _retryExhaustedForDay,
        ...preserved
      } = result;
      return {
        ...preserved,
        status: "needs_attention",
        reason: String(result.reason || "安全验证未自动通过")
          .replace(/；?已安排低频重试$/, "")
          .concat("；本日安全验证复测已达到上限，不再重复打开站点"),
        retrySequence,
        retrySequenceDate: currentDate,
        retryExhaustedForDay: true,
      };
    }
    return {
      ...result,
      retrySequence,
      retrySequenceDate: currentDate,
      retryExhaustedForDay: false,
    };
  }
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
  const advanced = (results ?? []).map((result) => attempted.has(resultIdentity(result))
    ? advanceDeferredRetry(result, compatiblePriorResult(result, previousResults ?? []), config, now)
    : result);
  return applyUpstreamGroupCircuitBreakers(advanced, config, now);
}

export function deferUnresolvedLogin(result, config = {}, now = new Date()) {
  if (result?.status !== "login_required") return result;
  if (result.retryableLoginRecovery === false) {
    return {
      ...result,
      status: "needs_attention",
      retryCause: result.retryCause ?? "login_required",
    };
  }
  const oauthFailure = String(result.failureCode ?? "");
  const retryCause = oauthFailure === "oauth_upstream_unavailable"
    ? "upstream_unavailable"
    : oauthFailure === "oauth_rate_limited"
      ? "rate_limit"
      : "login_required";
  const reason = String(result.reason || "自动登录恢复未成功")
    .replace(/；?已安排低频重试$/, "");
  return withRetrySchedule({
    ...result,
    status: "deferred",
    retryCause,
    reason: `${reason}；已安排低频重试`,
  }, {
    deferredRetryDelayMs: retryCause === "login_required"
      ? config.loginRetryDelayMs ?? config.deferredRetryDelayMs
      : config.deferredRetryDelayMs,
    rateLimitRetryDelayMs: config.rateLimitRetryDelayMs,
  }, now);
}

export function isRetryEligible(result, now = new Date()) {
  if (result?.retryable === false || result?.submissionAttempted === true) return false;
  if (result?.status === "not_available" && !isTerminalResult(result)) return true;
  if (!RECOVERABLE_STATUSES.has(result?.status)) return false;
  if (result.status !== "deferred") return true;
  const next = Date.parse(result.nextEligibleAt ?? "");
  return !Number.isFinite(next) || next <= now.getTime();
}

export function resumeSelectedOrigins(currentTargets, previousResults, config = {}, now = new Date()) {
  const currentOrigins = new Set((currentTargets ?? []).map((target) => target.origin));
  const previousOrigins = new Set((previousResults ?? []).map((result) => result.origin));
  const currentDate = localRunDate(now);
  return new Set([
    ...(previousResults ?? []).filter((result) => isRetryEligible(result, now)).map((result) => result.origin),
    ...(previousResults ?? []).filter((result) => result?.temporarilyUnavailable === true
      && String(result.unavailableDate || "") !== currentDate).map((result) => result.origin),
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
