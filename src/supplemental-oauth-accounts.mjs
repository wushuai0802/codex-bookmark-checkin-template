import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loginHelperOutcome, parseLoginHelperResult } from "./login-recovery.mjs";
import { authoritativeAccountDisplay, resultIdentity } from "./result-identity.mjs";

const execFileAsync = promisify(execFile);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function requiredText(value, field, maximum = 120) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\r\n]/.test(text)) throw new Error(`补充 OAuth 账号 ${field} 无效`);
  return text;
}

export function configuredOAuthAccounts(config = {}, rootDirectory) {
  const dataRoot = path.resolve(rootDirectory, "data");
  const rawAccounts = config.supplementalOAuthAccounts ?? [];
  if (!Array.isArray(rawAccounts)) throw new Error("supplementalOAuthAccounts 必须是数组");
  const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const identities = new Set();
  const accountIds = new Set();
  const profilePaths = new Set();
  const resolveDataProfile = (configured, field) => {
    const value = requiredText(configured, field, 500);
    const resolved = path.resolve(rootDirectory, value);
    const relative = path.relative(dataRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${field} 必须位于 data 内`);
    }
    return resolved;
  };
  const reserveProfile = (profile, owner) => {
    const identity = pathKey(profile);
    if (profilePaths.has(identity)) throw new Error(`OAuth 账号浏览器目录重复：${owner}`);
    profilePaths.add(identity);
  };
  if (config.automationUserDataDir) {
    reserveProfile(resolveDataProfile(config.automationUserDataDir, "automationUserDataDir"), "automationUserDataDir");
  }
  const isolatedPrimaryAccounts = [];
  for (const [configuredOrigin, raw] of Object.entries(config.oauthAccountIdentities ?? {})) {
    const originUrl = new URL(configuredOrigin);
    if (originUrl.protocol !== "https:" || originUrl.username || originUrl.password) {
      throw new Error(`OAuth 主账号来源必须是无凭据 HTTPS 地址：${configuredOrigin}`);
    }
    const origin = originUrl.origin;
    const accountKey = String(raw?.accountKey ?? "").trim();
    const accountId = String(raw?.accountId ?? "").trim();
    if (accountKey) {
      const identity = resultIdentity({ origin, accountKey });
      if (identities.has(identity)) throw new Error(`OAuth 主账号重复：${identity}`);
      identities.add(identity);
    }
    if (accountId) {
      const accountIdIdentity = `${origin}#id=${accountId}`;
      if (accountIds.has(accountIdIdentity)) throw new Error(`OAuth 主账号 ID 重复：${origin} ${accountId}`);
      accountIds.add(accountIdIdentity);
    }
    if (raw?.automationUserDataDir != null && String(raw.automationUserDataDir).trim()) {
      const isolatedAccountKey = requiredText(accountKey, `主账号 ${configuredOrigin} accountKey`, 80);
      const isolatedAccountId = requiredText(accountId, `主账号 ${configuredOrigin} accountId`, 80);
      const accountLabel = authoritativeAccountDisplay(requiredText(
        raw?.accountLabel ?? raw?.displayName ?? isolatedAccountId,
        `主账号 ${isolatedAccountKey} accountLabel`,
        120,
      ), isolatedAccountId, isolatedAccountId);
      const provider = requiredText(
        raw?.provider ?? config.automaticOAuthProviders?.[origin],
        `主账号 ${isolatedAccountKey} provider`,
        40,
      );
      const upstreamProvider = requiredText(
        raw?.upstreamProvider ?? config.oauthUpstreamProviders?.[origin],
        `主账号 ${isolatedAccountKey} upstreamProvider`,
        40,
      );
      const loginUrl = new URL(requiredText(
        raw?.loginUrl ?? config.oauthLoginUrls?.[origin] ?? `${origin}/login`,
        `主账号 ${isolatedAccountKey} loginUrl`,
      ));
      if (loginUrl.protocol !== "https:" || loginUrl.origin !== origin || loginUrl.username || loginUrl.password) {
        throw new Error(`OAuth 主账号 ${isolatedAccountKey} 的 loginUrl 必须属于目标 HTTPS origin`);
      }
      const profile = resolveDataProfile(raw.automationUserDataDir, `OAuth 主账号 ${accountKey || configuredOrigin} automationUserDataDir`);
      reserveProfile(profile, accountKey || configuredOrigin);
      isolatedPrimaryAccounts.push({
        accountKey: isolatedAccountKey,
        accountId: isolatedAccountId,
        accountLabel,
        provider,
        upstreamProvider,
        origin,
        loginUrl: loginUrl.href,
        automationUserDataDir: profile,
        title: authoritativeAccountDisplay(
          requiredText(raw?.title ?? `OAuth ${accountLabel}`, `主账号 ${isolatedAccountKey} title`, 160),
          isolatedAccountId,
          `OAuth ${accountLabel}`,
        ),
      });
    }
  }
  const supplementalAccounts = rawAccounts.map((raw, index) => {
    const accountKey = requiredText(raw?.accountKey, `第 ${index + 1} 项 accountKey`, 80);
    const accountId = requiredText(raw?.accountId, `第 ${index + 1} 项 accountId`, 80);
    const accountLabel = authoritativeAccountDisplay(
      requiredText(raw?.accountLabel ?? accountId, `第 ${index + 1} 项 accountLabel`, 120),
      accountId,
      accountId,
    );
    const provider = requiredText(raw?.provider, `第 ${index + 1} 项 provider`, 40);
    const upstreamProvider = requiredText(raw?.upstreamProvider, `第 ${index + 1} 项 upstreamProvider`, 40);
    const originUrl = new URL(requiredText(raw?.origin, `第 ${index + 1} 项 origin`));
    if (originUrl.protocol !== "https:" || originUrl.username || originUrl.password) {
      throw new Error(`补充 OAuth 账号 ${accountKey} 的 origin 必须是无凭据 HTTPS 地址`);
    }
    const origin = originUrl.origin;
    const loginUrl = new URL(requiredText(raw?.loginUrl ?? `${origin}/login`, `第 ${index + 1} 项 loginUrl`));
    if (loginUrl.protocol !== "https:" || loginUrl.origin !== origin || loginUrl.username || loginUrl.password) {
      throw new Error(`补充 OAuth 账号 ${accountKey} 的 loginUrl 必须属于目标 HTTPS origin`);
    }
    const automationUserDataDir = resolveDataProfile(
      raw?.automationUserDataDir,
      `补充 OAuth 账号 ${accountKey} 的浏览器目录`,
    );
    const account = {
      accountKey, accountId, accountLabel, provider, upstreamProvider,
      origin, loginUrl: loginUrl.href, automationUserDataDir,
      title: authoritativeAccountDisplay(
        requiredText(raw?.title ?? `OAuth ${accountLabel}`, `第 ${index + 1} 项 title`, 160),
        accountId,
        `OAuth ${accountLabel}`,
      ),
      supplementalAccount: true,
    };
    const identity = resultIdentity(account);
    if (identities.has(identity)) throw new Error(`补充 OAuth 账号重复：${identity}`);
    const accountIdIdentity = `${origin}#id=${accountId}`;
    if (accountIds.has(accountIdIdentity)) throw new Error(`补充 OAuth 账号 ID 重复：${origin} ${accountId}`);
    const profileIdentity = pathKey(automationUserDataDir);
    if (profilePaths.has(profileIdentity)) throw new Error(`补充 OAuth 账号浏览器目录重复：${automationUserDataDir}`);
    identities.add(identity);
    accountIds.add(accountIdIdentity);
    profilePaths.add(profileIdentity);
    return account;
  });
  return { isolatedPrimaryAccounts, supplementalAccounts };
}

export function configuredIsolatedPrimaryOAuthAccounts(config = {}, rootDirectory) {
  return configuredOAuthAccounts(config, rootDirectory).isolatedPrimaryAccounts;
}

export function configuredSupplementalOAuthAccounts(config = {}, rootDirectory) {
  return configuredOAuthAccounts(config, rootDirectory).supplementalAccounts;
}

export function oauthHelperResultToCheckin(account, value, fallbackReason = "OAuth 账号恢复失败") {
  const supplementalAccount = account.supplementalAccount === true;
  const metadata = {
    origin: account.origin,
    title: account.title,
    folderNames: account.folderNames ?? (supplementalAccount ? ["supplemental-oauth"] : []),
    accountKey: account.accountKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
    provider: account.provider,
    upstreamProvider: account.upstreamProvider,
    ...(supplementalAccount ? { supplementalAccount: true } : {}),
  };
  const daily = value?.dailyCheckin;
  if (["signed", "already_signed"].includes(daily?.status)) {
    return {
      ...metadata,
      status: daily.status,
      reason: daily.reason,
      evidence: daily.evidence,
      url: value?.finalUrl ?? account.loginUrl,
    };
  }
  const helperOutcome = loginHelperOutcome(value ? JSON.stringify(value) : "", "failed");
  const retryable = helperOutcome.retryable === true;
  return {
    ...metadata,
    status: retryable ? "login_required" : "needs_attention",
    reason: String(value?.reason ?? daily?.reason ?? fallbackReason).slice(0, 240),
    url: value?.finalUrl ?? account.loginUrl,
    ...(helperOutcome.failureCode ? { failureCode: helperOutcome.failureCode } : {}),
    retryableLoginRecovery: retryable,
  };
}

export function oauthAccountRetryPolicy(config = {}) {
  const rawAttempts = Number(config.oauthAccountAttempts);
  const rawDelayMs = Number(config.oauthAccountRetryDelayMs);
  const attempts = Math.max(1, Math.min(3, Number.isFinite(rawAttempts) && rawAttempts > 0 ? Math.trunc(rawAttempts) : 2));
  const delayMs = Math.max(0, Math.min(60_000, Number.isFinite(rawDelayMs) && rawDelayMs >= 0 ? rawDelayMs : 5_000));
  return { attempts, delayMs };
}

export async function runOAuthAccount(account, config, rootDirectory) {
  const marker = path.join(account.automationUserDataDir, "Local State");
  try { await fs.access(marker); } catch {
    return oauthHelperResultToCheckin(account, {
      status: "needs_attention",
      reason: "独立登录会话尚未初始化",
      failureCode: "configuration_mismatch",
    });
  }
  const executable = config.powershellExecutable || "pwsh.exe";
  const args = [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(rootDirectory, "scripts", "Recover-NativeOAuthLogin.ps1"),
    "-Origin", account.origin,
    "-Provider", account.provider,
    "-LoginUrl", account.loginUrl,
    "-AutomationUserDataDir", account.automationUserDataDir,
    "-ExpectedAccountId", account.accountId,
    "-AccountKey", account.accountKey,
    "-AccountLabel", account.accountLabel,
    "-UpstreamProvider", account.upstreamProvider,
  ];
  const policy = oauthAccountRetryPolicy(config);
  let lastResult = oauthHelperResultToCheckin(account, null);
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(executable, args, {
        cwd: rootDirectory, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
      });
      lastResult = oauthHelperResultToCheckin(account, parseLoginHelperResult(stdout));
    } catch (error) {
      const parsed = parseLoginHelperResult(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`);
      lastResult = oauthHelperResultToCheckin(
        account,
        parsed,
        error?.code === "ETIMEDOUT" ? "OAuth 账号恢复超时" : "OAuth 账号恢复失败",
      );
    }
    lastResult = { ...lastResult, oauthAttempt: attempt };
    if (["signed", "already_signed"].includes(lastResult.status)) return lastResult;
    const nonRetryable = lastResult.status === "needs_attention"
      || /(账号不匹配|身份不匹配|配置不一致|rate.?limit|too many|请求(?:次数)?过多|操作过于频繁)/iu.test(lastResult.reason);
    if (nonRetryable || attempt >= policy.attempts) break;
    if (policy.delayMs > 0) await wait(policy.delayMs);
  }
  return lastResult;
}

export async function runSupplementalOAuthAccount(account, config, rootDirectory) {
  return runOAuthAccount(account, config, rootDirectory);
}
