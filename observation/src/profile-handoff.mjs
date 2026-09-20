import fs from 'node:fs';
import path from 'node:path';

function required(value, name) { if (typeof value !== 'string' || !value.trim()) throw Error(`${name} is required`); return value.trim(); }

// Build a handoff record without changing V1. The caller must disable/drain
// the matching V1 task before this record is accepted by a worker.
export function prepareV1ProfileHandoff({v1Root, profileDir, accountKey, origin, now = new Date().toISOString()} = {}) {
  const root = path.resolve(required(v1Root, 'v1Root'));
  const profile = path.resolve(required(profileDir, 'profileDir'));
  const relative = path.relative(path.join(root, 'data'), profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('V1 profile must be inside V1 data root');
  if (!fs.existsSync(profile)) throw Error('V1 profile does not exist');
  const lockFile = path.join(root, 'tmp', 'run.lock');
  if (fs.existsSync(lockFile)) throw Error('V1 runner lock is active');
  const parsed = new Date(now);
  if (!Number.isFinite(parsed.getTime())) throw Error('handoff timestamp invalid');
  const site = new URL(required(origin, 'origin'));
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/') throw Error('handoff origin invalid');
  return {
    schemaVersion:1, mode:'v1_profile_handoff', state:'drained',
    previousOwner:'legacy-checkin', owner:'v2-worker', accountKey:required(accountKey, 'accountKey'),
    origin:site.origin, profileDir:profile, v1Root:root,
    v1RunLockAbsent:true, drainedAt:parsed.toISOString(), requiresExclusiveLease:true
  };
}

export function validateProfileHandoff(handoff, {accountKey, origin, profileDir} = {}) {
  if (handoff?.schemaVersion !== 1 || handoff.mode !== 'v1_profile_handoff' || handoff.state !== 'drained') throw Error('profile handoff is not drained');
  if (handoff.previousOwner !== 'legacy-checkin' || handoff.owner !== 'v2-worker' || handoff.v1RunLockAbsent !== true || handoff.requiresExclusiveLease !== true) throw Error('profile handoff ownership invalid');
  if (accountKey != null && handoff.accountKey !== accountKey) throw Error('profile handoff account mismatch');
  if (origin != null && new URL(origin).origin !== handoff.origin) throw Error('profile handoff origin mismatch');
  if (profileDir != null && path.resolve(profileDir) !== path.resolve(handoff.profileDir)) throw Error('profile handoff path mismatch');
  if (!Number.isFinite(Date.parse(handoff.drainedAt))) throw Error('profile handoff timestamp invalid');
  return true;
}
