export function oauthAccountCheckinMode(value) {
  const mode = String(value ?? "oauth_relogin").trim();
  if (!["oauth_relogin", "new_api"].includes(mode)) throw new Error("Invalid OAuth account checkinMode");
  return mode;
}

export async function checkNewApiAccount(page, origin, accountId, { submit = true } = {}) {
  if (new URL(origin).protocol !== "https:" || new URL(page.url()).origin !== new URL(origin).origin) {
    throw new Error("New API account check requires the configured HTTPS origin");
  }
  if (!/^[1-9][0-9]*$/.test(String(accountId))) throw new Error("Invalid expected New API account ID");
  return page.evaluate(async ({ expectedId, submit }) => {
    const failure = (status, reason, extra = {}) => ({ status, reason, ...extra });
    let requestId = expectedId;
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of ["user", "user_info", "userInfo", "current_user"]) {
        try {
          const value = JSON.parse(storage.getItem(key) || "null");
          const id = value?.id ?? value?.user?.id;
          if (id != null && /^[1-9][0-9]*$/.test(String(id))) requestId = String(id);
        } catch { /* Ignore unrelated storage. */ }
      }
    }
    const request = async (endpoint, method = "GET") => {
      try {
        const response = await fetch(endpoint, {
          method, credentials: "include", cache: "no-store", redirect: "error",
          headers: { Accept: "application/json", "New-Api-User": requestId },
          signal: AbortSignal.timeout(8000),
        });
        return { status: response.status, ok: response.ok, body: await response.json().catch(() => null) };
      } catch { return { status: 0, ok: false, body: null }; }
    };
    const identity = await request("/api/user/self");
    if ([401, 403].includes(identity.status)) return failure("login_required", "独立账号登录状态已失效");
    if (identity.status === 429) return failure("deferred", "账号接口触发限流", { retryCause: "rate_limit" });
    if (!identity.ok || identity.body?.success !== true || identity.body?.data?.id == null) {
      return failure("deferred", "账号身份接口暂不可用，未提交签到", { retryCause: "upstream_unavailable" });
    }
    if (String(identity.body.data.id) !== expectedId) {
      return failure("needs_attention", "登录账号与预期用户 ID 不一致，未提交签到", { failureCode: "account_mismatch", retryable: false });
    }
    requestId = expectedId;
    const now = new Date();
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(now);
    const endpoint = `/api/user/checkin?month=${today.slice(0, 7)}`;
    const proof = (result) => {
      if (!result.ok || result.body?.success !== true) return null;
      const stats = result.body?.data?.stats;
      if (stats?.checked_in_today !== true || !Array.isArray(stats.records)) return null;
      const record = stats.records.find((item) => item.checkin_date === today
        && (item.user_id == null || String(item.user_id) === expectedId));
      if (!record || record.quota_awarded == null || !Number.isFinite(Number(record.quota_awarded))
        || Number(record.quota_awarded) < 0) return null;
      return {
        source: "new_api_checkin_calendar", authoritative: true, accountId: expectedId,
        checkinDate: today, quotaAwarded: Number(record.quota_awarded), confirmedAt: new Date().toISOString(),
      };
    };
    const before = await request(endpoint);
    const existing = proof(before);
    if (existing) return { status: "already_signed", reason: "账号身份及今日签到记录均已确认", evidence: existing };
    if (before.status === 429) return failure("deferred", "签到状态接口触发限流", { retryCause: "rate_limit" });
    if ([401, 403].includes(before.status)) return failure("login_required", "签到会话已失效");
    if (before.ok && before.body?.success === true && before.body?.data?.enabled === false) {
      return failure("not_available", "站点签到功能未启用", {
        availabilityKind: "feature_disabled",
        evidence: { source: "new_api_checkin_status", authoritative: true, accountId: expectedId, confirmedAt: now.toISOString() },
      });
    }
    if (!before.ok || before.body?.success !== true || before.body?.data?.stats?.checked_in_today !== false) {
      return failure("deferred", "未取得一致的今日签到状态，未重复提交", { retryCause: "upstream_unavailable" });
    }
    if (!submit) return failure("not_signed", "今日尚未签到");

    // Submit once, including on transport failure; only read back afterwards.
    const action = await request("/api/user/checkin", "POST");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const after = await request(endpoint);
      const evidence = proof(after);
      if (evidence) {
        const accountAfter = await request("/api/user/self");
        if (accountAfter.ok && accountAfter.body?.success === true && String(accountAfter.body?.data?.id) === expectedId) {
          return { status: action.ok && action.body?.success === true ? "signed" : "already_signed",
            reason: "签到提交后回读账号身份及今日奖励记录确认成功", evidence };
        }
        break;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return failure("needs_attention", "签到已提交，但回读未确认，禁止重复提交", {
      failureCode: "submission_outcome_unknown", submissionAttempted: true, retryable: false,
    });
  }, { expectedId: String(accountId), submit });
}
