import { configuredOAuthAccounts } from "./supplemental-oauth-accounts.mjs";

function normalizedProvider(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function configForOAuthRecoveryAccount(config, rootDirectory, requestedOrigin, provider) {
  const origin = new URL(requestedOrigin).origin;
  // Preserve an explicit shared-session binding so recovery does not switch
  // back to an account profile and trigger a redundant upstream challenge.
  const sessionKey = String(config.oauthSiteSessionBindings?.[origin] ?? "").trim();
  if (sessionKey && config.oauthSessionProfiles?.[sessionKey]) return config;
  const accountKey = String(config.oauthRecoveryAccountBindings?.[origin] ?? "").trim();
  if (!accountKey) return config;
  if (accountKey.length > 80 || /[\r\n]/.test(accountKey)) {
    throw new Error(`OAuth 恢复账号映射无效：${origin}`);
  }

  const { isolatedPrimaryAccounts, supplementalAccounts } = configuredOAuthAccounts(config, rootDirectory);
  const matches = [...isolatedPrimaryAccounts, ...supplementalAccounts]
    .filter((account) => account.accountKey === accountKey);
  if (matches.length !== 1) throw new Error(`OAuth 恢复账号不存在或不唯一：${origin} ${accountKey}`);
  const account = matches[0];
  if (normalizedProvider(account.provider) !== normalizedProvider(provider)) {
    throw new Error(`OAuth 恢复账号提供商不匹配：${origin} ${accountKey}`);
  }
  return { ...config, automationUserDataDir: account.automationUserDataDir };
}
