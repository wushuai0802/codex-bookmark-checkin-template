import { isConfirmedNotAvailable } from "./result-contract.mjs";

const MAX_REPORT_AGE_MS = 10 * 60 * 1000;
const successful = new Set(["signed", "already_signed"]);
const businessDay = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
}).format(new Date(value));
const profileBindingPattern = /^[a-f0-9]{64}$/i;

function expectedProfileBinding(profileBindings, origin) {
  if (profileBindings instanceof Map) return profileBindings.get(origin) ?? null;
  if (profileBindings && typeof profileBindings === "object") return profileBindings[origin] ?? null;
  return null;
}

function currentJournalCompletion(attempt, { allowed, profileBindings, day, now }) {
  const origin = typeof attempt?.origin === "string" ? attempt.origin : "";
  if (!allowed.has(origin) || attempt?.accountKey !== "site-default" || attempt?.state !== "confirmed"
    || !successful.has(attempt?.status)) return null;
  const expected = expectedProfileBinding(profileBindings, origin);
  const profileBinding = String(attempt?.profileBinding ?? "");
  // A journal receipt is only useful when the current native preflight knows
  // which profile it is about.  Without this exact binding, an old account's
  // success could incorrectly close another site/account's unknown outcome.
  if (!profileBindingPattern.test(profileBinding) || !profileBindingPattern.test(String(expected ?? ""))
    || profileBinding !== String(expected)) return null;
  const evidence = attempt?.evidence;
  const confirmed = Date.parse(evidence?.confirmedAt ?? attempt?.confirmedAt ?? "");
  if (evidence?.source !== "page_text" || evidence?.authoritative !== true
    || !Number.isFinite(confirmed) || confirmed > now.getTime() + 60_000
    || businessDay(confirmed) !== day || evidence?.businessDate !== day) return null;
  return {
    origin,
    accountKey: "site-default",
    profileBinding,
    status: attempt.status,
    submissionAttempted: false,
    observedAt: attempt.observedAt ?? attempt.finishedAt ?? evidence.confirmedAt,
    confirmedAt: evidence.confirmedAt,
    evidence: {
      ...evidence,
      confirmedAt: new Date(confirmed).toISOString(),
      businessDate: day,
      authoritative: true,
      source: "page_text",
    },
    reason: "原生执行日志已确认今日完成，无需重复提交",
  };
}

function mergeNativeJournalResults(results, journal, { allowed, profileBindings, day, now }) {
  if (!Array.isArray(journal?.attempts)) return;
  const latest = new Map();
  for (const attempt of journal.attempts) {
    const receipt = currentJournalCompletion(attempt, { allowed, profileBindings, day, now });
    if (!receipt) continue;
    const previous = latest.get(receipt.origin);
    const at = Date.parse(receipt.evidence.confirmedAt);
    if (!previous || at > Date.parse(previous.evidence.confirmedAt)) latest.set(receipt.origin, receipt);
  }
  for (const [origin, receipt] of latest) {
    // A durable same-day journal confirmation is stronger than an older
    // preflight diagnostic (including submission_unknown), but never replaces
    // a newer authoritative result from the current report.
    const existing = results.get(origin);
    const existingAt = Date.parse(existing?.evidence?.confirmedAt ?? "");
    const receiptAt = Date.parse(receipt.evidence.confirmedAt);
    if (!existing || !Number.isFinite(existingAt) || receiptAt >= existingAt
      || existing.evidence?.authoritative !== true) results.set(origin, receipt);
  }
}

// Results have already passed currentNativePreflightResults. A successful
// readback may repair an earlier lost response even when replay is disabled.
// Origin-scoped native receipts must never resolve another OAuth account.
export function completedNativeRecovery(target, prior, results) {
  if (!prior || successful.has(prior.status)
    || (target?.accountKey && target.accountKey !== 'site-default')) return null;
  const receipt = results.get(target.origin);
  if (!successful.has(receipt?.status) || receipt.evidence?.authoritative !== true) return null;
  // Journal-backed receipts carry the profile binding. Never let a success
  // from another native Chrome profile close this account's unknown result.
  if (receipt.profileBinding && receipt.profileBinding !== target?.profileBinding) return null;
  return receipt;
}

function unverifiedCompletion(result) {
  const submitted = result.submissionAttempted === true;
  return {
    ...result,
    status: submitted ? "needs_attention" : "unconfirmed",
    reason: "原生预热回执缺少有效的当日签到证据，先只读复核",
    failureCode: submitted ? "submission_outcome_unknown" : "authoritative_status_unavailable",
    evidence: { ...result.evidence, authoritative: false },
    ...(submitted ? { retryable: false } : {}),
  };
}

// Native preparation runs before the executor starts. A recently produced
// report can therefore contain yesterday's completion when it crosses midnight.
export function currentNativePreflightResults(report, {
  allowedOrigins = [], now = new Date(), journal = null, profileBindings = null,
} = {}) {
  const results = new Map();
  const reference = now.getTime();
  const generated = Date.parse(report?.generatedAt ?? "");
  const allowed = new Set(allowedOrigins);
  const reportResults = Array.isArray(report?.results) ? report.results : [];
  const reportCurrent = Number.isFinite(reference) && Number.isFinite(generated)
    && generated <= reference && reference - generated <= MAX_REPORT_AGE_MS
    && businessDay(generated) === businessDay(reference);
  if (!reportCurrent) {
    // A rejected report cannot prove today's success, but losing a recorded
    // submission would let the caller turn an uncertain action into a retry.
    for (const result of reportResults) {
      if (allowed.has(result?.origin) && result.submissionAttempted === true) {
        results.set(result.origin, unverifiedCompletion(result));
      }
    }
    mergeNativeJournalResults(results, journal, {
      allowed, profileBindings, day: businessDay(reference), now,
    });
    return results;
  }

  const day = businessDay(reference);
  for (const result of report.results) {
    if (!allowed.has(result?.origin)) continue;
    if (successful.has(result.status)) {
      const confirmed = Date.parse(result.evidence?.confirmedAt ?? "");
      const confirmedToday = result.evidence?.authoritative === true
        && Number.isFinite(confirmed) && confirmed <= generated
        && businessDay(confirmed) === day && result.evidence.businessDate === day;
      results.set(result.origin, confirmedToday ? result : unverifiedCompletion(result));
    } else if (result.status === "not_available") {
      // Feature availability and explicit configuration opt-outs are not daily
      // reward receipts. Retain their established cache/confirmation contract.
      if (isConfirmedNotAvailable(result, now)) results.set(result.origin, result);
    } else {
      results.set(result.origin, result);
    }
  }
  mergeNativeJournalResults(results, journal, {
    allowed, profileBindings, day: businessDay(reference), now,
  });
  return results;
}
