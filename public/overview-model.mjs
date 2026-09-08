export function overviewMetrics(data = {}, now = Date.now()) {
  const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
  const status = data.status ?? data.counts?.status ?? {};
  const total = count(data.counts?.executionUnits);
  const success = count(status.signed) + count(status.already_signed);
  const unavailable = count(status.not_available);
  const pending = Math.max(0, total - success - unavailable);
  const manual = count(status.needs_attention) + count(status.login_required) + count(status.failed);
  const age = now - Date.parse(data.generatedAt ?? '');
  const healthAge = now - Date.parse(data.health?.sourceCheckedAt ?? '');
  const fresh = Number.isFinite(age) && age >= -60_000 && age <= 26 * 3_600_000;
  const healthFresh = data.health?.freshness?.fresh === true && Number.isFinite(healthAge)
    && healthAge >= -60_000 && healthAge <= 26 * 3_600_000;
  return {
    total, success, unavailable, pending, manual,
    deferred: count(status.deferred),
    eligible: Math.max(0, total - unavailable),
    rate: total > unavailable ? Math.round(success / (total - unavailable) * 100) : null,
    fresh, healthFresh,
    healthy: data.health?.healthy === true && healthFresh,
    allResolved: data.source?.executionComplete === true && total > 0 && pending === 0,
    ageMinutes: Number.isFinite(age) ? Math.max(0, Math.floor(age / 60_000)) : null,
  };
}

export const statusColors = { signed: '#36c99b', already_signed: '#57b9f3', not_available: '#bbc6d4', needs_attention: '#ffc65c', deferred: '#b69cf6', login_required: '#ffac70', failed: '#ff7f93', unknown: '#91a4b7',not_started:'#91a4b7' };
export function statusGradient(status = {}) {
  const entries = Object.entries(status).filter(([, n]) => Number.isInteger(n) && n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '#e8edf3';
  let start = 0;
  return `conic-gradient(${entries.map(([key, n]) => {
    const end = start + n / total * 100;
    const segment = `${statusColors[key] ?? statusColors.unknown} ${start}% ${end}%`;
    start = end; return segment;
  }).join(',')})`;
}
