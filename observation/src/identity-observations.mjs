import crypto from 'node:crypto';
import path from 'node:path';
import { displayIdentity } from './display-identity.mjs';
import {resolveExecutionProfile} from './effective-config.mjs';

export function identityBinding(config, root, origin, accountKey) {
  const executionKey = config.oauthExecutionAccountBindings?.[origin] ?? null;
  const account = executionKey ? [...Object.values(config.oauthAccountIdentities ?? {}), ...(config.supplementalOAuthAccounts ?? [])].find(item => item.accountKey === executionKey) : null;
  const sessionKey = config.oauthSiteSessionBindings?.[origin] ?? null;
  const profile = resolveExecutionProfile(config, root, origin, accountKey);
  const canonicalProfile = process.platform === 'win32' ? profile.toLowerCase() : profile;
  return crypto.createHash('sha256').update(JSON.stringify({origin,accountKey,profile:canonicalProfile,executionKey,sessionKey,
    targetOrigin:config.oauthRecoveryTargetOrigins?.[origin] ?? origin, expectedId:account?.accountId ?? null})).digest('hex');
}

export function observedIdentity(report, { config, root, origin, accountKey, now }) {
  if (!report?.observations?.length) return null;
  const bindingKey = identityBinding(config, root, origin, accountKey);
  const matches = (report?.observations ?? []).filter(item => {
    const age = Date.parse(now) - Date.parse(item.observedAt ?? item.verifiedAt);
    return item.origin === origin && item.accountKey === accountKey && item.bindingKey === bindingKey
      && ['user-self','browser-cache'].includes(item.source) && Number.isFinite(age) && age >= 0 && age <= 30 * 86400000;
  });
  if (!matches.length || new Set(matches.map(item => String(item.userId))).size !== 1) return null;
  matches.sort((a,b) => Date.parse(b.observedAt ?? b.verifiedAt)-Date.parse(a.observedAt ?? a.verifiedAt));
  return displayIdentity({...matches[0], observedAt:matches[0].observedAt ?? matches[0].verifiedAt});
}
