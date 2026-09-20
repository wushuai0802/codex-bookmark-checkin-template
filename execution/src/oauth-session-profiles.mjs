import path from "node:path";

function requiredText(value, field, maximum = 120) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\r\n]/.test(text)) {
    throw new Error(`${field} 无效`);
  }
  return text;
}

function canonicalOrigin(value, field) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${field} 必须是 HTTPS origin`); }
  if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new Error(`${field} 必须是无凭据的规范 HTTPS origin`);
  }
  return url.origin;
}

function resolveDataProfile(rootDirectory, dataRoot, configured, field) {
  const profile = path.resolve(rootDirectory, requiredText(configured, field, 500));
  const relative = path.relative(dataRoot, profile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${field} 必须位于 data 内`);
  }
  return profile;
}

function reserveProfile(reserved, profile, owner) {
  const key = process.platform === "win32" ? profile.toLowerCase() : profile;
  const existing = reserved.get(key);
  if (existing) throw new Error(`OAuth 会话 Profile 不能与 ${existing} 重复：${owner}`);
  reserved.set(key, owner);
}

/**
 * Resolve optional shared browser profiles used by multiple OAuth-backed sites.
 * A profile is keyed by a stable local session name, while sites bind to that
 * name. This keeps one L-site login reusable without allowing identities to
 * silently share an account profile.
 */
export function configuredOAuthSessionProfiles(config = {}, rootDirectory) {
  const configured = config.oauthSessionProfiles ?? {};
  const bindings = config.oauthSiteSessionBindings ?? {};
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("oauthSessionProfiles 必须是对象");
  }
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error("oauthSiteSessionBindings 必须是对象");
  }

  const dataRoot = path.resolve(rootDirectory, "data");
  const reserved = new Map();
  const globalProfile = config.automationUserDataDir
    ? path.resolve(rootDirectory, String(config.automationUserDataDir))
    : null;
  if (globalProfile) reserveProfile(reserved, globalProfile, "automationUserDataDir");
  for (const [origin, identity] of Object.entries(config.oauthAccountIdentities ?? {})) {
    if (identity?.automationUserDataDir) {
      reserveProfile(
        reserved,
        path.resolve(rootDirectory, String(identity.automationUserDataDir)),
        identity.accountKey || origin,
      );
    }
  }
  for (const account of config.supplementalOAuthAccounts ?? []) {
    if (account?.automationUserDataDir) {
      reserveProfile(
        reserved,
        path.resolve(rootDirectory, String(account.automationUserDataDir)),
        account.accountKey || "supplementalOAuthAccounts",
      );
    }
  }
  for (const [origin, profilePath] of Object.entries(config.isolatedOAuthSiteProfiles ?? {})) {
    reserveProfile(reserved, path.resolve(rootDirectory, String(profilePath)), origin);
  }

  const profiles = new Map();
  for (const [sessionKey, configuredPath] of Object.entries(configured)) {
    const key = requiredText(sessionKey, "OAuth 会话名称", 80);
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(key)) throw new Error(`OAuth 会话名称无效：${key}`);
    const profile = resolveDataProfile(rootDirectory, dataRoot, configuredPath, `OAuth 会话 ${key} 浏览器目录`);
    reserveProfile(reserved, profile, `OAuth 会话 ${key}`);
    profiles.set(key, profile);
  }

  const siteBindings = new Map();
  for (const [configuredOrigin, rawSessionKey] of Object.entries(bindings)) {
    const origin = canonicalOrigin(configuredOrigin, "OAuth 会话站点");
    const sessionKey = requiredText(rawSessionKey, `OAuth 会话站点 ${origin} 会话名称`, 80);
    if (!profiles.has(sessionKey)) {
      throw new Error(`OAuth 会话站点 ${origin} 引用了未配置的会话：${sessionKey}`);
    }
    siteBindings.set(origin, sessionKey);
  }
  return { profiles, siteBindings };
}

export function oauthSessionProfileForOrigin(config, sessionProfiles, requestedOrigin) {
  const origin = new URL(requestedOrigin).origin;
  const sessionKey = sessionProfiles?.siteBindings?.get(origin);
  return sessionKey ? sessionProfiles.profiles.get(sessionKey) : null;
}

export function configForOAuthSession(config, sessionProfiles, requestedOrigin) {
  const profile = oauthSessionProfileForOrigin(config, sessionProfiles, requestedOrigin);
  return profile ? { ...config, automationUserDataDir: profile } : config;
}
