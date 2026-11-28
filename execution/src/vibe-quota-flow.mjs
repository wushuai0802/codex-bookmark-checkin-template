import { formatDailyReason } from "./detector.mjs";

export const VIBE_CLAIM_ORIGIN = "https://new.sharedchat.cc";
export const VIBE_CLAIM_PATH = "/frontend-api/vibe-code/codex/claim";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function detectActiveQuotaBenefit(page, activeOrigin, config, status = "already_signed") {
  if (!config.quotaRequestRules?.[activeOrigin]) return null;
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const claimButton = page.getByRole("button", { name: "领取 Codex 权益", exact: true });
  const claimButtonVisible = await claimButton.count() === 1 && await claimButton.isVisible().catch(() => false);
  if (!claimButtonVisible
    && /当前套餐\s*[-—:]?\s*Codex/i.test(bodyText)
    && /剩余(?:额度|額度)|下次重置|有效期/i.test(bodyText)
    && !/已过期|已過期/i.test(bodyText)) {
    return { status, reason: "Codex 权益已领取，页面显示有效套餐" };
  }
  return null;
}

export async function waitForActiveQuotaBenefit(page, activeOrigin, config, status = "already_signed", timeoutMs = 0) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const result = await detectActiveQuotaBenefit(page, activeOrigin, config, status);
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(500, deadline - Date.now()));
  } while (true);
}

export async function waitForQuotaRequestField(page, timeoutMs = 10000) {
  const selector = [
    'textarea:visible',
    'input[name*="reason" i]:visible',
    'input[name*="remark" i]:visible',
    'input[name*="message" i]:visible',
    'input[placeholder*="理由" i]:visible',
    'input[placeholder*="原因" i]:visible',
  ].join(", ");
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const fields = page.locator(selector);
    const count = await fields.count();
    if (count === 1) return fields;
    if (count > 1 || Date.now() >= deadline) return null;
    await sleep(Math.min(500, deadline - Date.now()));
  } while (true);
}

// The Vibe frontend confirms a claim only when code=1 and data.claimed=true.
// HTTP success or a visible "领取" button is not a claim receipt.
export function classifyVibeClaimResponse(value, httpStatus = 200, now = new Date(), { expectedAccountId } = {}) {
  if (httpStatus !== 200 || value?.code !== 1) return null;
  if (value?.data?.claimed === true) {
    const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
    const accountId = value?.data?.accountId ?? value?.data?.userId;
    if (expectedAccountId != null && accountId != null && String(expectedAccountId) !== String(accountId)) {
      return { status: "needs_attention", reason: "权益响应账号与执行账号不一致", failureCode: "account_mismatch", submissionAttempted: true, retryable: false };
    }
    return {
      status: "signed",
      reason: "Codex 权益接口确认今日领取成功",
      submissionAttempted: true,
      evidence: {
        source: "vibe_claim_response",
        authoritative: accountId != null && /^[0-9]{1,32}$/.test(String(accountId)),
        endpoint: VIBE_CLAIM_PATH,
        requestMethod: "POST",
        actionType: "daily_entitlement_claim",
        businessDate,
        statusSignal: "claimed_true",
        confirmedAt: now.toISOString(),
        ...(accountId == null ? {} : { accountId: String(accountId).slice(0, 120) }),
      },
    };
  }
  if (value?.data?.claimed === false) {
    return {
      status: "needs_attention",
      reason: "权益接口明确未批准本次领取；需检查站点限制",
      failureCode: "claim_not_granted",
      submissionAttempted: true,
      retryable: false,
    };
  }
  return null;
}

export async function tryQuotaRequestFlow(
  page,
  activeOrigin,
  config,
  { waitForField = waitForQuotaRequestField, waitForManagedChallenge } = {},
) {
  const rule = config.quotaRequestRules?.[activeOrigin];
  if (!rule) return null;
  const reason = formatDailyReason(String(rule.reason || "{date}正常使用服务，申请额度用于开发测试和日常体验，谢谢。"));
  const minimumLength = Math.max(10, Number(rule.minimumReasonLength) || 10);
  if ([...reason].length < minimumLength) throw new Error(`额度申请理由少于 ${minimumLength} 个字符`);
  let reasonFields = await waitForField(page);
  if (!reasonFields) {
    // A server-rendered claim button can precede its event handler. Only retry
    // opening the dialog, never a form submission with an unknown outcome.
    const claim = page.getByRole("button", { name: "领取 Codex 权益", exact: true });
    if (await claim.count() === 1 && await claim.isVisible().catch(() => false)) {
      await claim.click({ timeout: 10000 });
      reasonFields = await waitForField(page);
    }
  }
  if (!reasonFields) return null;
  await reasonFields.fill(reason);
  let submit = null;
  for (const label of ["领取", "領取", "提交申请", "确认申请", "确认提交", "提交", "确认"]) {
    const candidate = page.getByRole("button", { name: label, exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible().catch(() => false)) { submit = candidate; break; }
    const input = page.locator(`input[type="submit"][value="${label}"], input[type="button"][value="${label}"]`);
    if (await input.count() === 1 && await input.isVisible().catch(() => false)) { submit = input; break; }
  }
  if (!submit) return { status: "needs_attention", reason: "已填写额度申请理由，但未找到提交按钮" };
  // Register before the click: the Vibe API response can arrive before the
  // page's toast is rendered. Observe only the exact same-origin claim call.
  const claimResponse = activeOrigin === VIBE_CLAIM_ORIGIN && typeof page.waitForResponse === "function"
    ? page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return url.origin === activeOrigin && url.pathname === VIBE_CLAIM_PATH
          && response.request().method() === "POST";
      } catch { return false; }
    }, { timeout: 12000 }).catch(() => null)
    : null;
  // A click timeout can occur after the browser has sent the request. Treat it
  // as an unknown submission unless the exact claim response proves otherwise.
  const clickFailed = await submit.click({ timeout: 10000 }).then(() => false, () => true);
  let claimResult = null;
  if (claimResponse) {
    const response = await claimResponse;
    if (response) {
      const payload = await response.json().catch(() => null);
      claimResult = classifyVibeClaimResponse(payload, response.status(), new Date(), {
        expectedAccountId: config.oauthAccountIdentities?.[activeOrigin]?.accountId,
      });
    }
  }
  if (claimResult) return claimResult;
  if (clickFailed) {
    return {
      status: "needs_attention",
      reason: "额度申请提交动作结果不明，已停止重复提交",
      failureCode: "submission_outcome_unknown",
      submissionAttempted: true,
      retryable: false,
    };
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  if (typeof waitForManagedChallenge === "function") {
    const state = await waitForManagedChallenge(page, config);
    if (["signed", "already_signed"].includes(state.status)) return state;
  }
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/(额度申请已提交|申请额度成功|额度已发放|额度申请成功|申请成功.*额度|今日已申请|今天已申请|codex\s*(?:权益|權益)\s*已(?:领取|領取)|(?:领取|領取)\s*codex\s*(?:权益|權益)\s*成功)/i.test(bodyText)) {
    return { status: "signed", reason: "额度申请已提交并获得页面确认" };
  }
  const activeBenefit = await detectActiveQuotaBenefit(page, activeOrigin, config, "signed");
  if (activeBenefit) return activeBenefit;
  return {
    status: "needs_attention",
    reason: "额度申请已提交，但站点未提供可确认的结果",
    failureCode: "submission_outcome_unknown",
    submissionAttempted: true,
    retryable: false,
  };
}
