import { isCredentialLoginRoute } from "./url-routes.mjs";
import { classifyPageText } from "./detector.mjs";

const LOGGED_OUT_TEXT = /(?:未登录|尚未登录|请先登录|請先登入|必须登录后|必須登入後|登录后(?:才|方|可)|登入後(?:才|方|可)|not logged in|sign in to continue|login required|authentication required)/i;
const CHALLENGE_TEXT = /(?:Just a moment|正在进行安全验证|Performing security verification|当前环境正在被调试|verify you are human)/i;

export function credentialVerificationUrl(originValue, verificationPath) {
  const origin = new URL(originValue).origin;
  const raw = String(verificationPath ?? "").trim();
  if (!raw) throw new Error("受保护登录必须配置权威验证路径");
  const url = new URL(raw, `${origin}/`);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
    throw new Error("登录验证端点必须是同源 HTTPS 地址");
  }
  return url;
}

export function classifyCredentialVerification({
  expectedOrigin,
  finalUrl,
  statusCode,
  passwordVisible,
  bodyText,
}) {
  let location;
  try { location = new URL(finalUrl); }
  catch { return { authenticated: false, failureCode: "invalid_final_url" }; }
  const text = String(bodyText ?? "");
  if (location.protocol !== "https:" || location.origin !== new URL(expectedOrigin).origin) {
    return { authenticated: false, failureCode: "cross_origin" };
  }
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 400) {
    return { authenticated: false, failureCode: "verification_http_error" };
  }
  if (isCredentialLoginRoute(location.href)) {
    return { authenticated: false, failureCode: "login_route" };
  }
  if (passwordVisible) return { authenticated: false, failureCode: "password_form" };
  if (CHALLENGE_TEXT.test(text)) return { authenticated: false, failureCode: "challenge" };
  if (LOGGED_OUT_TEXT.test(text)) return { authenticated: false, failureCode: "logged_out_text" };
  if (text.trim().length < 20) return { authenticated: false, failureCode: "empty_page" };
  const pageState = classifyPageText({ url: location.href, bodyText: text, hasPassword: false });
  const dailyCheckin = ["signed", "already_signed"].includes(pageState.status)
    ? {
      status: pageState.status,
      reason: pageState.reason,
      evidence: { source: "credential_verification" },
    }
    : null;
  return { authenticated: true, failureCode: null, dailyCheckin };
}

export async function verifyCredentialSession(page, {
  origin,
  verificationPath,
  navigationTimeoutMs = 20000,
}) {
  const verificationUrl = credentialVerificationUrl(origin, verificationPath);
  const response = await page.goto(verificationUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  const bodyText = String(await page.locator("body").innerText().catch(() => ""));
  const passwordVisible = await page.locator('input[type="password"]:visible').count().catch(() => 0) > 0;
  const evidence = classifyCredentialVerification({
    expectedOrigin: origin,
    finalUrl: page.url(),
    statusCode: response?.status() ?? 0,
    passwordVisible,
    bodyText,
  });
  return {
    ...evidence,
    statusCode: response?.status() ?? 0,
    passwordVisible,
  };
}
