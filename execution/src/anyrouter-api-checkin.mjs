import https from "node:https";
import zlib from "node:zlib";
import vm from "node:vm";
import { resolveDynamicOriginRoutes } from "./origin-routing.mjs";
import { configuredNewApiSignInRule } from "./new-api-signin.mjs";

const DEFAULT_TIMEOUT_MS = 10000;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function validOrigin(value) {
  try {
    const origin = new URL(String(value)).origin;
    return origin === "https://anyrouter.top" ? origin : null;
  } catch { return null; }
}

function request(address, host, path, { sessionValue = "", requestHeaders = {}, method = "GET", body = "" } = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const request = https.request({
      hostname: address,
      port: 443,
      servername: host,
      method,
      path,
      headers: {
        Host: host,
        Accept: "application/json, text/plain, */*",
        "Accept-Encoding": "gzip",
        Connection: "close",
        ...(sessionValue ? { Cookie: sessionValue } : {}),
        ...requestHeaders,
        ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
      },
      rejectUnauthorized: true,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        let data = Buffer.concat(chunks);
        try {
          if (String(response.headers["content-encoding"] || "").toLowerCase().includes("gzip")) data = zlib.gunzipSync(data);
        } catch { /* retain the raw body for safe classification */ }
        resolve({
          status: response.statusCode ?? 0,
          body: data.toString(),
          setCookie: Array.isArray(response.headers["set-cookie"]) ? response.headers["set-cookie"] : [],
        });
      });
    });
    request.once("error", (error) => resolve({ status: 0, body: "", setCookie: [], error: error.code || error.message }));
    request.once("timeout", () => { request.destroy(); resolve({ status: 0, body: "", setCookie: [], error: "timeout" }); });
    if (body) request.write(body);
    request.end();
  });
}

function cookieJar(cookies = []) {
  const values = new Map();
  for (const cookie of cookies) values.set(cookie.name, cookie.value);
  return {
    update(setCookie = []) {
      for (const line of setCookie) {
        const match = /^([^=;]+)=([^;]*)/.exec(String(line));
        if (match) values.set(match[1], match[2]);
      }
    },
    header() { return [...values].map(([name, value]) => `${name}=${value}`).join("; "); },
  };
}

function solveEsaChallenge(body) {
  const script = /<script>([\s\S]*?)<\/script>/i.exec(body)?.[1] ?? "";
  const arg1 = /var arg1='([^']*)'/.exec(script)?.[1] ?? "";
  if (!script || !arg1) return null;
  let cookie = "";
  const document = {
    location: { reload() {} },
    set cookie(value) { cookie = String(value); },
    get cookie() { return cookie; },
  };
  const context = {
    document,
    window: null,
    location: document.location,
    navigator: { userAgent: "Mozilla/5.0", webdriver: false },
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  try { vm.runInNewContext(script, context, { timeout: 3000 }); } catch { return null; }
  const match = /^([^=;]+)=([^;]+)/.exec(cookie);
  return match ? { name: match[1], value: match[2] } : null;
}

function parseJson(response) {
  try { return JSON.parse(response.body); } catch { return null; }
}

async function requestWithChallenge(address, host, path, options, policy, jar) {
  let response = await request(address, host, path, { ...options, sessionValue: jar.header() }, policy.timeoutMs);
  jar.update(response.setCookie);
  const allowChallengeRetry = String(options.method || "GET").toUpperCase() !== "POST";
  for (let attempt = 0; allowChallengeRetry && attempt < 3 && /<script>/i.test(response.body); attempt += 1) {
    const solved = solveEsaChallenge(response.body);
    if (solved) jar.update([`${solved.name}=${solved.value}`]);
    response = await request(address, host, path, { ...options, sessionValue: jar.header() }, policy.timeoutMs);
    jar.update(response.setCookie);
  }
  return response;
}

function todayBounds() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  const start = Math.floor(new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`).getTime() / 1000);
  return { start, end: start + 86400 };
}

function quotaValue(body) {
  const value = Number(body?.data?.quota ?? body?.data?.user?.quota);
  return Number.isFinite(value) ? value : null;
}

function rewardLog(body, rewardAmount, logType, start, end) {
  const items = body?.data?.items;
  if (!Array.isArray(items)) return null;
  const found = items.find((item) => {
    const content = String(item?.content || "");
    const amount = Number(content.match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/)?.[1]);
    return Number(item?.type) === logType
      && Number(item?.created_at) >= start
      && Number(item?.created_at) < end
      && /每日签到成功|每日簽到成功/.test(content)
      && Number.isFinite(amount)
      && Math.abs(amount - rewardAmount) < 0.000001;
  });
  return found ? Number(found.created_at) : null;
}

export async function tryAnyRouterApiCheckin(page, config = {}, requestedOrigin = "") {
  const origin = validOrigin(requestedOrigin || page?.url?.() || "https://anyrouter.top/");
  if (!origin) return null;
  const rule = configuredNewApiSignInRule(origin, config);
  if (!rule) return null;
  const policy = { timeoutMs: Number(config.dynamicOriginRoutes?.[origin]?.timeoutMs) > 0
    ? Math.min(15000, Number(config.dynamicOriginRoutes[origin].timeoutMs)) : DEFAULT_TIMEOUT_MS };
  const routes = await resolveDynamicOriginRoutes(config);
  if (routes.length === 0) {
    return { status: "deferred", retryCause: "upstream_unavailable", failureCode: "dns_resolution_failed", reason: "AnyRouter 动态 DNS 未返回可用地址" };
  }
  let browserCookies = [];
  try { browserCookies = await page.context().cookies(origin); } catch { }
  const jar = cookieJar(browserCookies);
  let selected = null;
  let statusBody = null;
  let probeStatus = 0;
  for (const route of routes) {
    const probe = await requestWithChallenge(route.address, "anyrouter.top", "/api/status", {}, policy, jar);
    probeStatus = probe.status;
    const body = parseJson(probe);
    if (probe.status >= 200 && probe.status < 400 && body?.success === true) {
      selected = route.address;
      statusBody = body;
      break;
    }
    if (probe.status === 200 && /<script>/i.test(probe.body)) continue;
  }
  if (!selected) {
    return { status: "deferred", retryCause: "upstream_unavailable", failureCode: "tls_or_edge_unavailable", reason: "AnyRouter 候选线路均未通过严格 HTTPS/API 探测" };
  }
  const configuredUserId = String(
    config.anyRouterUserId
      ?? config.anyRouterUserIds?.[origin]
      ?? config.dynamicOriginRoutes?.[origin]?.userId
      ?? "",
  ).trim();
  const userId = configuredUserId || await page.evaluate(() => {
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        try {
          const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
          const id = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? value?.data?.user?.id;
          if (id != null) return String(id);
        } catch { }
      }
    }
    return null;
  }).catch(() => null);
  if (!userId || !/^\d{1,32}$/.test(userId)) return { status: "needs_attention", failureCode: "account_mismatch", reason: "AnyRouter 账号标识缺失或格式不符，已停止操作" };
  const userHeader = { "New-Api-User": userId };
  const selfResponse = await requestWithChallenge(selected, "anyrouter.top", "/api/user/self", { requestHeaders: userHeader }, policy, jar);
  const self = parseJson(selfResponse);
  if ([401, 403].includes(selfResponse.status) || self?.success !== true) return { status: "login_required", reason: "AnyRouter API 确认当前会话未登录" };
  if (String(self?.data?.id ?? "") !== userId) {
    return { status: "needs_attention", failureCode: "account_mismatch", reason: "AnyRouter 当前会话与配置账号不一致，已停止操作" };
  }
  const { start, end } = todayBounds();
  const rewardAmount = rule.rewardAmount;
  const quotaBefore = quotaValue(self);
  const logPath = new URL(rule.logUrl).pathname + "?p=0&page_size=100&type=" + rule.logType;
  const logResponse = await requestWithChallenge(selected, "anyrouter.top", logPath, { requestHeaders: userHeader }, policy, jar);
  const logBefore = parseJson(logResponse);
  const rewardBefore = rewardLog(logBefore, rewardAmount, rule.logType, start, end);
  if (rewardBefore != null) {
    return { status: "already_signed", reason: "AnyRouter 使用日志确认今日已获得 $25 额度", evidence: { source: "usage_log", authoritative: true, rewardAmount: 25 } };
  }
  const signResponse = await requestWithChallenge(selected, "anyrouter.top", new URL(rule.signInUrl).pathname, {
    method: "POST",
    requestHeaders: { ...userHeader, "Content-Type": "application/json" },
    body: "{}",
  }, policy, jar);
  const signBody = parseJson(signResponse);
  const signMessage = String(signBody?.message || "");
  if (signBody?.success === true && /签到成功|簽到成功/.test(signMessage) && new RegExp(`(?:＄|\\$)\\s*${rule.rewardAmount}(?:\\.0+)?`).test(signMessage)) {
    return { status: "signed", reason: `AnyRouter API 确认签到成功，获得 $${rule.rewardAmount} 额度`, evidence: { source: "sign_in_response", authoritative: true, rewardAmount: rule.rewardAmount } };
  }
  if (/已签到|已簽到|already/i.test(signMessage)) return { status: "already_signed", reason: "AnyRouter API 明确确认今日已签到" };
  if (signResponse.status === 401 || /未登录|未提供|无权/i.test(signMessage)) return { status: "login_required", reason: "AnyRouter API 确认当前会话未登录" };

  let after = null;
  let quotaAfter = null;
  let rewardAfter = null;
  for (let readbackAttempt = 0; readbackAttempt < 4; readbackAttempt += 1) {
    const afterResponse = await requestWithChallenge(selected, "anyrouter.top", new URL(rule.selfUrl).pathname, { requestHeaders: userHeader }, policy, jar);
    after = parseJson(afterResponse);
    quotaAfter = quotaValue(after);
    const logAfterResponse = await requestWithChallenge(selected, "anyrouter.top", logPath, { requestHeaders: userHeader }, policy, jar);
    rewardAfter = rewardLog(parseJson(logAfterResponse), rewardAmount, rule.logType, start, end);
    if (rewardAfter != null) break;
    if (readbackAttempt < 3) await wait(1000 * (readbackAttempt + 1));
  }
  if (rewardAfter != null) {
    return { status: "signed", reason: `AnyRouter 使用日志确认签到成功，获得 $${rewardAmount} 额度`, evidence: { source: "usage_log", authoritative: true, rewardAmount } };
  }
  const quotaDelta = quotaBefore != null && quotaAfter != null && Number(statusBody?.data?.quota_per_unit) > 0
    ? (quotaAfter - quotaBefore) / Number(statusBody.data.quota_per_unit)
    : (quotaBefore != null && quotaAfter != null ? quotaAfter - quotaBefore : null);
  if (rule.emptySuccessMeansAlreadySigned && signResponse.status === 200 && signBody?.success === true && signMessage.trim() === ""
    && Number.isFinite(quotaDelta) && Math.abs(quotaDelta) < 0.000001) {
    return {
      status: "already_signed",
      reason: "AnyRouter 返回空成功响应，且认证有效、额度未重复增加",
      evidence: { source: "sign_in_already_claimed_contract", authoritative: true, rewardAmount },
    };
  }
  return {
    status: "unconfirmed",
    reason: "AnyRouter API 返回结果但未取得明确奖励证据",
    evidence: {
      source: "sign_in_response",
      authoritative: false,
      probeStatus,
      selfStatus: selfResponse.status,
      logBeforeStatus: logResponse.status,
      signStatus: signResponse.status,
      signSuccess: signBody?.success === true,
      signMessageEmpty: signMessage.trim() === "",
      afterStatus: afterResponse.status,
      logAfterStatus: logAfterResponse.status,
      rewardAfter: rewardAfter != null,
      quotaChanged: Number.isFinite(quotaDelta) && Math.abs(quotaDelta) > 0.000001,
    },
  };
}
