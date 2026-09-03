function configuredPreflightUrls(config = {}) {
  return [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
    ...(config.mainChromeFallbackUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
  ].filter(Boolean);
}

function configuredPreflightOrigins(config = {}) {
  return [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
    ...(config.mainChromeFallbackUrls ?? []).map((value) => (
      typeof value === "string" ? new URL(value).origin : value?.sourceOrigin ?? new URL(value?.url).origin
    )),
  ].filter(Boolean).map((value) => new URL(value).origin);
}

export function configuredNativeWafOrigins(config = {}) {
  return new Set([
    ...(config.nativeWafPreflightUrls ?? []),
    ...(config.mainChromeFallbackUrls ?? []),
  ]
    .map((value) => typeof value === "string" ? value : value?.sourceOrigin ?? value?.url)
    .filter(Boolean)
    .map((value) => new URL(value).origin));
}

export function requiresTrustedDeviceInitialization(preflight) {
  return preflight?.failureCode === "two_factor_required"
    || (preflight?.attentionKind === "trusted_device_initialization"
      && preflight?.retryableLoginRecovery === false);
}

export function selectPreflightOrigins(plan, config = {}) {
  const allowedOrigins = new Set();
  const disabledOrigins = new Set(config.disabledCheckinOrigins ?? []);
  for (const target of plan?.targets ?? []) {
    if (disabledOrigins.has(target.origin)) continue;
    allowedOrigins.add(target.origin);
    for (const origin of target.allowedOrigins ?? []) allowedOrigins.add(origin);
  }

  return [...new Set(configuredPreflightOrigins(config))]
    .filter((origin) => allowedOrigins.has(origin))
    .sort();
}
