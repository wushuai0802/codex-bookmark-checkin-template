import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);

export function freshProfilePath({v2Root, accountKey, origin} = {}) {
  if (typeof v2Root !== 'string' || !v2Root.trim()) throw Error('v2Root is required');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(accountKey ?? ''))) throw Error('accountKey is invalid');
  const site = new URL(String(origin));
  if (site.protocol !== 'https:' || site.username || site.password || site.pathname !== '/') throw Error('origin is invalid');
  return path.resolve(v2Root, 'data', 'v2-profiles', String(accountKey), `${site.hostname}-${digest(site.origin)}`);
}

export function enrollFreshProfile({v2Root, accountKey, origin, expectedIdentity, provider, now = new Date().toISOString()} = {}) {
  const profileDir = freshProfilePath({v2Root, accountKey, origin});
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw Error('enrollment timestamp invalid');
  if (!/^\d{1,20}$/.test(String(expectedIdentity ?? ''))) throw Error('expected identity is required');
  fs.mkdirSync(profileDir, {recursive:true});
  return {schemaVersion:1, state:'pending_login', owner:'v2-worker', accountKey:String(accountKey), origin:new URL(origin).origin,
    expectedIdentity:String(expectedIdentity), provider:typeof provider === 'string' ? provider.slice(0,40) : null,
    profileDir, enrolledAt:timestamp.toISOString(), v1TaskStopEligible:false};
}

export function markProfileReady(record, {identity, username = null, observedAt = new Date().toISOString()} = {}) {
  if (!record || record.state !== 'pending_login') throw Error('profile is not pending login');
  if (!identity || String(identity) !== record.expectedIdentity) throw Error('verified identity mismatch');
  if (!Number.isFinite(Date.parse(observedAt))) throw Error('identity timestamp invalid');
  return {...record, state:'ready', identity:String(identity), username:typeof username === 'string' ? username.slice(0,80) : null,
    identityVerifiedAt:new Date(observedAt).toISOString(), v1TaskStopEligible:true};
}
