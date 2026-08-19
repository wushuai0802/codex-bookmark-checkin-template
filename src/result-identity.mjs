export function resultIdentity(value) {
  const origin = new URL(String(value?.origin ?? "")).origin;
  const accountKey = String(value?.accountKey ?? "").trim();
  return accountKey ? `${origin}#account=${encodeURIComponent(accountKey)}` : origin;
}

export function authoritativeAccountDisplay(value, accountId, fallback = accountId) {
  const expected = String(accountId ?? "").trim();
  const text = String(value ?? "").trim() || String(fallback ?? "").trim();
  if (!expected || !text) return text;
  const numericTokens = text.match(/(?<!\d)\d{4,}(?!\d)/g) ?? [];
  if (numericTokens.length === 1 && numericTokens[0] !== expected) {
    return text.replace(numericTokens[0], expected);
  }
  return text;
}

export function compatiblePriorResult(target, previousResults = []) {
  const expectedIdentity = resultIdentity(target);
  const exact = previousResults.find((result) => resultIdentity(result) === expectedIdentity);
  if (exact) {
    const targetAccountId = String(target?.accountId ?? "").trim();
    const priorAccountId = String(exact?.accountId ?? "").trim();
    if (targetAccountId && priorAccountId && targetAccountId !== priorAccountId) return null;
    return {
      ...exact,
      ...(target?.title ? { title: target.title } : {}),
      ...(target?.accountKey ? { accountKey: target.accountKey } : {}),
      ...(targetAccountId ? { accountId: targetAccountId } : {}),
      ...(target?.accountLabel ? { accountLabel: target.accountLabel } : {}),
      ...(target?.provider ? { provider: target.provider } : {}),
      ...(target?.upstreamProvider ? { upstreamProvider: target.upstreamProvider } : {}),
    };
  }

  // Reports written before account-aware identities only had an origin. They
  // can safely migrate to the primary bookmark account, never a supplemental
  // account, when the legacy origin is unambiguous.
  if (!target?.accountKey || target?.supplementalAccount) return null;
  const legacy = previousResults.filter((result) => {
    return !String(result?.accountKey ?? "").trim()
      && new URL(String(result?.origin ?? "")).origin === new URL(String(target.origin)).origin;
  });
  if (legacy.length !== 1) return null;
  return {
    ...legacy[0],
    ...(target?.title ? { title: target.title } : {}),
    accountKey: target.accountKey,
    ...(target.accountId ? { accountId: target.accountId } : {}),
    ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}),
    ...(target?.provider ? { provider: target.provider } : {}),
    ...(target?.upstreamProvider ? { upstreamProvider: target.upstreamProvider } : {}),
    migratedLegacyIdentity: true,
  };
}

export function accountMetadataForOrigin(origin, config = {}) {
  const expectedOrigin = new URL(origin).origin;
  const raw = config.oauthAccountIdentities?.[expectedOrigin];
  if (!raw) return {};
  const accountKey = String(raw.accountKey ?? "").trim();
  const accountId = String(raw.accountId ?? "").trim();
  const expectedAccountId = String(config.oauthExpectedAccountIds?.[expectedOrigin] ?? "").trim();
  if (accountId && expectedAccountId && accountId !== expectedAccountId) {
    throw new Error(`OAuth 主账号身份与预期账号不一致：${expectedOrigin}`);
  }
  const accountLabel = authoritativeAccountDisplay(
    raw.accountLabel ?? raw.displayName ?? accountId,
    accountId,
    accountId,
  );
  for (const [field, value, maximum] of [
    ["accountKey", accountKey, 80],
    ["accountId", accountId, 80],
    ["accountLabel", accountLabel, 120],
  ]) {
    if (value && (value.length > maximum || /[\r\n]/.test(value))) {
      throw new Error(`OAuth 主账号 ${field} 无效：${expectedOrigin}`);
    }
  }
  return {
    ...(accountKey ? { accountKey } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
  };
}
