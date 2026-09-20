export const PAUSE_HOURS = [24, 72, 168];

export function pauseExpiresAt(policy, requestedHours, now = Date.now()) {
  if (policy !== 'pause') return null;
  const hours = requestedHours == null ? 24 : Number(requestedHours);
  if (!PAUSE_HOURS.includes(hours)) throw Error('pauseHours must be 24, 72, or 168');
  return new Date(now + hours * 60 * 60 * 1000).toISOString();
}

export function activeSiteControls(sites, now = Date.now()) {
  const active = {};
  for (const [origin, raw] of Object.entries(sites ?? {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const expires = Date.parse(raw.expiresAt);
    const paused = raw.policy === 'pause' && Number.isFinite(expires) && expires > now;
    active[origin] = {
      policy: paused ? 'pause' : raw.policy === 'review' ? 'review' : 'monitor',
      note: typeof raw.note === 'string' ? raw.note.slice(0, 240) : '',
      updatedAt: raw.updatedAt ?? null,
      expiresAt: paused ? new Date(expires).toISOString() : null,
    };
  }
  return active;
}
