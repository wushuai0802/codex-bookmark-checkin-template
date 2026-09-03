function sameOriginHttpsUrl(origin, value, field) {
  const expected = new URL(origin).origin;
  const url = new URL(String(value || "/"), `${expected}/`);
  if (url.protocol !== "https:" || url.origin !== expected || url.username || url.password) {
    throw new Error(`${field} must be a credential-free same-origin HTTPS URL`);
  }
  return url;
}

export function configuredProtectedCredentialApiRule(origin, config = {}) {
  const expected = new URL(origin).origin;
  const raw = config.protectedCredentialApiLoginRules?.[expected];
  if (!raw) return null;
  const storageKey = String(raw.userStorageKey || "user").trim();
  const userIdHeader = String(raw.userIdHeader || "New-Api-User").trim();
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(storageKey)) throw new Error(`Invalid userStorageKey: ${expected}`);
  if (!/^[A-Za-z0-9-]{1,80}$/.test(userIdHeader)) throw new Error(`Invalid userIdHeader: ${expected}`);
  return {
    loginUrl: sameOriginHttpsUrl(expected, raw.loginPath || "/api/user/login", "loginPath"),
    selfUrl: sameOriginHttpsUrl(expected, raw.selfPath || "/api/user/self", "selfPath"),
    storageKey,
    userIdHeader,
    turnstileQuery: raw.turnstileQuery === true,
  };
}

export function credentialApiUserData(body) {
  const raw = body?.data?.user ?? body?.data;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = raw.id ?? raw.user_id ?? null;
  if (id == null || !/^\d{1,20}$/.test(String(id))) return null;
  return { id: String(id), value: raw };
}

export function classifyCredentialApiLoginResponse({ statusCode, body }) {
  const message = String(body?.message ?? body?.error ?? "");
  if (/(密码错误|账号或密码|用户名或密码|invalid credentials|incorrect password)/i.test(message)) {
    return { status: "invalid_credential", diagnostic: "invalid_credential" };
  }
  if (/(二步|两步|二级验证|二級驗證|two[- ]?factor|\b2FA\b)/i.test(message)) {
    return { status: "needs_attention", failureCode: "two_factor_required" };
  }
  if (/(turnstile|hcaptcha|recaptcha|验证码|驗證碼|verify you are human|人机|人機)/i.test(message)) {
    return { status: "needs_attention", diagnostic: "interactive_challenge" };
  }
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    return { status: "failed", diagnostic: statusCode >= 500 ? "upstream_unavailable" : "login_http_error" };
  }
  if (body?.success !== true) return { status: "failed", diagnostic: "login_rejected" };
  if (!credentialApiUserData(body)) return { status: "failed", diagnostic: "login_response_shape" };
  return { status: "ready", diagnostic: null };
}

export function classifyCredentialApiSelfResponse({ statusCode, body, expectedUserId }) {
  const user = credentialApiUserData(body);
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    return { authenticated: false, diagnostic: "self_http_error" };
  }
  if (body?.success !== true || !user) return { authenticated: false, diagnostic: "self_rejected" };
  if (String(user.id) !== String(expectedUserId)) return { authenticated: false, diagnostic: "self_identity_mismatch" };
  return { authenticated: true, diagnostic: null };
}
