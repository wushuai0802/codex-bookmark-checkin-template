import path from "node:path";

export function resolveProjectDataProfile(rootDirectory, configuredPath, label = "browser profile") {
  if (!String(configuredPath ?? "").trim()) return null;
  const dataRoot = path.resolve(rootDirectory, "data");
  const resolved = path.resolve(rootDirectory, String(configuredPath));
  const relative = path.relative(dataRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a strict child of the project data directory`);
  }
  return resolved;
}

export function nativeWafProfileForOrigin(config, origin, rootDirectory) {
  const normalizedOrigin = new URL(origin).origin;
  const entries = [
    ...(config.nativeWafPreflightUrls ?? []),
    ...(config.nativeChallengePreflight ?? []),
  ];
  const profiles = [];
  const profileKeys = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry === "string" || !String(entry.automationUserDataDir ?? "").trim()) continue;
    let entryOrigin;
    try { entryOrigin = new URL(entry.url).origin; } catch { continue; }
    if (entryOrigin !== normalizedOrigin) continue;
    const resolved = resolveProjectDataProfile(
      rootDirectory,
      entry.automationUserDataDir,
      `native WAF profile for ${normalizedOrigin}`,
    );
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!profileKeys.has(key)) {
      profiles.push(resolved);
      profileKeys.add(key);
    }
  }
  if (profiles.length > 1) {
    throw new Error(`conflicting native WAF profiles for ${normalizedOrigin}`);
  }
  return profiles[0] ?? null;
}
