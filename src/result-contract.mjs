const AVAILABILITY_KINDS = new Set([
  "feature_disabled",
  "task_disabled",
  "temporary_unavailable",
]);

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const FEATURE_DISABLED_EVIDENCE = new Map([
  ["bmapi_checkin_status", new Set(["enabled_false"])],
  ["new_api_checkin_status", new Set(["message_not_enabled"])],
  ["new_api_checkin_action", new Set(["message_not_enabled"])],
]);

function validEvidenceTimestamp(value, now) {
  const timestamp = Date.parse(String(value ?? ""));
  const reference = now instanceof Date ? now.getTime() : Date.parse(String(now ?? ""));
  return Number.isFinite(timestamp)
    && Number.isFinite(reference)
    && timestamp <= reference + MAX_FUTURE_SKEW_MS;
}

function validFeatureDisabledEvidence(evidence) {
  const source = String(evidence?.source ?? "").trim();
  const originalSource = source === "cached_confirmation"
    ? String(evidence?.originalSource ?? "").trim()
    : source;
  const allowedOutcomes = FEATURE_DISABLED_EVIDENCE.get(originalSource);
  return Boolean(allowedOutcomes?.has(String(evidence?.outcome ?? "").trim()));
}

export function isConfirmedNotAvailable(result, now = new Date()) {
  if (result?.status !== "not_available") return false;
  const evidence = result.evidence;
  if (!AVAILABILITY_KINDS.has(result.availabilityKind)
    || evidence?.authoritative !== true
    || !validEvidenceTimestamp(evidence?.confirmedAt, now)) return false;

  if (result.availabilityKind === "task_disabled") {
    return result.disabledByConfig === true && evidence.source === "configuration";
  }
  if (result.availabilityKind === "temporary_unavailable") {
    return result.temporarilyUnavailable === true && evidence.source === "operator_confirmation";
  }
  return result.disabledByConfig !== true
    && result.temporarilyUnavailable !== true
    && validFeatureDisabledEvidence(evidence);
}

export function isTerminalResult(result) {
  return ["signed", "already_signed"].includes(result?.status)
    || isConfirmedNotAvailable(result);
}

export function normalizeResultContract(result) {
  if (result?.status !== "not_available" || isConfirmedNotAvailable(result)) return result;
  return {
    ...result,
    status: "unconfirmed",
    reason: "未开放签到结论缺少可审计证据，已安排重新确认",
    failureCode: "missing_not_available_evidence",
    invalidReportedStatus: "not_available",
  };
}
