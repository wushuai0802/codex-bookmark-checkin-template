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

const LOGIN_URL_PATTERN = /\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)|#\/(?:log[-_]?in|sign[-_]?in)(?:[/?#]|$)/i;

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
  return {
    succeeded: status === "logged_in",
    status,
    diagnostic: messages[status] ?? messages.failed,
  };
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
