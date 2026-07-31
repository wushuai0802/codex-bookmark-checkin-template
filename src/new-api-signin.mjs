const DEFAULT_SIGN_IN_PATH = "/api/user/sign_in";
const DEFAULT_SELF_PATH = "/api/user/self";
const DEFAULT_STATUS_PATH = "/api/status";
const DEFAULT_LOG_PATH = "/api/log/self";

function sameOriginHttpsUrl(origin, value, field) {
  const expected = new URL(origin);
  if (expected.protocol !== "https:" || expected.username || expected.password) {
    throw new Error(`${field} 的目标站点必须是无凭据 HTTPS 地址`);
  }
  const resolved = new URL(String(value || "/"), expected.origin);
  if (resolved.protocol !== "https:" || resolved.origin !== expected.origin || resolved.username || resolved.password) {
    throw new Error(`${field} 必须是目标站点的无凭据同源 HTTPS 地址`);
  }
  return resolved.href;
}

function requiredShortText(value, field, origin) {
  const text = String(value || "").trim();
  if (!text || text.length > 120 || /[\r\n]/.test(text)) {
    throw new Error(`New API sign_in ${field} 无效：${origin}`);
  }
  return text;
}

export function configuredNewApiSignInRule(origin, config = {}) {
  const expectedOrigin = new URL(origin).origin;
  const raw = config.newApiSignInRules?.[expectedOrigin];
  if (!raw) return null;

  const rewardAmount = Number(raw.rewardAmount);
  const logType = Number(raw.logType);
  if (!Number.isFinite(rewardAmount) || rewardAmount <= 0) {
    throw new Error(`New API sign_in rewardAmount 无效：${expectedOrigin}`);
  }
  if (!Number.isInteger(logType) || logType < 0 || logType > 100) {
    throw new Error(`New API sign_in logType 无效：${expectedOrigin}`);
  }

  const userStorageKeys = raw.userStorageKeys ?? ["user"];
  if (!Array.isArray(userStorageKeys) || userStorageKeys.length === 0 || userStorageKeys.length > 8
    || userStorageKeys.some((key) => !String(key).trim() || String(key).length > 80 || /[\r\n]/.test(String(key)))) {
    throw new Error(`New API sign_in userStorageKeys 无效：${expectedOrigin}`);
  }

  return {
    origin: expectedOrigin,
    signInUrl: sameOriginHttpsUrl(expectedOrigin, raw.signInPath || DEFAULT_SIGN_IN_PATH, "signInPath"),
    selfUrl: sameOriginHttpsUrl(expectedOrigin, raw.selfPath || DEFAULT_SELF_PATH, "selfPath"),
    statusUrl: sameOriginHttpsUrl(expectedOrigin, raw.statusPath || DEFAULT_STATUS_PATH, "statusPath"),
    logUrl: sameOriginHttpsUrl(expectedOrigin, raw.logPath || DEFAULT_LOG_PATH, "logPath"),
    responseSuccessText: requiredShortText(raw.responseSuccessText, "responseSuccessText", expectedOrigin),
    logSuccessText: requiredShortText(raw.logSuccessText, "logSuccessText", expectedOrigin),
    rewardAmount,
    logType,
    userStorageKeys: userStorageKeys.map((key) => String(key).trim()),
    emptySuccessMeansAlreadySigned: raw.emptySuccessMeansAlreadySigned === true,
  };
}

function amountMatches(value, expected) {
  const amount = Number(value);
  return Number.isFinite(amount) && Math.abs(amount - expected) < 0.000001;
}

function responseRewardAmount(message) {
  const match = String(message || "").match(/[＄$]\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

export function classifyNewApiSignInObservation(observed, rule) {
  if (!observed) return { status: "unconfirmed", reason: "New API sign_in 没有返回可验证结果" };
  if (observed.state === "user_id_missing") {
    return { status: "login_required", reason: "站点页面没有可用的登录用户状态，需要重新登录" };
  }
  if (observed.state === "user_id_ambiguous") {
    return { status: "unconfirmed", reason: "站点页面存在多个用户标识，已拒绝发送签到请求" };
  }
  if (observed.state === "unauthorized") {
    return { status: "login_required", reason: "站点认证接口确认会话已失效，需要重新登录" };
  }
  if (observed.state === "already_confirmed") {
    return {
      status: "already_signed",
      reason: `使用日志确认今日已获得签到额度 $${rule.rewardAmount}`,
      evidence: {
        source: "usage_log",
        createdAt: observed.rewardLogCreatedAt
          ? new Date(Number(observed.rewardLogCreatedAt) * 1000).toISOString()
          : undefined,
        rewardAmount: rule.rewardAmount,
      },
    };
  }
  if (observed.state !== "called") {
    return { status: "unconfirmed", reason: "New API sign_in 请求或验证接口异常，未判定为完成" };
  }

  const message = String(observed.responseMessage || "");
  if (observed.responseSuccess !== true) {
    if (/未登录|未登入|无权|未授权|unauthori[sz]ed|login required/i.test(message)) {
      return { status: "login_required", reason: "站点签到接口确认会话已失效，需要重新登录" };
    }
    if (/已签到|已簽到|already.+sign/i.test(message)) {
      return { status: "already_signed", reason: "站点签到接口明确确认今日已签到" };
    }
    if (/turnstile|hcaptcha|recaptcha|验证码|驗證碼|captcha|人机|人機/i.test(message)) {
      return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
    }
    return { status: "unconfirmed", reason: "站点签到接口未确认成功，未判定为完成" };
  }

  const sources = [];
  if (message.includes(rule.responseSuccessText)
    && amountMatches(responseRewardAmount(message), rule.rewardAmount)) {
    sources.push("sign_in_response");
  }
  if (amountMatches(observed.quotaDelta, rule.rewardAmount)) sources.push("quota_delta");
  if (observed.rewardLogAfter === true && observed.rewardLogBefore !== true) sources.push("usage_log");

  if (sources.length > 0) {
    return {
      status: "signed",
      reason: `签到接口确认完成，奖励额度 $${rule.rewardAmount}`,
      evidence: {
        sources,
        rewardAmount: rule.rewardAmount,
        createdAt: observed.rewardLogCreatedAt
          ? new Date(Number(observed.rewardLogCreatedAt) * 1000).toISOString()
          : undefined,
      },
    };
  }

  if (rule.emptySuccessMeansAlreadySigned
    && Number(observed.signInStatus) === 200
    && message.trim() === ""
    && Number.isFinite(observed.quotaDelta)
    && Math.abs(observed.quotaDelta) < 0.000001) {
    return {
      status: "already_signed",
      reason: "签到接口返回站点约定的今日已领取响应，且认证有效、额度未重复增加",
      evidence: {
        source: "sign_in_already_claimed_contract",
        rewardAmount: rule.rewardAmount,
      },
    };
  }

  return {
    status: "unconfirmed",
    reason: "签到接口返回成功但没有奖励消息、额度变化或当日奖励日志，未判定为完成",
  };
}

export async function tryNewApiSignIn(page, origin, config = {}) {
  const rule = configuredNewApiSignInRule(origin, config);
  if (!rule) return null;

  const observed = await page.evaluate(async (activeRule) => {
    const findIds = () => {
      const ids = [];
      const extract = (value) => value?.id
        ?? value?.user?.id
        ?? value?.state?.user?.id
        ?? value?.data?.id
        ?? value?.data?.user?.id
        ?? null;
      for (const storage of [localStorage, sessionStorage]) {
        for (const key of activeRule.userStorageKeys) {
          try {
            const parsed = JSON.parse(storage.getItem(key) || "null");
            const id = extract(parsed);
            if (id != null) ids.push(String(id));
          } catch { /* ignore unrelated or malformed browser storage */ }
        }
      }
      return [...new Set(ids)];
    };

    const ids = findIds();
    if (ids.length === 0) return { state: "user_id_missing" };
    if (ids.length !== 1) return { state: "user_id_ambiguous" };
    const headers = { Accept: "application/json", "New-Api-User": ids[0] };

    const fetchJson = async (url, options = {}) => {
      try {
        const response = await fetch(url, { credentials: "include", ...options });
        const text = await response.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* invalid JSON is handled by the caller */ }
        return { ok: response.ok, status: response.status, body };
      } catch {
        return { ok: false, status: 0, body: null };
      }
    };

    const readSelf = async () => {
      const result = await fetchJson(activeRule.selfUrl, { headers });
      if ([401, 403].includes(result.status)) return { unauthorized: true, authenticated: false, quota: null };
      const message = String(result.body?.message || "");
      if (!result.ok || result.body?.success === false) {
        return {
          unauthorized: /未登录|未登入|无权|未授权|unauthori[sz]ed|login required/i.test(message),
          authenticated: false,
          quota: null,
        };
      }
      const quota = Number(result.body?.data?.quota ?? result.body?.data?.user?.quota);
      return { unauthorized: false, authenticated: true, quota: Number.isFinite(quota) ? quota : null };
    };

    const readQuotaPerUnit = async () => {
      const result = await fetchJson(activeRule.statusUrl, { headers: { Accept: "application/json" } });
      const value = Number(result.body?.data?.quota_per_unit ?? result.body?.data?.quotaPerUnit);
      return Number.isFinite(value) && value > 0 ? value : null;
    };

    const findRewardLog = async () => {
      const now = new Date();
      const startSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
      const endSeconds = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() / 1000);
      const amountPattern = /(?:增加额度|新增额度|获得额度|獲得額度)\s*[＄$]\s*([0-9]+(?:\.[0-9]+)?)/i;
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const endpoint = new URL(activeRule.logUrl);
        endpoint.searchParams.set("p", String(pageIndex));
        endpoint.searchParams.set("page_size", "100");
        endpoint.searchParams.set("type", String(activeRule.logType));
        endpoint.searchParams.set("token_name", "");
        endpoint.searchParams.set("model_name", "");
        endpoint.searchParams.set("start_timestamp", String(startSeconds));
        endpoint.searchParams.set("end_timestamp", String(endSeconds));
        endpoint.searchParams.set("group", "");
        const result = await fetchJson(endpoint.href, { headers });
        if ([401, 403].includes(result.status)) return { unauthorized: true, found: false };
        const items = result.body?.data?.items;
        if (!result.ok || !Array.isArray(items)) return { unauthorized: false, found: false };
        const match = items.find((item) => {
          const createdAt = Number(item?.created_at);
          const content = String(item?.content || "");
          const amount = Number(content.match(amountPattern)?.[1]);
          return Number(item?.type) === activeRule.logType
            && createdAt >= startSeconds
            && createdAt < endSeconds
            && content.includes(activeRule.logSuccessText)
            && Number.isFinite(amount)
            && Math.abs(amount - activeRule.rewardAmount) < 0.000001;
        });
        if (match) return { unauthorized: false, found: true, createdAt: Number(match.created_at) };
        if (items.length < 100) break;
      }
      return { unauthorized: false, found: false };
    };

    const before = await readSelf();
    if (before.unauthorized) return { state: "unauthorized" };
    if (!before.authenticated) return { state: "verification_failed" };
    const rewardLogBefore = await findRewardLog();
    if (rewardLogBefore.unauthorized) return { state: "unauthorized" };
    if (rewardLogBefore.found) {
      return { state: "already_confirmed", rewardLogCreatedAt: rewardLogBefore.createdAt };
    }
    const quotaPerUnit = await readQuotaPerUnit();

    const signIn = await fetchJson(activeRule.signInUrl, { method: "POST", headers });
    if ([401, 403].includes(signIn.status)) return { state: "unauthorized" };
    const after = await readSelf();
    if (after.unauthorized) return { state: "unauthorized" };
    if (!after.authenticated) return { state: "verification_failed" };
    const rewardLogAfter = await findRewardLog();
    if (rewardLogAfter.unauthorized) return { state: "unauthorized" };
    const rawDelta = before.quota != null && after.quota != null ? after.quota - before.quota : null;
    const quotaDelta = rawDelta == null
      ? null
      : (quotaPerUnit ? rawDelta / quotaPerUnit : rawDelta);

    return {
      state: "called",
      signInStatus: signIn.status,
      responseSuccess: signIn.body?.success === true,
      responseMessage: String(signIn.body?.message || "").slice(0, 200),
      quotaDelta,
      rewardLogBefore: rewardLogBefore.found,
      rewardLogAfter: rewardLogAfter.found,
      rewardLogCreatedAt: rewardLogAfter.createdAt ?? null,
    };
  }, rule);

  return classifyNewApiSignInObservation(observed, rule);
}
