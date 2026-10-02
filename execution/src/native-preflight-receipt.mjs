import { isConfirmedNotAvailable } from "./result-contract.mjs";

const MAX_REPORT_AGE_MS = 10 * 60 * 1000;
const successful = new Set(["signed", "already_signed"]);
const businessDay = (value) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
}).format(new Date(value));

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
export function currentNativePreflightResults(report, { allowedOrigins = [], now = new Date() } = {}) {
  const results = new Map();
  const reference = now.getTime();
  const generated = Date.parse(report?.generatedAt ?? "");
  if (!Array.isArray(report?.results)) return results;
  const allowed = new Set(allowedOrigins);
  if (!Number.isFinite(reference) || !Number.isFinite(generated)
    || generated > reference || reference - generated > MAX_REPORT_AGE_MS
    || businessDay(generated) !== businessDay(reference)) {
    // A rejected report cannot prove today's success, but losing a recorded
    // submission would let the caller turn an uncertain action into a retry.
    for (const result of report.results) {
      if (allowed.has(result?.origin) && result.submissionAttempted === true) {
        results.set(result.origin, unverifiedCompletion(result));
      }
    }
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
  return results;
}
