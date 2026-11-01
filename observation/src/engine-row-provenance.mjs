// Values forwarded by native-preflight-result.mjs from the native PS producers.
export const NATIVE_DIAGNOSTIC_STAGES = Object.freeze([
  'launch', 'window_discovery', 'page_readback', 'attendance_error_page',
  'native_child_transport', 'native_child_decode', 'child_result',
]);

export function normalizeFactTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return null;
  const at = Date.parse(value);
  // Date.parse normalizes dates such as February 30; they are not valid facts.
  const date = new Date(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(at) || date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  return new Date(at).toISOString();
}

export function engineRowProvenance(result, sourceFinishedAt) {
  const observed = normalizeFactTimestamp(result.observedAt);
  const evidenceAt = [result.evidence?.createdAt, result.evidence?.confirmedAt,
    result.confirmedAt, result.lastConfirmedAt].map(normalizeFactTimestamp).find(Boolean);
  // The executor fills missing observedAt with the report's finishedAt. That
  // value alone cannot date the row's fact. Retain older row observations (in
  // particular pending-claim times); otherwise require an independent receipt.
  // Legacy report completion times accept Date.parse's formats. Compare the
  // instant, even when finishedAt itself is not in the row's strict ISO format.
  const factObservedAt = observed && Date.parse(observed) !== Date.parse(sourceFinishedAt)
    ? observed : evidenceAt;
  return {
    ...(factObservedAt ? {factObservedAt} : {}),
    ...(result.nativeGate === true ? {nativeGate: true} : {}),
    ...(NATIVE_DIAGNOSTIC_STAGES.includes(result.diagnosticStage) ? {diagnosticStage: result.diagnosticStage} : {}),
    ...(result.postActionReadbackAttempted === true ? {postActionReadbackAttempted: true} : {}),
  };
}
