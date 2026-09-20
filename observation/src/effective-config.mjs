import fs from 'node:fs';
import path from 'node:path';

// V1's config.json is already the compiled execution configuration. Local
// overrides are inputs to its installer, NOT an additional runtime layer.
export function loadEffectiveConfig(root, { required = true } = {}) {
  const file = path.join(root, 'config', 'config.json');
  if (!fs.existsSync(file)) {
    if (!required) return {};
    throw new Error('effective runtime configuration is missing');
  }
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('effective runtime configuration is invalid JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('effective runtime configuration must be an object');
  return config;
}

export function resolveExecutionProfile(config, root, origin, accountKey = 'site-default') {
  const primary = Object.entries(config.oauthAccountIdentities ?? {}).map(([site, account]) => ({ ...account, origin:site }));
  const accounts = [...primary, ...(config.supplementalOAuthAccounts ?? [])];
  const direct = accounts.filter(account => account.origin === origin && account.accountKey === accountKey);
  const executionKey = config.oauthExecutionAccountBindings?.[origin];
  const bound = executionKey ? accounts.filter(account => account.accountKey === executionKey) : [];
  if (direct.length > 1 || (executionKey && bound.length !== 1)) throw new Error('ambiguous execution account binding');
  const sessionKey = config.oauthSiteSessionBindings?.[origin];
  const isolated = config.isolatedOAuthSiteProfiles?.[origin];
  if ([Boolean(executionKey), Boolean(sessionKey), Boolean(isolated)].filter(Boolean).length > 1) throw new Error('conflicting profile bindings');
  if (sessionKey && !config.oauthSessionProfiles?.[sessionKey]) throw new Error('missing shared session profile');
  const selected = direct[0]?.automationUserDataDir || isolated || bound[0]?.automationUserDataDir || config.oauthSessionProfiles?.[sessionKey] || config.automationUserDataDir;
  if (!selected) throw new Error('execution profile is missing');
  const profile = path.resolve(root, selected), relative = path.relative(path.resolve(root, 'data'), profile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('execution profile must be inside dedicated data root');
  return profile;
}

export function configForBookmarks(config) {
  return { ...config, excludedOrigins: [...new Set((config.excludedOrigins ?? []).map(value => String(value).trim()).filter(Boolean))] };
}
