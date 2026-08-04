import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLoginHelperResult } from "./login-recovery.mjs";
import { resultIdentity } from "./result-identity.mjs";

const execFileAsync = promisify(execFile);

function requiredText(value, field, maximum = 120) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum || /[\r\n]/.test(text)) throw new Error(`补充 OAuth 账号 ${field} 无效`);
  return text;
}

export function configuredSupplementalOAuthAccounts(config = {}, rootDirectory) {
  const dataRoot = path.resolve(rootDirectory, "data");
  const rawAccounts = config.supplementalOAuthAccounts ?? [];
  if (!Array.isArray(rawAccounts)) throw new Error("supplementalOAuthAccounts 必须是数组");
  const pathKey = (value) => process.platform === "win32" ? value.toLowerCase() : value;
  const identities = new Set();
  const accountIds = new Set();
  const profilePaths = new Set();
  for (const [configuredOrigin, raw] of Object.entries(config.oauthAccountIdentities ?? {})) {
    const origin = new URL(configuredOrigin).origin;
    const accountKey = String(raw?.accountKey ?? "").trim();
    const accountId = String(raw?.accountId ?? "").trim();
    if (accountKey) identities.add(resultIdentity({ origin, accountKey }));
    if (accountId) accountIds.add(`${origin}#id=${accountId}`);
  }
  if (config.automationUserDataDir) {
    profilePaths.add(pathKey(path.resolve(rootDirectory, String(config.automationUserDataDir))));
  }
  return rawAccounts.map((raw, index) => {
    const accountKey = requiredText(raw?.accountKey, `第 ${index + 1} 项 accountKey`, 80);
    const accountId = requiredText(raw?.accountId, `第 ${index + 1} 项 accountId`, 80);
    const accountLabel = requiredText(raw?.accountLabel ?? accountId, `第 ${index + 1} 项 accountLabel`, 120);
    const provider = requiredText(raw?.provider, `第 ${index + 1} 项 provider`, 40);
    const upstreamProvider = requiredText(raw?.upstreamProvider ?? "Google", `第 ${index + 1} 项 upstreamProvider`, 40);
    const originUrl = new URL(requiredText(raw?.origin, `第 ${index + 1} 项 origin`));
    if (originUrl.protocol !== "https:" || originUrl.username || originUrl.password) {
      throw new Error(`补充 OAuth 账号 ${accountKey} 的 origin 必须是无凭据 HTTPS 地址`);
    }
    const origin = originUrl.origin;
    const loginUrl = new URL(requiredText(raw?.loginUrl ?? `${origin}/login`, `第 ${index + 1} 项 loginUrl`));
    if (loginUrl.protocol !== "https:" || loginUrl.origin !== origin || loginUrl.username || loginUrl.password) {
      throw new Error(`补充 OAuth 账号 ${accountKey} 的 loginUrl 必须属于目标 HTTPS origin`);
    }
    const configuredProfile = requiredText(raw?.automationUserDataDir, `第 ${index + 1} 项 automationUserDataDir`, 500);
    const automationUserDataDir = path.resolve(rootDirectory, configuredProfile);
    const profileRelative = path.relative(dataRoot, automationUserDataDir);
    if (!profileRelative || profileRelative.startsWith("..") || path.isAbsolute(profileRelative)) {
      throw new Error(`补充 OAuth 账号 ${accountKey} 的浏览器目录必须位于 data 内`);
    }
    const account = {
      accountKey, accountId, accountLabel, provider, upstreamProvider,
      origin, loginUrl: loginUrl.href, automationUserDataDir,
      title: requiredText(raw?.title ?? `OAuth ${accountLabel}`, `第 ${index + 1} 项 title`, 160),
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
}

function helperResultToCheckin(account, value, fallbackReason = "补充 OAuth 账号恢复失败") {
  const daily = value?.dailyCheckin;
  if (["signed", "already_signed"].includes(daily?.status)) {
    return {
      origin: account.origin,
      title: account.title,
      folderNames: ["supplemental-oauth"],
      accountKey: account.accountKey,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      provider: account.provider,
      status: daily.status,
      reason: daily.reason,
      evidence: daily.evidence,
      url: value?.finalUrl ?? account.loginUrl,
      supplementalAccount: true,
    };
  }
  return {
    origin: account.origin,
    title: account.title,
    folderNames: ["supplemental-oauth"],
    accountKey: account.accountKey,
    accountId: account.accountId,
    accountLabel: account.accountLabel,
    provider: account.provider,
    status: "login_required",
    reason: String(value?.reason ?? daily?.reason ?? fallbackReason).slice(0, 240),
    url: value?.finalUrl ?? account.loginUrl,
    supplementalAccount: true,
  };
}

export async function runSupplementalOAuthAccount(account, config, rootDirectory) {
  const marker = path.join(account.automationUserDataDir, "Local State");
  try { await fs.access(marker); } catch {
    return helperResultToCheckin(account, null, "独立登录会话尚未初始化");
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
  try {
    const { stdout } = await execFileAsync(executable, args, {
      cwd: rootDirectory, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024,
    });
    return helperResultToCheckin(account, parseLoginHelperResult(stdout));
  } catch (error) {
    const parsed = parseLoginHelperResult(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`);
    return helperResultToCheckin(account, parsed, error?.code === "ETIMEDOUT" ? "补充 OAuth 账号恢复超时" : "补充 OAuth 账号恢复失败");
  }
}
