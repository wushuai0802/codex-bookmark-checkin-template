import { safeErrorMessage } from "./security.mjs";

const LOGIN_HELPER_STATUSES = new Set([
  "logged_in",
  "needs_attention",
  "no_saved_credential",
  "credential_missing",
  "invalid_credential",
  "unsupported",
  "timeout",
  "failed",
]);

const LOGIN_FAILURE_CODES = new Set([
  "account_mismatch",
  "configuration_mismatch",
  "upstream_login_required",
  "upstream_authorization_required",
  "managed_challenge",
  "oauth_timeout",
  "profile_busy",
  "browser_startup",
  "site_flow_changed",
  "oauth_recovery_failed",
]);

const RETRYABLE_LOGIN_FAILURE_CODES = new Set([
  "managed_challenge",
  "oauth_timeout",
  "profile_busy",
  "browser_startup",
  "oauth_recovery_failed",
]);

const LOGIN_URL_PATTERN = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)|#\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i;
const TERMINAL_DAILY_CHECKIN_STATUSES = new Set(["signed", "already_signed"]);

function safeTerminalDailyCheckin(value) {
  const status = String(value?.status ?? "");
  if (!TERMINAL_DAILY_CHECKIN_STATUSES.has(status)) return null;
  const reason = safeErrorMessage(String(value?.reason || "登录助手确认今日签到完成")).slice(0, 240);
  const rawEvidence = value?.evidence;
  const evidence = {};
  if (rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
    const source = String(rawEvidence.source ?? "").trim();
    if (/^[a-z0-9_-]{1,40}$/i.test(source)) evidence.source = source;
    const createdAt = String(rawEvidence.createdAt ?? "").trim();
    if (createdAt && Number.isFinite(Date.parse(createdAt))) evidence.createdAt = new Date(createdAt).toISOString();
    const rewardAmount = Number(rawEvidence.rewardAmount);
    if (Number.isFinite(rewardAmount) && rewardAmount >= 0 && rewardAmount <= 1_000_000_000) {
      evidence.rewardAmount = rewardAmount;
    }
  }
  return {
    status,
    reason,
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
}

export function parseLoginHelperResult(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const value = JSON.parse(lines.slice(index).join("\n"));
      if (value && typeof value === "object") return value;
    } catch { /* helpers may include harmless non-JSON browser startup text */ }
  }
  for (const line of [...lines].reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object") return value;
    } catch { /* a compact result may appear before trailing diagnostic text */ }
  }
  return null;
}

export function loginHelperOutcome(text, fallback = "failed") {
  const value = parseLoginHelperResult(text);
  const status = LOGIN_HELPER_STATUSES.has(String(value?.status)) ? String(value.status) : fallback;
  const failureCode = LOGIN_FAILURE_CODES.has(String(value?.failureCode))
    ? String(value.failureCode)
    : null;
  const messages = {
    logged_in: "已取得登录会话",
    needs_attention: "登录需要额外验证",
    no_saved_credential: "独立配置没有可用保存凭据",
    credential_missing: "没有配置受保护站点凭据",
    invalid_credential: "站点拒绝了当前凭据",
    unsupported: "未识别可自动提交的登录表单",
    timeout: "登录恢复流程超时",
    failed: "登录恢复流程失败",
  };
  const dailyCheckin = status === "logged_in" ? safeTerminalDailyCheckin(value?.dailyCheckin) : null;
  const diagnosticCode = ["invalid_credential", "credential_missing", "no_saved_credential"].includes(status)
    ? status
    : null;
  const retryable = status !== "logged_in" && (
    RETRYABLE_LOGIN_FAILURE_CODES.has(failureCode)
    || (!failureCode && ["timeout", "failed"].includes(status))
  );
  return {
    succeeded: status === "logged_in",
    status,
    diagnostic: messages[status] ?? messages.failed,
    ...(diagnosticCode ? { diagnosticCode } : {}),
    ...(failureCode ? { failureCode } : {}),
    ...(status !== "logged_in" ? { retryable } : {}),
    ...(dailyCheckin ? { dailyCheckin } : {}),
  };
}

export function authoritativeNativeOAuthDailyCheckin(method, outcome) {
  if (method !== "native_oauth" || outcome?.succeeded !== true) return null;
  return safeTerminalDailyCheckin(outcome.dailyCheckin);
}

function sameOriginHttpsUrl(value, expectedOrigin) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== expectedOrigin || url.username || url.password) {
    throw new Error("登录恢复地址必须属于目标 HTTPS origin");
  }
  return url;
}

export function resolveLoginRecoveryUrl(origin, configuredUrl, observedUrl) {
  const expected = sameOriginHttpsUrl(origin, new URL(origin).origin).origin;
  if (configuredUrl) return sameOriginHttpsUrl(configuredUrl, expected).href;

  if (observedUrl) {
    try {
      const observed = sameOriginHttpsUrl(observedUrl, expected);
      if (LOGIN_URL_PATTERN.test(observed.href)) {
        // Result URLs are diagnostics and their query values may already be
        // redacted as [VALUE]. Keep only the stable route when replaying them.
        observed.search = "";
        if (observed.hash.includes("?")) observed.hash = observed.hash.split("?", 1)[0];
        if (/\[VALUE\]/i.test(decodeURIComponent(observed.hash))) observed.hash = "";
        return observed.href;
      }
    } catch { /* invalid diagnostic URLs fall back to the conventional route */ }
  }
  return new URL("/login", expected).href;
}
