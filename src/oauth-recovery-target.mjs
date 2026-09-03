function canonicalHttpsOrigin(value, field) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`${field} 必须是 HTTPS origin`); }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${field} 必须是无凭据 HTTPS origin`);
  }
  return url.origin;
}

/**
 * Resolve an OAuth recovery alias without widening the bookmark navigation
 * boundary. A migrated site may authenticate on a related origin only when
 * that origin is already part of the bookmark target's explicit allowlist.
 */
export function resolveOAuthRecoveryTargetOrigin(requestedOrigin, config = {}, allowedOrigins = []) {
  const origin = canonicalHttpsOrigin(requestedOrigin, "OAuth 恢复来源");
  const configured = config.oauthRecoveryTargetOrigins?.[origin];
  if (!configured) return origin;

  const targetOrigin = canonicalHttpsOrigin(configured, `OAuth 恢复目标 ${origin}`);
  const allowed = new Set([origin]);
  for (const value of allowedOrigins ?? []) {
    allowed.add(canonicalHttpsOrigin(value, `书签允许来源 ${origin}`));
  }
  if (!allowed.has(targetOrigin)) {
    throw new Error(`OAuth 恢复目标不在书签允许来源中：${origin}`);
  }
  return targetOrigin;
}

export function trustedLinuxDoAuthorizeState(value) {
  let location;
  try { location = new URL(value); } catch { return ""; }
  if (location.origin !== "https://connect.linux.do" || location.pathname !== "/oauth2/authorize") return "";
  const state = String(location.searchParams.get("state") ?? "").trim();
  if (!state || state.length > 512 || /[\r\n]/.test(state)) return "";
  return state;
}

export function trustedLinuxDoAuthorizeRequest(value, requestedTargetOrigin) {
  let location;
  let redirect;
  try {
    location = new URL(value);
    redirect = new URL(String(location.searchParams.get("redirect_uri") ?? ""));
  } catch { return null; }
  const targetOrigin = canonicalHttpsOrigin(requestedTargetOrigin, "OAuth 回调目标");
  const state = trustedLinuxDoAuthorizeState(location.href);
  const clientId = String(location.searchParams.get("client_id") ?? "").trim();
  if (!state || !clientId || clientId.length > 200 || /[\r\n]/.test(clientId)) return null;
  if (location.searchParams.get("response_type") !== "code") return null;
  if (redirect.protocol !== "https:" || redirect.origin !== targetOrigin || redirect.username || redirect.password) return null;
  return { href: location.href, state };
}
