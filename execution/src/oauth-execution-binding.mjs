import path from "node:path";

export function configuredExecutionAccount(config, requestedOrigin) {
  const origin = new URL(requestedOrigin).origin;
  const key = config.oauthExecutionAccountBindings?.[origin];
  if (!key) return null;
  if (typeof key !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(key)) throw new Error("Invalid execution account binding");
  if (config.oauthSiteSessionBindings?.[origin] || config.isolatedOAuthSiteProfiles?.[origin]) throw new Error("Conflicting execution profile bindings");
  const recoveryKey = config.oauthRecoveryAccountBindings?.[origin];
  if (recoveryKey && recoveryKey !== key) throw new Error("Execution and recovery account bindings differ");
  const matches = [
    ...Object.values(config.oauthAccountIdentities ?? {}),
    ...(config.supplementalOAuthAccounts ?? []),
  ].filter(a => a.accountKey === key);
  if (matches.length !== 1 || !matches[0].automationUserDataDir) throw new Error("Execution account must resolve to one isolated profile");
  const account = matches[0];
  const normalize = value => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalize(account.provider) !== normalize(config.automaticOAuthProviders?.[origin])) throw new Error("Execution account provider mismatch");
  return account;
}

export function configForOAuthExecutionAccount(config, root, origin) {
  const account = configuredExecutionAccount(config, origin);
  if (!account) return config;
  const profile = path.resolve(root, account.automationUserDataDir);
  const relative = path.relative(path.resolve(root, "data"), profile);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Execution account profile must be inside data");
  return { ...config, automationUserDataDir: profile };
}
