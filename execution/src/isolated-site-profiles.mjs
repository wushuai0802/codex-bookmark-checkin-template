import path from "node:path";

function requiredProfilePath(configured, field) {
  const value = String(configured ?? "").trim();
  if (!value || value.length > 500 || /[\r\n]/.test(value)) {
    throw new Error(`${field} 无效`);
  }
  return value;
}

function canonicalHttpsOrigin(configured, field) {
  const value = String(configured ?? "").trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} 必须是 HTTPS origin`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.href !== `${url.origin}/`) {
    throw new Error(`${field} 必须是无凭据的规范 HTTPS origin`);
  }
  return url.origin;
}

export function configuredIsolatedOAuthSiteProfiles(config = {}, rootDirectory) {
  const configured = config.isolatedOAuthSiteProfiles ?? {};
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("isolatedOAuthSiteProfiles 必须是对象");
  }

  const dataRoot = path.resolve(rootDirectory, "data");
  const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const reservedProfiles = new Map();
  const resolveDataProfile = (value, field) => {
    const profile = path.resolve(rootDirectory, requiredProfilePath(value, field));
    const relative = path.relative(dataRoot, profile);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${field} 必须位于 data 内`);
    }
    return profile;
  };
  const reserveProfile = (value, owner) => {
    if (value == null || !String(value).trim()) return;
    const profile = resolveDataProfile(value, `${owner} 浏览器目录`);
    const identity = pathKey(profile);
    const existing = reservedProfiles.get(identity);
    if (existing) throw new Error(`浏览器目录必须唯一：${owner} 与 ${existing} 重复`);
    reservedProfiles.set(identity, owner);
  };

  reserveProfile(config.automationUserDataDir, "automationUserDataDir");
  for (const [origin, identity] of Object.entries(config.oauthAccountIdentities ?? {})) {
    reserveProfile(identity?.automationUserDataDir, identity?.accountKey || origin);
  }
  for (const account of config.supplementalOAuthAccounts ?? []) {
    reserveProfile(account?.automationUserDataDir, account?.accountKey || "supplementalOAuthAccounts");
  }

  const profiles = new Map();
  for (const [configuredOrigin, configuredPath] of Object.entries(configured)) {
    const origin = canonicalHttpsOrigin(configuredOrigin, "隔离 OAuth 站点");
    const profile = resolveDataProfile(configuredPath, `隔离 OAuth 站点 ${origin} 浏览器目录`);
    const identity = pathKey(profile);
    const existing = reservedProfiles.get(identity);
    if (existing) throw new Error(`浏览器目录必须唯一：${origin} 与 ${existing} 重复`);
    reservedProfiles.set(identity, origin);
    profiles.set(origin, profile);
  }
  return profiles;
}

export function configForIsolatedOAuthSite(config, profiles, origin) {
  const profile = profiles.get(new URL(origin).origin);
  return profile ? { ...config, automationUserDataDir: profile } : config;
}
