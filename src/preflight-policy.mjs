function configuredPreflightUrls(config = {}) {
  return [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
  ].filter(Boolean);
}

export function selectPreflightOrigins(plan, config = {}) {
  const allowedOrigins = new Set();
  const disabledOrigins = new Set(config.disabledCheckinOrigins ?? []);
  for (const target of plan?.targets ?? []) {
    if (disabledOrigins.has(target.origin)) continue;
    allowedOrigins.add(target.origin);
    for (const origin of target.allowedOrigins ?? []) allowedOrigins.add(origin);
  }

  return [...new Set(configuredPreflightUrls(config).map((value) => new URL(value).origin))]
    .filter((origin) => allowedOrigins.has(origin))
    .sort();
}
