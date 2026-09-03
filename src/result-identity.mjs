import { createHash } from "node:crypto";

export function resultIdentity(value) {
  const origin = new URL(String(value?.origin ?? "")).origin;
  const accountKey = String(value?.accountKey ?? "").trim();
  return accountKey ? `${origin}#account=${encodeURIComponent(accountKey)}` : origin;
}

function executionBinding(value = {}) {
  const existing = String(value?.executionBinding ?? "").trim();
  if (existing) {
    if (!/^[a-f0-9]{64}$/i.test(existing)) throw new Error("executionBinding 无效");
    return existing.toLowerCase();
  }
  const fields = {
    accountId: String(value?.accountId ?? "").trim(),
    provider: String(value?.provider ?? "").trim(),
    upstreamProvider: String(value?.upstreamProvider ?? "").trim(),
    loginUrl: String(value?.loginUrl ?? "").trim(),
    automationUserDataDir: String(value?.automationUserDataDir ?? "").trim().replaceAll("\\", "/").toLowerCase(),
  };
  return createHash("sha256").update(JSON.stringify(fields)).digest("hex");
}

// A plan fingerprint is deliberately derived from execution-relevant,
// secret-free fields only.  It lets the scheduler invalidate a report and its
// retry claims immediately when bookmarks or supplemental accounts change,
// even when the total target count happens to remain the same.
export function planFingerprint(targets = []) {
  const entries = (targets ?? []).map((target) => ({
    identity: resultIdentity(target),
    origin: new URL(String(target?.origin ?? "")).origin,
    candidates: [...new Set((target?.candidates ?? []).map((value) => String(value)))],
    allowedOrigins: [...new Set((target?.allowedOrigins ?? [target?.origin]).map((value) => new URL(String(value)).origin))].sort(),
    folderNames: [...new Set((target?.folderNames ?? []).map((value) => String(value).trim()).filter(Boolean))].sort(),
    executionBinding: executionBinding(target),
    supplementalAccount: target?.supplementalAccount === true,
  })).sort((left, right) => left.identity.localeCompare(right.identity));
  return createHash("sha256")
    .update(JSON.stringify(entries))
    .digest("hex");
}

export function resumePlanMatches(report, currentPlanFingerprint) {
  const previous = String(report?.bookmarkSummary?.planFingerprint ?? "").trim();
  const current = String(currentPlanFingerprint ?? "").trim();
  return Boolean(previous && current && previous === current);
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
  const raw = config.oauthAccountIdentities?.[expectedOrigin] ?? {};
  const accountKey = String(raw.accountKey ?? "").trim();
  const accountId = String(raw.accountId ?? "").trim();
  const provider = String(raw.provider ?? config.automaticOAuthProviders?.[expectedOrigin] ?? "").trim();
  const upstreamProvider = String(raw.upstreamProvider ?? config.oauthUpstreamProviders?.[expectedOrigin] ?? "").trim();
  const loginUrl = String(raw.loginUrl ?? config.oauthLoginUrls?.[expectedOrigin] ?? "").trim();
  const automationUserDataDir = String(raw.automationUserDataDir ?? "").trim();
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
    ["provider", provider, 40],
    ["upstreamProvider", upstreamProvider, 40],
    ["loginUrl", loginUrl, 500],
    ["automationUserDataDir", automationUserDataDir, 500],
  ]) {
    if (value && (value.length > maximum || /[\r\n]/.test(value))) {
      throw new Error(`OAuth 主账号 ${field} 无效：${expectedOrigin}`);
    }
  }
  if (accountKey && !/^[A-Za-z0-9._-]+$/.test(accountKey)) {
    throw new Error(`OAuth 主账号 accountKey 无效：${expectedOrigin}`);
  }
  const hasExecutionBinding = [accountId, provider, upstreamProvider, loginUrl, automationUserDataDir].some(Boolean);
  return {
    ...(accountKey ? { accountKey } : {}),
    ...(accountId ? { accountId } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(hasExecutionBinding ? {
      executionBinding: executionBinding({ accountId, provider, upstreamProvider, loginUrl, automationUserDataDir }),
    } : {}),
  };
}
