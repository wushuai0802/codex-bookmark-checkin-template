const HOUR = 3_600_000;
export function shanghaiDate(now = new Date().toISOString()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid reference time');
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function timestampFresh(value, now, maxAgeHours = 26) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const at = Date.parse(value), reference = Date.parse(now);
  return Number.isFinite(at) && Number.isFinite(reference)
    && Number.isFinite(maxAgeHours) && maxAgeHours > 0 && maxAgeHours <= 26
    && at <= reference + 60_000 && reference - at <= maxAgeHours * HOUR;
}

// Recompute at the decision boundary. A serialized `fresh: true` is not a lease.
export function healthIsFresh(health, now) {
  const maxAgeHours = Math.min(26, Number(health?.freshness?.maxAgeHours ?? 26));
  return health?.freshness?.fresh === true
    && timestampFresh(health?.sourceCheckedAt, now, maxAgeHours);
}

export function snapshotSafetyReasons(snapshot, now) {
  const reasons = [];
  if (snapshot?.reconciliation?.missingCount>0) reasons.push('planned_results_missing');
  if (snapshot?.reconciliation?.conflictCount>0) reasons.push('result_identity_conflict');
  if (snapshot?.reconciliation?.unexpectedCount>0) reasons.push('results_outside_current_plan');
  if (!healthIsFresh(snapshot?.health, now)) reasons.push('health_stale');
  if (snapshot?.health?.healthy !== true) reasons.push('health_unhealthy');
  if (!timestampFresh(snapshot?.generatedAt, now)) reasons.push('snapshot_stale');
  if (snapshot?.businessDate !== shanghaiDate(now)) reasons.push('business_date_not_current');
  return reasons;
}
