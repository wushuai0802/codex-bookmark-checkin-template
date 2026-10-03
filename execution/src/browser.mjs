import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { classifyPageText, formatDailyReason, isCheckinSingleChoiceChallenge, normalizeText, scoreActionText, ptPageEvidence } from "./detector.mjs";
export { ptPageEvidence } from "./detector.mjs";
import { assertBookmarkNavigation, safeErrorMessage, safeLogUrl } from "./security.mjs";
import { newApiCaptchaCandidates, recognizeNewApiCaptcha, recognizeNexusCaptcha, recognizeOpenCdCaptcha } from "./captcha-ocr.mjs";
import { solveU2VisualChallenge } from "./u2-vision.mjs";
import { resolveQaByWebSearch } from "./qa-solver.mjs";
import { withRetrySchedule } from "./retry-policy.mjs";
import { tryOAuthReloginCheckinStatus } from "./oauth-relogin-checkin.mjs";
import { tryOAuthApiCheckin } from "./oauth-api-checkin.mjs";
import { tryNewApiCaptchaCheckin, tryNewApiSignIn } from "./new-api-signin.mjs";
import { isTerminalResult } from "./result-contract.mjs";
import { applyOptionalBaiduSecondOpinion } from "./baidu-ocr.mjs";
import { tryAnyRouterApiCheckin } from "./anyrouter-api-checkin.mjs";
import { checkHarvestPtBeforeWrite, isPtExecutionTarget } from "./harvest-pt-gate.mjs";
import { guardPtSubmission, knownPtDialogOpener } from './pt-submission-guard.mjs';
import {ptReadPolicies} from './checkin-contract.generated.mjs';
import {ptReadPolicy,readPtPassivePage,ptReadProxy} from './pt-read-policy.mjs';
import {initialPtObservation} from './pt-initial-observation.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const CHALLENGE = new Set(["interactive_challenge", "managed_challenge_timeout"]);
const UNCONFIRMED = new Set(["visited", "clicked"]);
const VIBE_CLAIM_ORIGIN = "https://new.sharedchat.cc";
const VIBE_CLAIM_PATH = "/frontend-api/vibe-code/codex/claim";
const CANDIDATE_STATUS_PRIORITY = new Map([
  ["signed", 100],
  ["already_signed", 100],
  ["not_available", 95],
  ["needs_attention", 90],
  ["login_required", 85],
  ["interactive_challenge", 84],
  ["managed_challenge_timeout", 83],
  ["managed_challenge", 82],
  ["deferred", 80],
  ["unconfirmed", 70],
  ["clicked", 65],
  ["visited", 60],
  ["error", 30],
  ["no_action", 20],
]);
// NexusPHP uses this table for ordinary attendance forms too. Ignore only
// the layout container; real challenge controls inside still match below.
export const CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, [data-cap-api-endpoint], [class*="captcha" i]:not(table.attendance-captcha-table)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function preferCandidateResult(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentPriority = current.status === "not_available" && !isTerminalResult(current)
    ? 0
    : CANDIDATE_STATUS_PRIORITY.get(current.status) ?? 0;
  const candidatePriority = candidate.status === "not_available" && !isTerminalResult(candidate)
    ? 0
    : CANDIDATE_STATUS_PRIORITY.get(candidate.status) ?? 0;
  return candidatePriority > currentPriority ? candidate : current;
}

export function configuredTargetSkip(target, config = {}) {
  const originDisabled = (config.disabledCheckinOrigins ?? []).includes(target?.origin);
  const accountKey = String(target?.accountKey ?? '').trim();
  const handoffDisabled = config.executionEngine !== 'v1' && accountKey &&
    (config.disabledAccountBindings ?? []).some((item) => item?.accountKey === accountKey && item?.origin === target?.origin);
  const accountDisabled = Boolean(accountKey && (handoffDisabled || (config.disabledAccountKeys ?? []).includes(accountKey)));
  if (!originDisabled && !accountDisabled) return null;

  const v2Evidence = handoffDisabled
    ? config.v2AuthoritativeResults?.[`${String(target?.origin ?? '')}|${accountKey}`]
    : null;
  if (v2Evidence?.v2Owned === true && ["signed", "already_signed"].includes(v2Evidence.status)) {
    return {
      ...v2Evidence,
      accountKey,
      disabledByAccountConfig: true,
      disabledAccountKey: accountKey,
    };
  }

  const reason = accountDisabled && !originDisabled
    ? handoffDisabled ? `已按 V2 交接标记停用账号 ${accountKey} 的旧签到任务` : '已按配置取消该账号签到任务'
    : '已按配置取消该站签到任务';
  return {
    status: "not_available",
    reason,
    url: target.origin,
    disabledByConfig: originDisabled,
    disabledByAccountConfig: Boolean(accountDisabled),
    disabledAccountKey: accountDisabled ? accountKey : undefined,
    availabilityKind: "task_disabled",
    evidence: {
      source: "configuration",
      authoritative: true,
      confirmedAt: new Date().toISOString(),
    },
  };
}

export function configuredLoginCompletion(activeOrigin, config = {}) {
  if (!(config.loginAsCheckinOrigins ?? []).includes(activeOrigin)) return null;
  return {
    status: "signed",
    reason: "站点登录成功，按配置视为签到完成",
  };
}

export function turnstileWaitMs(config = {}) {
  const configured = Number(config.cloudflareWaitMs);
  const value = Number.isFinite(configured) && configured > 0 ? configured : 30000;
  return Math.max(5000, Math.min(120000, value));
}

export function candidateHistoryEntry(candidateUrl, result, attempt) {
  return {
    attempt,
    candidateUrl: safeLogUrl(candidateUrl),
    status: String(result?.status || "error"),
    reason: safeErrorMessage(result?.reason || "未知错误").slice(0, 240),
  };
}

function targetUsesConfiguredOrigins(target, configuredOrigins) {
  const configured = new Set(configuredOrigins ?? []);
  return (target.allowedOrigins ?? [target.origin]).some((origin) => configured.has(origin));
}

export function shouldTryGenericNewApiCheckin(target, configuredOrigins = null) {
  // These tracker targets retain historical "公益站" plan labels for
  // fingerprint compatibility. Folder metadata must not trigger a generic
  // New API action against a PT tracker.
  if (["https://bmapi.020212.xyz", "https://open.cd", "https://ptsbao.club"].includes(target?.origin)) return false;
  if (target?.folderNames?.includes("公益站")) return true;
  const configured = new Set(configuredOrigins ?? []);
  return (target?.allowedOrigins ?? [target?.origin]).some((origin) => configured.has(origin));
}

async function snapshotState(page) {
  const state = await page.evaluate((challengeSelector) => {
    const bodyText = String(document.body?.innerText ?? "").slice(0, 30000);
    const passwordInputs = [...document.querySelectorAll('input[type="password"]')]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    const challengeSelectors = [...document.querySelectorAll(challengeSelector)].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }) || document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]') !== null;
    return { bodyText, passwordInputs, challengeSelectors };
  }, CHALLENGE_SELECTOR);
  return classifyPageText({
    url: page.url(),
    title: await page.title(),
    bodyText: state.bodyText,
    hasPassword: state.passwordInputs,
    challengeSelectors: state.challengeSelectors,
  });
}

async function waitForManagedChallenge(page, config) {
  const deadline = Date.now() + config.cloudflareWaitMs;
  while (Date.now() < deadline) {
    const state = await snapshotState(page);
    if (state.status === "interactive_challenge") return state;
    if (state.status !== "managed_challenge") return state;
    await sleep(2000);
  }
  return withRetrySchedule({
    status: "deferred",
    retryCause: "managed_challenge_timeout",
    reason: "安全验证未自动通过，改为低频重试",
  }, {
    deferredRetryDelayMs: config.challengeRetryDelayMs ?? config.deferredRetryDelayMs,
  });
}

async function acceptConfiguredTerms(page, state, activeOrigin, config) {
  if (state.status !== "login_required"
    || !(config.autoAcceptUpdatedTermsOrigins ?? []).includes(activeOrigin)) return state;
  const bodyText = String(await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""));
  if (!/服务条款已.*更新|继续使用服务之前.*同意|同意并继续/.test(bodyText)) return state;
  const acceptButton = page.locator("button").filter({ hasText: /^\s*同意并继续\s*$/ });
  if (await acceptButton.count() !== 1 || !await acceptButton.isVisible().catch(() => false)) return state;
  await acceptButton.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  const acceptedState = await snapshotState(page);
  return acceptedState.status === "login_required"
    ? { ...acceptedState, reason: "已同意新版服务条款，继续执行自动登录" }
    : acceptedState;
}

export async function tryBmapiCheckinStatus(page, activeOrigin, successStatus = "already_signed") {
  if (activeOrigin !== "https://bmapi.020212.xyz") return null;
  const endpoint = `${activeOrigin}/api/v1/checkin/status?timezone=Asia%2FShanghai`;
  let response = null;
  try {
    const context = typeof page.context === "function" ? page.context() : null;
    let authToken = null;
    if (typeof context?.storageState === "function") {
      const storage = await context.storageState();
      authToken = storage.origins?.find((item) => item.origin === activeOrigin)?.localStorage
        ?.find((item) => item.name === "auth_token")?.value ?? null;
    }
    const request = context?.request;
    if (request?.get) {
      const headers = { accept: "application/json", ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) };
      const value = await request.get(endpoint, { headers });
      response = { ok: value.ok(), status: value.status(), body: await value.json() };
    }
  } catch {
    response = null;
  }
  response ??= await page.evaluate(async () => {
    try {
      const value = await fetch("/api/v1/checkin/status?timezone=Asia%2FShanghai", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      return { ok: value.ok, status: value.status, body: await value.json() };
    } catch {
      return null;
    }
  }).catch(() => null);
  if (!response?.ok || response.body?.code !== 0 || !response.body?.data) return null;
  const data = response.body.data;
  if (data.enabled === false) {
    return {
      status: "not_available",
      reason: "斑马 API 签到接口确认未启用",
      availabilityKind: "feature_disabled",
      evidence: {
        source: "bmapi_checkin_status",
        outcome: "enabled_false",
        authoritative: true,
        confirmedAt: new Date().toISOString(),
      },
    };
  }
  if (data.checked_in === true) {
    return {
      status: successStatus,
      reason: successStatus === "signed"
        ? "斑马 API 接口确认签到成功"
        : "斑马 API 接口确认今天已经签到",
    };
  }
  return { status: "ready", reason: "斑马 API 接口确认今日尚未签到" };
}

async function classifyManualAttention(page, state, activeOrigin, config) {
  if (state.status === "interactive_challenge"
    && (config.autoClickTurnstileOrigins ?? []).includes(activeOrigin)) {
    const response = page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
    const waitMs = turnstileWaitMs(config);
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    const passiveGraceMs = Math.min(8000, Math.max(2000, Math.floor(waitMs / 6)));
    let widgetInteractionAttempted = false;
    while (Date.now() < deadline) {
      const token = await response.first().inputValue({ timeout: 1000 }).catch(() => "");
      if (token.length > 20) {
        await sleep(1000);
      }
      // Turnstile normally resolves by itself in a real browser.  Give it a
      // passive grace period first, then make at most one bounded interaction.
      // Repeated clicks while it says "正在验证" can invalidate the attempt.
      if (token.length <= 20
        && !widgetInteractionAttempted
        && Date.now() - startedAt >= passiveGraceMs) {
        widgetInteractionAttempted = true;
        let clickAttempted = false;
        for (const frame of page.frames()) {
          const checkbox = frame.locator('#checkbox, input[type="checkbox"], [role="checkbox"]').first();
          if (await checkbox.count().catch(() => 0) === 1 && await checkbox.isVisible().catch(() => false)) {
            clickAttempted = await checkbox.click({ timeout: 5000 }).then(() => true).catch(() => false);
            if (clickAttempted) break;
          }
        }
        if (!clickAttempted) {
          const widgetSurface = page.locator(
            '.turnstile-container iframe, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i], .turnstile-container',
          ).first();
          const box = await widgetSurface.boundingBox().catch(() => null);
          if (box && box.width >= 250 && box.height >= 50) {
            clickAttempted = await page.mouse.click(box.x + 25, box.y + box.height / 2)
              .then(() => true).catch(() => false);
          }
        }
      }
      const apiStatus = await tryBmapiCheckinStatus(page, activeOrigin, "signed");
      if (apiStatus && apiStatus.status !== "ready") return apiStatus;
      const refreshed = await snapshotState(page);
      if (["signed", "already_signed", "login_required", "deferred", "not_available"].includes(refreshed.status)) {
        return refreshed;
      }
      await sleep(1000);
    }
    return {
      status: "deferred",
      retryCause: "managed_challenge_timeout",
      reason: `Turnstile 自动验证未在 ${Math.ceil(waitMs / 1000)} 秒内完成，已安排低频重试`,
    };
  }
  if (state.status === "interactive_challenge"
    && ((config.manualChallengeOrigins ?? []).includes(activeOrigin)
      || (config.autoClickHcaptchaOrigins ?? []).includes(activeOrigin))) {
    if ((config.autoClickHcaptchaOrigins ?? []).includes(activeOrigin)) {
      const response = page.locator('textarea[name="h-captcha-response"]');
      const checkbox = page.frameLocator('iframe[src*="hcaptcha" i]').locator("#checkbox");
      if (await checkbox.count().catch(() => 0) === 1 && await checkbox.isVisible().catch(() => false)) {
        await checkbox.click({ timeout: 10000 }).catch(() => {});
      }
      const deadline = Date.now() + Math.min(20000, Number(config.cloudflareWaitMs) || 20000);
      while (Date.now() < deadline) {
        const token = await response.inputValue({ timeout: 1000 }).catch(() => "");
        if (token.length > 20) return { status: "ready", reason: "hCaptcha 简单确认已自动通过" };
        await sleep(1000);
      }
    }
    return { status: "needs_attention", reason: "复杂视觉 hCaptcha 需要当次确认" };
  }
  return acceptConfiguredTerms(page, state, activeOrigin, config);
}

// A click is only an attempt.  Keep polling the same page until a stable
// business-level success signal appears.  This closes the historical gap where
// a button click or a visited /attendance.php URL was reported as completion.
export async function waitForAuthoritativeCheckin(page, activeOrigin, config = {}, options = {}) {
  const configured = Number(config.checkinConfirmationWaitMs);
  const waitMs = Math.max(3000, Math.min(30000, Number.isFinite(configured) ? configured : 15000));
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    const bmapi = await tryBmapiCheckinStatus(page, activeOrigin, "signed");
    if (bmapi && bmapi.status !== "ready") return bmapi;
    last = await snapshotStateAfterNavigation(page);
    if (last && ["signed", "already_signed", "not_available", "login_required", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(last.status)) {
      return last;
    }
    await sleep(500);
  }
  const submissionAttempted = options.submissionAttempted !== false;
  return {
    status: "needs_attention",
    reason: submissionAttempted
      ? "签到动作已提交，但在限定时间内未取得页面或接口的权威成功回读"
      : "签到页未提供可执行动作或权威状态，需补充站点适配器",
    failureCode: submissionAttempted ? "submission_outcome_unknown" : "authoritative_status_unavailable",
    submissionAttempted,
    retryable: false,
    ...(last ? { lastObservedStatus: last.status } : {}),
  };
}

export async function dismissBlockingModal(page, config) {
  const dismissed = [];
  const labels = ["标记已读", "今天关闭", "今日关闭", "不再提示", "我知道了", "知道了", "关闭"];
  for (let pass = 0; pass < 5; pass += 1) {
    let clicked = null;
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.count() > 0 && await button.first().isVisible().catch(() => false)) {
        await button.first().click({ timeout: 10000 });
        await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
        clicked = label;
        dismissed.push(label);
        break;
      }
    }
    if (!clicked) break;
  }
  return dismissed;
}

async function passLeichiConfirmation(page, config) {
  const button = page.locator("button#sl-check");
  const description = page.locator("#sl-text");
  if (await button.count() !== 1 || await description.count() !== 1) return null;
  const text = String(await description.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (!/客户端异常.*确认.*合法用户/.test(text) || !await button.isVisible()) return null;

  await button.click({ timeout: 10000 });
  const deadline = Date.now() + Math.min(config.cloudflareWaitMs, 30000);
  while (Date.now() < deadline) {
    await sleep(1000);
    if (await button.count() === 0 || !await button.isVisible().catch(() => false)) return { passed: true };
    const currentText = String(await description.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/失败|错误|异常/.test(currentText) && !/客户端异常.*确认.*合法用户/.test(currentText)) {
      return { passed: false, reason: currentText.slice(0, 200) };
    }
  }
  return { passed: false, reason: "雷池 WAF 合法用户确认等待超时" };
}

async function findCheckinAction(page, allowedOrigins, excludedAction = null) {
  const originSet = new Set(Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]);
  const raw = await page.locator('button, a, [role="button"], input[type="button"], input[type="submit"]').evaluateAll((elements) => {
    return elements.slice(0, 400).map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      const text = String(element.innerText || element.value || element.getAttribute("aria-label") || element.title || "")
        .replace(/\s+/g, " ").trim();
      return {
        index,
        text,
        visible,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        tagName: element.tagName,
        href: element instanceof HTMLAnchorElement ? element.href : null,
        formAction: element.form ? element.form.action : null,
      };
    });
  });

  return raw
    .map((candidate) => ({ ...candidate, score: scoreActionText(candidate.text) }))
    .filter((candidate) => candidate.visible && !candidate.disabled && candidate.score >= 0)
    .filter((candidate) => {
      if (!candidate.href) return true;
      try {
        const href = new URL(candidate.href);
        if (!originSet.has(href.origin)) return false;
        if (/(attendance|check[-_]?in|showup|bakatest|sign|签到|簽到|申请额度|申請額度)/i.test(href.href)) return true;
        if (/(?:领取|領取).*codex.*(?:权益|權益)|codex.*(?:权益|權益)/i.test(candidate.text)) return true;
        // Some NexusPHP trackers expose check-in as an onclick handler on a
        // same-page "#" link (for example onclick="signin(this)").  The
        // visible label remains the authoritative signal in that case.
        return candidate.href.endsWith("#") && /^(?:\[?\s*)?(?:签到|簽到)(?:\s*\]?)$/i.test(candidate.text);
      } catch {
        return false;
      }
    })
    .filter((candidate) => {
      if (!candidate.formAction) return true;
      try { return originSet.has(new URL(candidate.formAction).origin); } catch { return false; }
    })
    .filter((candidate) => !excludedAction || !(
      candidate.tagName === excludedAction.tagName
      && candidate.text === excludedAction.text
      && candidate.href === excludedAction.href
    ))
    .sort((a, b) => b.score - a.score)[0] ?? null;
}

async function clickCandidate(page, candidate) {
  const locator = page.locator('button, a, [role="button"], input[type="button"], input[type="submit"]').nth(candidate.index);
  await locator.click({ timeout: 10000 });
}

async function detectActiveQuotaBenefit(page, activeOrigin, config, status = "already_signed") {
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
export function classifyVibeClaimResponse(value, httpStatus = 200, now = new Date(), {expectedAccountId} = {}) {
  if (httpStatus !== 200 || value?.code !== 1) return null;
  if (value?.data?.claimed === true) {
    const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
    const accountId = value?.data?.accountId ?? value?.data?.userId;
    if(expectedAccountId!=null&&accountId!=null&&String(expectedAccountId)!==String(accountId))
      return {status:'needs_attention',reason:'权益响应账号与执行账号不一致',failureCode:'account_mismatch',submissionAttempted:true,retryable:false};
    return {
      status: "signed",
      reason: "Codex 权益接口确认今日领取成功",
      submissionAttempted: true,
      evidence: {
        source: "vibe_claim_response",
        authoritative: accountId!=null&&/^[0-9]{1,32}$/.test(String(accountId)),
        endpoint: VIBE_CLAIM_PATH,
        requestMethod: 'POST',
        actionType: 'daily_entitlement_claim',
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

export async function tryQuotaRequestFlow(page, activeOrigin, config, { waitForField = waitForQuotaRequestField } = {}) {
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
      claimResult = classifyVibeClaimResponse(payload, response.status(),new Date(),
        {expectedAccountId:config.oauthAccountIdentities?.[activeOrigin]?.accountId});
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
  const state = await waitForManagedChallenge(page, config);
  if (["signed", "already_signed"].includes(state.status)) return state;
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/(额度申请已提交|申请额度成功|额度已发放|额度申请成功|申请成功.*额度|今日已申请|今天已申请|codex\s*(?:权益|權益)\s*已(?:领取|領取)|(?:领取|領取)\s*codex\s*(?:权益|權益)\s*成功)/i.test(bodyText)) return { status: "signed", reason: "额度申请已提交并获得页面确认" };
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

async function findCheckinDiscoveryUrls(page, expectedOrigin) {
  const links = await page.locator("a[href]").evaluateAll((elements) => elements.slice(0, 300).map((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      href: element.href,
      text: String(element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
    };
  }));

  return links
    .filter((link) => link.visible && link.href)
    .map((link) => {
      try {
        const url = new URL(link.href);
        if (url.origin !== expectedOrigin) return null;
        let score = 0;
        if (/(立即签到|立即簽到|每日签到|每日簽到|签到中心|簽到中心|福利中心|任务中心|任務中心)/i.test(link.text)) score = 130;
        else if (/\/(check[-_]?in|daily[-_]?sign|attendance|welfare|rewards?)(?:[/?#]|$)/i.test(url.href)) score = 120;
        else if (/(个人设置|個人設置|个人资料|個人資料|个人中心|個人中心)/i.test(link.text)) score = 100;
        else if (/\/(profile|personal|account)(?:[/?#]|$)/i.test(url.href)) score = 90;
        else if (/(钱包|錢包|福利|奖励|獎勵)/i.test(link.text)) score = 85;
        else if (/\/(wallet|billing|setting|settings)(?:[/?#]|$)/i.test(url.href)) score = 80;
        else if (/(设置|設置)/i.test(link.text) && /\/(console|user)(?:[/?#]|$)/i.test(url.href)) score = 60;
        return score > 0 ? { href: url.href, score } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score)
    .filter((link, index, rows) => rows.findIndex((candidate) => candidate.href === link.href) === index)
    .slice(0, 8)
    .map((link) => link.href);
}

async function navigateDiscoveryUrl(page, candidateUrl, allowedOrigins, config) {
  const destination = assertBookmarkNavigation(candidateUrl, allowedOrigins);
  const links = page.locator("a[href]");
  const matches = await links.evaluateAll((elements, expected) => elements
    .map((element, index) => ({ index, href: element.href }))
    .filter((item) => item.href === expected), destination);
  if (matches.length === 1) {
    await links.nth(matches[0].index).click({ timeout: 10000 });
    await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
    return;
  }
  try {
    await page.goto(destination, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  } catch (error) {
    const current = assertBookmarkNavigation(page.url(), allowedOrigins);
    if (!/ERR_ABORTED/i.test(String(error?.message ?? error)) || new URL(current).origin !== new URL(destination).origin) {
      throw error;
    }
    await sleep(Math.max(500, Number(config.actionWaitMs) || 0));
  }
}

async function findMatchingQaRule(page, rules, origin) {
  const bodyText = normalizeText(await page.locator("body").innerText({ timeout: 5000 })).slice(0, 30000);
  return rules.find((rule) => {
    if (!rule || rule.origin !== origin || !rule.questionIncludes) return false;
    return bodyText.includes(String(rule.questionIncludes));
  }) ?? null;
}

async function applyQaRule(page, rule, config = {}) {
  if (!rule?.answerText || !rule?.submitText) return false;
  const answerText = normalizeText(rule.answerText);
  const radioOptions = await page.locator('input[type="radio"]').evaluateAll((elements) => elements.map((element, index) => {
    let siblingText = "";
    let sibling = element.nextSibling;
    while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
      siblingText += ` ${sibling.textContent || ""}`;
      sibling = sibling.nextSibling;
    }
    return { index, text: String(siblingText).replace(/\s+/g, " ").trim() };
  }));
  const matchingRadios = radioOptions.filter((option) => option.text === answerText);
  if (matchingRadios.length === 1) {
    await page.locator('input[type="radio"]').nth(matchingRadios[0].index).check();
  } else {
    const answer = page.getByText(answerText, { exact: true });
    if (await answer.count() !== 1) return false;
    await answer.click();
  }

  const submitText = normalizeText(rule.submitText);
  const submitInputs = await page.locator('input[type="submit"], button[type="submit"]').evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matchingSubmits = submitInputs.filter((option) => option.text === submitText);
  if (matchingSubmits.length === 1) {
    config.beforePtSubmit?.();
    await page.locator('input[type="submit"], button[type="submit"]').nth(matchingSubmits[0].index).click();
  } else {
    const submit = page.getByText(submitText, { exact: true });
    if (await submit.count() !== 1) return false;
    config.beforePtSubmit?.();
    await submit.click();
  }
  return true;
}

async function readSingleChoiceChallenge(page) {
  const radios = page.locator('input[type="radio"]');
  if (await radios.count() < 2) return null;
  const groups = await radios.evaluateAll((elements) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const grouped = new Map();
    for (const [index, element] of elements.entries()) {
      const container = element.closest("form") || element.closest("table") || element.parentElement;
      if (!container) continue;
      if (!grouped.has(container)) grouped.set(container, []);
      grouped.get(container).push({ element, index });
    }
    return [...grouped.entries()].map(([container, entries]) => {
      const options = entries.map(({ element, index }) => {
        let text = "";
        const label = element.closest("label")
          || (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null);
        if (label) text = label.innerText || label.textContent || "";
        if (!normalize(text)) {
          let sibling = element.nextSibling;
          while (sibling && sibling.nodeName !== "BR" && !(sibling instanceof HTMLInputElement)) {
            text += ` ${sibling.textContent || ""}`;
            sibling = sibling.nextSibling;
          }
        }
        return { index, text: normalize(text) };
      }).filter((option) => option.text);
      if (options.length < 2) return null;
      const contextText = normalize(container.innerText || container.textContent || "");
      const submitTexts = [...container.querySelectorAll('input[type="submit"], button[type="submit"], button')]
        .map((element) => normalize(element.value || element.innerText || element.textContent || ""))
        .filter(Boolean);
      let question = contextText;
      const firstOptionIndex = question.indexOf(options[0].text);
      if (firstOptionIndex > 0) question = question.slice(0, firstOptionIndex);
      const markers = [question.lastIndexOf("请问"), question.lastIndexOf("請問"), question.lastIndexOf("[单选]"), question.lastIndexOf("[單選]")];
      const marker = Math.max(...markers);
      if (marker >= 0) question = question.slice(marker);
      return {
        question: normalize(question).slice(-320),
        options: options.map((option) => option.text),
        contextText: contextText.slice(0, 2000),
        submitTexts,
      };
    }).filter(Boolean);
  });
  return groups.find(isCheckinSingleChoiceChallenge) ?? null;
}

async function clickQaChange(page, config) {
  const labels = config.qaChangeButtonTexts ?? ["仅可换一题", "僅可換一題", "换一题", "換一題"];
  const controls = page.locator('input[type="submit"], button');
  const values = await controls.evaluateAll((elements) => elements.map((element, index) => ({
    index,
    text: String(element.value || element.innerText || "").replace(/\s+/g, " ").trim(),
  })));
  const matches = values.filter((item) => labels.includes(item.text));
  if (matches.length !== 1) return false;
  await controls.nth(matches[0].index).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await sleep(1000);
  return true;
}

async function tryQaFlow(page, rules, origin, config) {
  const configuredChanges = Number(config.qaMaxQuestionChanges);
  const maxChanges = Math.max(0, Math.min(2, Number.isFinite(configuredChanges) ? configuredChanges : 1));
  for (let changeIndex = 0; changeIndex <= maxChanges; changeIndex += 1) {
    const challenge = await readSingleChoiceChallenge(page);
    if (!challenge) return null;

    let rule = await findMatchingQaRule(page, rules, origin);
    let source = rule ? (rule.source || "configured") : null;
    if (!rule) {
      const searched = await resolveQaByWebSearch(page, challenge.question, challenge.options, config);
      if (searched?.answer) {
        rule = { answerText: searched.answer, submitText: "提交" };
        source = searched.source;
      }
    }

    if (rule) {
      const applied = await applyQaRule(page, rule, config);
      if (!applied) {
        return { status: "interactive_challenge", reason: "已找到问答答案，但页面选项结构无法安全提交" };
      }
      await sleep(config.actionWaitMs);
      const state = await waitForManagedChallenge(page, config);
      const verified = ["signed", "already_signed"].includes(state.status);
      return {
        ...(verified ? state : { status: "interactive_challenge", reason: "问答答案已提交，但页面未确认签到成功" }),
        qa: {
          question: challenge.question,
          answer: String(rule.answerText),
          submitText: String(rule.submitText || "提交"),
          source,
          verified,
        },
      };
    }

    if (changeIndex < maxChanges && await clickQaChange(page, config)) continue;
    return {
      status: "interactive_challenge",
      reason: `遇到未知站内问答：${challenge.question.slice(0, 120)}`,
    };
  }
  return null;
}

export async function tryNewApiCheckin(page) {
  return page.evaluate(async () => {
    // New API installations authenticate API calls with a short-lived Bearer
    // token.  The login page stores the user summary in localStorage, but the
    // token intentionally remains in memory; after a worker restart the
    // `new_api_has_session` cookie only tells the frontend to call the refresh
    // endpoint.  Calling `/api/user/checkin` with only `New-Api-User` therefore
    // returns 401 even though the browser UI looks logged in.  Recreate that
    // frontend bootstrap here and use the returned token for this one bounded
    // status/action sequence.
    const parseResponse = async (response) => {
      let body = null;
      let challenge = false;
      if (typeof response?.text === "function") {
        const text = await response.text().catch(() => "");
        try { body = JSON.parse(text); } catch { /* non-JSON or challenge */ }
        challenge = !body && /<(?:!doctype|html|title)\b/i.test(text)
          && /Just a moment|cf-chl-|challenge-platform|Verify you are human|Attention Required/i.test(text);
      } else if (typeof response?.json === "function") {
        // Keep the helper testable with the minimal Response doubles used by
        // the offline suite, while real Chromium responses use text() above.
        body = await response.json().catch(() => null);
      }
      return { status: Number(response?.status ?? 0), body, challenge };
    };
    const request = async (url, options = {}) => {
      try {
        const response = await fetch(url, {
          credentials: "include",
          redirect: "error",
          ...options,
        });
        return await parseResponse(response);
      } catch {
        return { status: 0, body: null, networkError: true };
      }
    };
    const userIdFrom = (value) => value?.id ?? value?.user?.id ?? value?.state?.user?.id
      ?? value?.data?.id ?? value?.data?.user?.id ?? null;
    let userId = null;
    const storages = [localStorage, sessionStorage];
    for (const storage of storages) {
      for (let index = 0; index < storage.length; index += 1) {
        try {
          const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
          userId = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? null;
          if (userId != null) break;
        } catch { /* continue */ }
      }
      if (userId != null) break;
    }
    if (userId == null) {
      const visibleId = String(document.body?.innerText || "").match(/(?:用户\s*)?ID\s*[:：]?\s*(\d+)/i);
      userId = visibleId?.[1] ?? null;
    }
    if (userId == null) {
      try {
        const response = await request("/api/user/self", { headers: { Accept: "application/json" } });
        userId = userIdFrom(response.body);
      } catch { /* not a compatible API */ }
    }

    let accessToken = null;
    let tokenType = "Bearer";
    let refreshedIdentity = null;
    // Refresh is a read-only authentication rotation.  It is deliberately
    // attempted once per page and never used as a check-in/action retry.
    const refresh = await request("/api/user/auth/refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (refresh.status >= 200 && refresh.status < 300 && refresh.body?.success === true) {
      const bundle = refresh.body?.data;
      const candidateId = userIdFrom(bundle);
      const candidateToken = typeof bundle?.access_token === "string" ? bundle.access_token : "";
      if (candidateId != null && userId != null && String(candidateId) !== String(userId)) {
        return { status: "login_required", reason: "认证会话账号与页面身份不一致", submissionAttempted: false };
      }
      if (candidateToken) {
        accessToken = candidateToken;
        tokenType = bundle?.token_type === "Bearer" ? "Bearer" : "Bearer";
        refreshedIdentity = candidateId == null ? null : String(candidateId);
        userId = candidateId ?? userId;
      }
    }
    if (!accessToken && userId != null) {
      // A credential login may return its session beside a nested user and
      // persist it in browser storage. Verify that same user's saved token
      // before using it; an absent refresh cookie is not proof of logout.
      for (const storage of storages) {
        let stored;
        try { stored = JSON.parse(storage.getItem('user') || 'null'); } catch { continue; }
        if (String(userIdFrom(stored)) !== String(userId) || typeof stored?.access_token !== 'string' || !stored.access_token) continue;
        const verified = await request('/api/user/self', {headers: {Accept:'application/json',
          'New-Api-User':String(userId),Authorization:`Bearer ${stored.access_token}`}});
        if (verified.status >= 200 && verified.status < 300 && verified.body?.success === true &&
            String(userIdFrom(verified.body)) === String(userId)) {
          accessToken = stored.access_token;
          break;
        }
      }
    }
    if (userId == null && refreshedIdentity == null) return null;

    const headers = {
      Accept: "application/json",
      ...(userId == null ? {} : { "New-Api-User": String(userId) }),
      ...(accessToken ? { Authorization: `${tokenType} ${accessToken}` } : {}),
    };
    const currentDate = new Date();
    const month = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
    let statusResponse = await request(`/api/user/checkin?month=${month}`, { headers });
    const challengeResult=()=>({status:'interactive_challenge',failureCode:'managed_challenge',
      reason:'签到接口返回 Cloudflare 浏览器验证页，并非登录失效；未提交签到',submissionAttempted:false,retryableLoginRecovery:false});
    if(statusResponse.challenge)return challengeResult();
    // A refresh can race with another tab's rotation.  One fresh token is
    // enough; never re-submit the check-in action in this recovery branch.
    if ([401, 403].includes(statusResponse.status) && !accessToken) {
      const retryRefresh = await request("/api/user/auth/refresh", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const bundle = retryRefresh.body?.data;
      const candidateId = userIdFrom(bundle);
      const candidateToken = typeof bundle?.access_token === "string" ? bundle.access_token : "";
      if (retryRefresh.status >= 200 && retryRefresh.status < 300 && retryRefresh.body?.success === true && candidateToken) {
        if (candidateId != null && userId != null && String(candidateId) !== String(userId)) {
          return { status: "login_required", reason: "认证会话账号与页面身份不一致", submissionAttempted: false };
        }
        accessToken = candidateToken;
        tokenType = bundle?.token_type === "Bearer" ? "Bearer" : "Bearer";
        refreshedIdentity = candidateId == null ? null : String(candidateId);
        userId = candidateId ?? userId;
        headers["New-Api-User"] = String(userId ?? "");
        headers.Authorization = `${tokenType} ${accessToken}`;
        statusResponse = await request(`/api/user/checkin?month=${month}`, { headers });
      }
    }
    if (statusResponse.status === 404) return null;
    if(statusResponse.challenge)return challengeResult();
    const statusBody = statusResponse.body;
    if (!statusBody && statusResponse.status === 0) return null;
    if ([401, 403].includes(statusResponse.status)) {
      return { status: "login_required", reason: "签到接口拒绝当前登录会话", submissionAttempted: false };
    }
    if (statusResponse.status === 429) return { status: "deferred", retryCause: "rate_limit", reason: "签到接口请求受限" };
    if (statusResponse.status >= 500) return { status: "deferred", retryCause: "upstream_unavailable", reason: "签到接口服务暂时不可用" };
    if (statusResponse.status >= 400) return null;
    const message = String(statusBody?.message || "");
    if (!statusBody?.success) {
      if (/未启用|未啟用|not enabled/i.test(message)) {
        return {
          status: "not_available",
          reason: "站点签到功能未启用",
          availabilityKind: "feature_disabled",
          evidence: {
            source: "new_api_checkin_status",
            outcome: "message_not_enabled",
            authoritative: true,
            confirmedAt: new Date().toISOString(),
          },
        };
      }
      if (/turnstile|captcha|人机|人機/i.test(message)) {
        return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
      }
      return null;
    }
    const checked = Boolean(
      statusBody?.data?.stats?.checked_in_today
      ?? statusBody?.data?.checked_in_today
      ?? statusBody?.data?.checkedInToday
    );
    const businessDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
    if (checked) return { status: "already_signed", reason: "签到接口显示今日已签到",
      evidence:{source:'new_api_checkin_status',authoritative:true,accountId:String(userId),businessDate,
        statusSignal:'checked_in_today',confirmedAt:new Date().toISOString()} };

    const checkinResponse = await request("/api/user/checkin", { method: "POST", headers });
    if(checkinResponse.challenge)return {status:'needs_attention',failureCode:'submission_outcome_unknown',
      reason:'签到提交后返回浏览器验证页，结果不明，先只读核验',submissionAttempted:true,retryable:false};
    const checkinBody = checkinResponse.body;
    if (!checkinBody && checkinResponse.status === 0) return null;
    if ([401, 403].includes(checkinResponse.status)) {
      // The POST outcome is not safely replayable.  Leave it as a bounded
      // login/attention result; a later authoritative status read can settle
      // it without submitting a second time.
      return { status: "login_required", reason: "签到提交时认证会话失效，未重复提交" };
    }
    if (checkinBody?.success) {
      const quota = checkinBody?.data?.quota_awarded;
      return {
        status: "signed",
        reason: quota == null ? "已通过站点签到接口完成" : `已通过站点签到接口完成，奖励额度 ${quota}`,
        ...(Number.isFinite(Number(quota))&&Number(quota)>0?{evidence:{source:'new_api_checkin_action',
          authoritative:true,accountId:String(userId),businessDate,statusSignal:'reward_response',
          rewardAmount:Number(quota),confirmedAt:new Date().toISOString()}}:{}),
      };
    }
    const checkinMessage = String(checkinBody?.message || "");
    if (/已签到|已簽到|already/i.test(checkinMessage)) {
      return { status: "already_signed", reason: checkinMessage.slice(0, 200) };
    }
    if (/turnstile|captcha|人机|人機/i.test(checkinMessage)) {
      return { status: "interactive_challenge", reason: "站点签到接口要求人机验证" };
    }
    if (/未启用|未啟用|not enabled/i.test(checkinMessage)) {
      return {
        status: "not_available",
        reason: "站点签到功能未启用",
        availabilityKind: "feature_disabled",
        evidence: {
          source: "new_api_checkin_action",
          outcome: "message_not_enabled",
          authoritative: true,
          confirmedAt: new Date().toISOString(),
        },
      };
    }
    return null;
  });
}

async function tryOpenCdCaptcha(page, expectedOrigin, config) {
  if (expectedOrigin !== "https://open.cd") return null;
  const frame = page.frameLocator("iframe#i_signin");
  const input = frame.locator('input[name="imagestring"]');
  const submit = frame.locator("button#ok");
  const images = frame.locator("img");
  if (await input.count() !== 1 || await submit.count() !== 1 || await images.count() !== 1) return null;
  const screenshot = await images.first().screenshot();
  let recognition = await recognizeOpenCdCaptcha(screenshot);
  recognition = await applyOptionalBaiduSecondOpinion(screenshot, recognition, {
    config,
    origin: expectedOrigin,
    length: 6,
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  });
  // The original V1 OpenCD path submitted a complete six-character OCR
  // candidate and relied on the server response plus the follow-up page
  // check. The migrated path rejected candidates when Tesseract returned a
  // usable raw code but no calibrated confidence value (confidence=0), which
  // made otherwise valid OpenCD runs look like interactive challenges.
  const candidateCode = /^[A-Z0-9]{6}$/.test(String(recognition.code ?? ""))
    ? String(recognition.code)
    : (/^[A-Z0-9]{6}$/.test(String(recognition.rawCode ?? "")) ? String(recognition.rawCode) : null);
  if (!candidateCode || (Number(recognition.confidence) > 0 && Number(recognition.confidence) < 45)) {
    return { status: "interactive_challenge", reason: "OpenCD 六位验证码本地识别置信度不足，未提交可疑答案" };
  }
  await input.fill(candidateCode);
  config.beforePtSubmit?.();
  await submit.click();
  await sleep(2000);
  const responseText = String(await frame.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/"state"\s*:\s*"success"|签到成功|簽到成功|已签到|已簽到/i.test(responseText)) {
    const now=new Date();
    return {
      status: "signed",
      reason: `OpenCD 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}）`,
      evidence:{source:'page_text',authoritative:true,confirmedAt:now.toISOString(),
        businessDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(now),statusSignal:'submitted_success_response'},
    };
  }
  // OpenCD 的 iframe 有时不返回可识别的成功文本，但服务器已经完成
  // 签到。刷新主页面并检查“查看签到记录”这一权威状态，避免误报。
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const refreshedState = await snapshotState(page);
  if (["signed", "already_signed"].includes(refreshedState.status)) {
    const evidence=ptPageEvidence({origin:expectedOrigin,url:page.url(),
      bodyText:await page.locator('body').innerText({timeout:3000}).catch(()=>''),status:refreshedState.status,
      allowUndatedActionText:false});
    return {
      ...refreshedState,
      reason: `OpenCD 图片验证码已提交并复查成功（置信度 ${Math.round(recognition.confidence)}）`,
      ...(evidence?{evidence}:{}),
    };
  }
  return { status: "needs_attention", reason: "OpenCD 验证码已提交，但未收到成功结果",
    failureCode: "submission_outcome_unknown", submissionAttempted: true, retryable: false };
}

async function tryHddolbyPostRedirectVerification(page, expectedOrigin, config) {
  if (expectedOrigin !== "https://www.hddolby.com") return null;
  const current = new URL(page.url());
  if (current.pathname !== "/take2fa.php") return null;

  await page.goto(`${expectedOrigin}/index.php`, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const state = await snapshotState(page);
  if (["signed", "already_signed"].includes(state.status)) {
    return {
      ...state,
      reason: "HDDolby 首页确认今日签到奖励已到账",
    };
  }
  return {
    status: "needs_attention",
    reason: "HDDolby 要求完成两步验证，且首页未显示今日签到",
    failureCode: "two_factor_required",
    attentionKind: "trusted_device_initialization",
    retryableLoginRecovery: false,
  };
}

export function isNexusCaptchaRejectedText(value) {
  return /图片代码无效|圖片代碼無效|验证码无效|驗證碼無效|invalid\s+(?:image\s+)?code|captcha\s+invalid/i.test(String(value ?? ""));
}

export async function tryNexusImageCaptcha(page, config = {}, {
  maxAttempts = 3,
  recognize = recognizeNexusCaptcha,
  secondOpinion = applyOptionalBaiduSecondOpinion,
} = {}) {
  const checkinUrl = page.url();
  const submittedChallenges = new Set();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const input = page.locator('input[name="imagestring"]:visible, #imagestring:visible');
    const inputCount = await input.count();
    const form = inputCount === 1 ? input.locator("xpath=ancestor::form[1]") : null;
    const scopedForm = form && await form.count() === 1 ? form : page;
    const submit = scopedForm.locator('#showupbutton, input[type="submit"][value="立即签到"], input[type="submit"][value="立即簽到"]');
    const image = scopedForm.locator('#showupimg, img[alt="CAPTCHA" i][src*="image.php"], img[src*="/image.php"]');
    const imageHash = scopedForm.locator('input[type="hidden"][name="imagehash"]');
    const submitCount = await submit.count();
    const imageCount = await image.count();
    // An ordinary attendance form has the same submit label. Only activate
    // CAPTCHA handling when an input, image or challenge hash is present.
    if (inputCount === 0 && imageCount === 0 && await imageHash.count() === 0) return null;
    if (inputCount !== 1 || submitCount !== 1 || imageCount !== 1) {
      return {
        status: "needs_attention",
        reason: "检测到 NexusPHP 验证码，但页面控件结构不完整，已阻止空验证码提交",
        failureCode: "captcha_structure_changed",
        retryable: false,
      };
    }
    const screenshot = await image.screenshot();
    const imageHashValue = await imageHash.count() === 1
      ? await imageHash.inputValue().catch(() => "")
      : "";
    const challengeKey = `${imageHashValue}:${createHash("sha256").update(screenshot).digest("hex")}`;
    if (submittedChallenges.has(challengeKey)) {
      if (attempt === maxAttempts) return {
        status: "needs_attention",
        reason: "NexusPHP 验证码刷新后仍返回同一题目，已阻止重复提交",
        failureCode: "captcha_not_refreshed",
        retryable: false,
      };
      await page.goto(checkinUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await sleep(750);
      continue;
    }
    let recognition = await recognize(screenshot);
    recognition = await secondOpinion(screenshot, recognition, {
      config,
      origin: new URL(checkinUrl).origin,
      length: 6,
      alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    });
    if (!/^[A-Z0-9]{6}$/.test(recognition.code)) {
      if (attempt === maxAttempts) return {
        status: "needs_attention",
        reason: "NexusPHP 六位验证码连续识别无效，已阻止可疑答案和空验证码提交",
        failureCode: "captcha_ocr_exhausted",
        retryable: false,
      };
      await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await sleep(750);
      continue;
    }
    submittedChallenges.add(challengeKey);
    await input.fill(recognition.code);
    config.beforePtSubmit?.();
    await submit.click();
    await sleep(3000);
    const state = await snapshotState(page);
    if (["signed", "already_signed"].includes(state.status)) {
      return { ...state, reason: `${state.reason}；图片验证码置信度 ${Math.round(recognition.confidence)}，第 ${attempt} 次识别` };
    }
    const showup = page.locator("#showup");
    if (await showup.count() === 1) {
      const showupText = String(await showup.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (/已签到|已簽到|showed up/i.test(showupText)) {
        return { status: "signed", reason: `NexusPHP 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}，第 ${attempt} 次识别）` };
      }
    }
    const bodyText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
    if (isNexusCaptchaRejectedText(bodyText)) {
      if (attempt === maxAttempts) return {
        status: "needs_attention",
        reason: "NexusPHP 图片验证码连续被站点拒绝，已停止本轮提交",
        captchaRejected: true,
        failureCode: "captcha_ocr_exhausted",
        submissionAttempted: true,
        retryable: false,
      };
      await page.goto(checkinUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await sleep(750);
      continue;
    }
    if (await page.locator('#showupimg, img[alt="CAPTCHA" i][src*="image.php"], img[src*="/image.php"]').count() === 0) {
      for (let verification = 0; verification < 4; verification += 1) {
        if (verification > 0) await sleep(750);
        const verified = await snapshotState(page);
        if (["signed", "already_signed"].includes(verified.status)) {
          return { ...verified, reason: `${verified.reason}；NexusPHP 图片验证码第 ${attempt} 次识别完成` };
        }
      }
      await page.goto(checkinUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await sleep(750);
      const verified = await snapshotState(page);
      if (["signed", "already_signed"].includes(verified.status)) {
        return { ...verified, reason: `${verified.reason}；NexusPHP 图片验证码第 ${attempt} 次识别完成` };
      }
      return {
        status: "needs_attention",
        reason: "NexusPHP 验证码已提交，但页面与签到页均未提供权威结果",
        failureCode: "submission_outcome_unknown",
        submissionAttempted: true,
        retryable: false,
      };
    }
    return {
      status: "needs_attention",
      reason: "NexusPHP 图片验证码提交后没有明确成功或拒绝回执，已停止本轮提交",
      failureCode: "submission_outcome_unknown",
      submissionAttempted: true,
      retryable: false,
    };
  }
  return { status: "interactive_challenge", reason: "NexusPHP 图片验证码未能完成" };
}

export async function tryU2Captcha(page, expectedOrigin, config, {solve=solveU2VisualChallenge}={}) {
  if (expectedOrigin !== "https://u2.dmhy.org") return null;
  const openedAt=Date.now();
  const buttons = page.locator('input[type="submit"][name^="captcha_"]');
  if (await buttons.count() < 2) return null;
  const image = page.locator('img[alt="captcha"]');
  if (await image.count() !== 1) {
    return { status: "interactive_challenge", reason: "U2 验证题缺少题图",submissionAttempted:false };
  }
  try {
    await page.waitForFunction(() => {
      const element = document.querySelector('img[alt="captcha"]');
      return Boolean(element?.complete && element.naturalWidth > 0 && element.naturalHeight > 0);
    }, null, { timeout: 50000 });
  } catch {
    return { status: "interactive_challenge", reason: "U2 验证题图片加载超时",submissionAttempted:false };
  }
  const options = await buttons.evaluateAll((elements) => elements.map((element) => ({
    name: element.name,
    text: element.value,
  })));
  const screenshot = await image.screenshot();
  const solution = await solve(screenshot, options);
  if (!solution.answer?.name) {
    return { status: "interactive_challenge", reason: `U2 本地视觉识别未得出可靠答案：${solution.reason}`,submissionAttempted:false };
  }
  if(Date.now()-openedAt>100000)return {status:'interactive_challenge',reason:'U2 题目接近有效期，未提交答案，等待重新验证',submissionAttempted:false};
  const message = page.locator('textarea[name="message"]');
  if (await message.count() !== 1) return { status: "interactive_challenge", reason: "U2 留言框不存在",submissionAttempted:false };
  await message.fill(String(config.u2Message || "今日天气不错"));
  const chosen = page.locator(`input[type="submit"][name="${solution.answer.name}"]`);
  if (await chosen.count() !== 1) return { status: "interactive_challenge", reason: "U2 识别答案不属于当前题目",submissionAttempted:false };
  config.beforePtSubmit?.();
  await chosen.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const policy=ptReadPolicy(expectedOrigin,config);
  for(let read=0;read<3;read++){
    if(read)await sleep(750);
    const response=await page.goto(policy.url,{waitUntil:'domcontentloaded',timeout:15000}).catch(()=>null);
    if(!response)continue;
    const observed=await readPtPassivePage(page,policy,{origin:expectedOrigin,httpStatus:response.status()});
    if(observed.status==='already_signed'&&observed.evidence?.authoritative===true)
      return {status:'signed',reason:'U2 答案已提交，当前账号每日首页确认签到完成',submissionAttempted:true,evidence:observed.evidence};
  }
  return { status: "needs_attention", reason: "U2 答案已提交，但页面未显示签到成功",
    submissionAttempted: true, failureCode: 'submission_outcome_unknown', retryable: false };
}

async function processCandidate(page, target, candidateUrl, config, qaRules) {
  if(!isPtExecutionTarget(target,{root:rootDirectory}))return processCandidateBody(page,target,candidateUrl,config,qaRules);
  return guardPtSubmission(beforePtSubmit=>processCandidateBody(page,target,candidateUrl,{...config,beforePtSubmit},qaRules),
    ()=>checkHarvestPtBeforeWrite(target,{root:rootDirectory}));
}

async function processCandidateBody(page, target, candidateUrl, config, qaRules) {
  const checkPt=()=>checkHarvestPtBeforeWrite(target,{root:rootDirectory});
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const useNewApiCheckin = shouldTryGenericNewApiCheckin(target, config.newApiCheckinOrigins);
  const useExtendedDiscovery = targetUsesConfiguredOrigins(target, config.extendedDiscoveryOrigins);
  const destination = assertBookmarkNavigation(candidateUrl, allowedOrigins);
  let passivePolicy;
  try{passivePolicy=ptReadPolicy(target.origin,config);}catch{}
  const passiveVisit=passivePolicy?.url===destination&&!passivePolicy.nativeMainChrome&&!passivePolicy.selfProfileHeader;
  if(!passiveVisit){const beforeVisit=checkPt();if(beforeVisit)return beforeVisit;}
  const anyRouterResult = target.origin === "https://anyrouter.top"
    ? await tryAnyRouterApiCheckin(page, config, target.origin)
    : null;
  if (anyRouterResult) return { ...anyRouterResult, url: safeLogUrl(destination) };
  const u2Question=target.origin==='https://u2.dmhy.org'&&new URL(destination).pathname==='/showup.php';
  if(!u2Question&&/attendance|check[-_]?in|showup/i.test(new URL(destination).pathname))config.beforePtSubmit?.();
  const navigationResponse=await page.goto(destination, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  if(passiveVisit){
    const observed=await initialPtObservation(page,passivePolicy,target.origin,navigationResponse);
    if(observed)return observed;
    if(passivePolicy.dailyHeader)return {status:'visited',reason:'账户首页尚未确认今日完成，继续原有签到流程',submissionAttempted:false,url:passivePolicy.url};
  }
  if (useExtendedDiscovery) {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  }
  let activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
  let activeOrigin = new URL(activeUrl).origin;
  if (activeOrigin === "https://hdsky.me") {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await sleep(500);
  }
  const leichi = await passLeichiConfirmation(page, config);
  if (leichi && !leichi.passed) {
    return { status: "interactive_challenge", reason: leichi.reason, url: safeLogUrl(page.url()) };
  }
  if (leichi?.passed) {
    await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
    activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    activeOrigin = new URL(activeUrl).origin;
  }
  const afterVisit=checkPt();
  if(afterVisit)return afterVisit;
  const u2Result = await tryU2Captcha(page, activeOrigin, config);
  if (u2Result) return { ...u2Result, url: safeLogUrl(page.url()) };

  const initialBmapiStatus = await tryBmapiCheckinStatus(page, activeOrigin);
  if (initialBmapiStatus && initialBmapiStatus.status !== "ready") {
    return { ...initialBmapiStatus, url: safeLogUrl(page.url()) };
  }

  const oauthApiStatus = await tryOAuthApiCheckin(page, activeOrigin, config);
  if (oauthApiStatus) return { ...oauthApiStatus, url: safeLogUrl(page.url()) };

  const newApiSignInStatus = await tryNewApiSignIn(page, activeOrigin, config);
  if (newApiSignInStatus) return { ...newApiSignInStatus, url: safeLogUrl(page.url()) };

  const oauthReloginStatus = await tryOAuthReloginCheckinStatus(page, activeOrigin, config);
  if (oauthReloginStatus) return { ...oauthReloginStatus, url: safeLogUrl(page.url()) };

  const newApiCaptchaStatus = await tryNewApiCaptchaCheckin(
    page,
    activeOrigin,
    config,
    async (image) => {
      let recognition = await recognizeNewApiCaptcha(image);
      recognition = await applyOptionalBaiduSecondOpinion(image, recognition, {
        config,
        origin: activeOrigin,
        length: 5,
        alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
      });
      const candidates = newApiCaptchaCandidates(recognition);
      return recognition.externalConsensus && recognition.code
        ? [recognition.code, ...candidates.filter((code) => code !== recognition.code)]
        : candidates;
    },
  );
  if (newApiCaptchaStatus) return { ...newApiCaptchaStatus, url: safeLogUrl(page.url()) };

  // New API exposes an authoritative current-day status endpoint.  Query it
  // before interpreting generic page copy such as “每日签到可获得奖励”, which is
  // a feature description rather than proof that today's check-in succeeded.
  let initialApiResult = null;
  if (useNewApiCheckin) {
    initialApiResult = await tryNewApiCheckin(page);
    if (initialApiResult && (initialApiResult.status !== "not_available" || isTerminalResult(initialApiResult))) {
      return { ...initialApiResult, url: safeLogUrl(page.url()) };
    }
    if (initialApiResult?.status === "not_available"
      && (config.knownNoCheckinFeatureOrigins ?? []).includes(activeOrigin)) {
      return { ...initialApiResult, reason: "站点签到接口确认未启用", url: safeLogUrl(page.url()) };
    }
  }
  let state = await waitForManagedChallenge(page, config);
  state = await classifyManualAttention(page, state, activeOrigin, config);
  if (state.status !== "ready") return { ...state, url: safeLogUrl(page.url()) };
  await dismissBlockingModal(page, config);

  const directLoginCompletion = configuredLoginCompletion(activeOrigin, config);
  if (directLoginCompletion) return { ...directLoginCompletion, url: safeLogUrl(page.url()) };

  const hddolbyResult = await tryHddolbyPostRedirectVerification(page, activeOrigin, config);
  if (hddolbyResult) return { ...hddolbyResult, url: safeLogUrl(page.url()) };

  const activeBenefit = await detectActiveQuotaBenefit(page, activeOrigin, config);
  if (activeBenefit) return { ...activeBenefit, url: safeLogUrl(page.url()) };

  const visitRule = (config.visitCheckinRules ?? {})[activeOrigin];
  if (visitRule?.after) {
    const beforeVisitRule=checkPt();
    if(beforeVisitRule)return beforeVisitRule;
    const match = String(visitRule.after).match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) throw new Error(`访问签到时间配置无效：${activeOrigin}`);
    const current = new Date();
    const currentMinutes = current.getHours() * 60 + current.getMinutes();
    const requiredMinutes = Number(match[1]) * 60 + Number(match[2]);
    if (currentMinutes >= requiredMinutes) {
      return {
        status: "signed",
        reason: `${visitRule.after} 后已登录访问，按站点规则完成签到`,
        url: safeLogUrl(page.url()),
      };
    }
    return {
      status: "deferred",
      reason: `站点要求 ${visitRule.after} 后访问，当前尚未到签到时间`,
      url: safeLogUrl(page.url()),
    };
  }

  const beforeActionDiscovery=checkPt();
  if(beforeActionDiscovery)return beforeActionDiscovery;
  const qaResult = await tryQaFlow(page, qaRules, activeOrigin, config);
  if (qaResult) return { ...qaResult, url: safeLogUrl(page.url()) };

  // Some NexusPHP attendance pages render the CAPTCHA and its submit button
  // immediately. Solve it before generic action discovery so the empty or
  // stale image code is never submitted as an ordinary "立即签到" action.
  const initialNexusCaptchaResult = await tryNexusImageCaptcha(page, config);
  if (initialNexusCaptchaResult) return { ...initialNexusCaptchaResult, url: safeLogUrl(page.url()) };

  let action = await findCheckinAction(page, allowedOrigins);
  if (!action && useExtendedDiscovery) {
    const discoveryUrls = await findCheckinDiscoveryUrls(page, activeOrigin);
    for (const discoveryUrl of discoveryUrls) {
      if (discoveryUrl === page.url()) continue;
      await navigateDiscoveryUrl(page, discoveryUrl, allowedOrigins, config);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      if (useNewApiCheckin) {
        const discoveredApiResult = await tryNewApiCheckin(page);
        if (discoveredApiResult && (discoveredApiResult.status !== "not_available" || isTerminalResult(discoveredApiResult))) {
          return { ...discoveredApiResult, url: safeLogUrl(page.url()) };
        }
      }
      state = await waitForManagedChallenge(page, config);
      state = await classifyManualAttention(page, state, activeOrigin, config);
      if (state.status !== "ready") return { ...state, url: safeLogUrl(page.url()) };
      await dismissBlockingModal(page, config);
      action = await findCheckinAction(page, allowedOrigins);
      if (action) break;
    }
  }
  if (action) {
    const beforeClick=checkPt();
    if(beforeClick)return beforeClick;
    // OpenCD's first control opens its CAPTCHA dialog; the actual form
    // submission is guarded inside tryOpenCdCaptcha after OCR succeeds.
    if(!knownPtDialogOpener(activeOrigin,action))config.beforePtSubmit?.();
    await clickCandidate(page, action);
    await sleep(config.actionWaitMs);
    activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
    activeOrigin = new URL(activeUrl).origin;
    state = await waitForManagedChallenge(page, config);
    state = await classifyManualAttention(page, state, activeOrigin, config);
    const confirmedBmapiStatus = await tryBmapiCheckinStatus(page, activeOrigin, "signed");
    if (confirmedBmapiStatus && confirmedBmapiStatus.status !== "ready") {
      return { ...confirmedBmapiStatus, action: action.text, url: safeLogUrl(page.url()) };
    }
    if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(state.status)) {
      return { ...state, action: action.text, url: safeLogUrl(page.url()) };
    }
    if (state.status === "ready") {
      const activeBenefitAfterAction = await waitForActiveQuotaBenefit(page, activeOrigin, config, "signed", 5000);
      if (activeBenefitAfterAction) {
        return { ...activeBenefitAfterAction, action: action.text, url: safeLogUrl(page.url()) };
      }
      const quotaResult = await tryQuotaRequestFlow(page, activeOrigin, config);
      if (quotaResult) return { ...quotaResult, action: `${action.text} → 申请理由`, url: safeLogUrl(page.url()) };
    }

    const openCdResult = await tryOpenCdCaptcha(page, activeOrigin, config);
    if (openCdResult) return { ...openCdResult, action: action.text, url: safeLogUrl(page.url()) };
    const nexusCaptchaResult = await tryNexusImageCaptcha(page, config);
    if (nexusCaptchaResult) return { ...nexusCaptchaResult, action: action.text, url: safeLogUrl(page.url()) };

    const secondAction = await findCheckinAction(page, allowedOrigins, action);
    if (secondAction) {
      const beforeSecondClick=checkPt();
      if(beforeSecondClick)return beforeSecondClick;
      config.beforePtSubmit?.();
      await clickCandidate(page, secondAction);
      await sleep(/转动|轉動/.test(secondAction.text) ? Math.max(config.actionWaitMs, 8000) : config.actionWaitMs);
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      state = await waitForManagedChallenge(page, config);
      state = await classifyManualAttention(page, state, activeOrigin, config);
      if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(state.status)) {
        return { ...state, action: `${action.text} → ${secondAction.text}`, url: safeLogUrl(page.url()) };
      }
      const confirmed = await waitForAuthoritativeCheckin(page, activeOrigin, config);
      return { ...confirmed, action: `${action.text} → ${secondAction.text}`, url: safeLogUrl(page.url()) };
    }
    const confirmed = await waitForAuthoritativeCheckin(page, activeOrigin, config);
    return { ...confirmed, action: action.text, url: safeLogUrl(page.url()) };
  }

  if (/(attendance|check[-_]?in|showup)\.(php|asp)|\/(attendance|check[-_]?in|showup)(?:[/?#]|$)/i.test(activeUrl)) {
    // Visiting an attendance URL is an action attempt, not proof of success.
    // Some trackers submit the check-in on page load, while others require a
    // hidden form/API call; only page text or an authoritative endpoint may
    // close the target as signed/already_signed.
    const confirmed = await waitForAuthoritativeCheckin(page, activeOrigin, config, { submissionAttempted: false });
    return { ...confirmed, url: safeLogUrl(page.url()) };
  }

  if (useNewApiCheckin) {
    const apiResult = initialApiResult ?? await tryNewApiCheckin(page);
    if (apiResult) return { ...apiResult, url: safeLogUrl(page.url()) };
  }
  if ((config.knownNoCheckinFeatureOrigins ?? []).includes(activeOrigin)) {
    return {
      status: "no_action",
      reason: "配置标记该站可能未开放签到，但本次未取得页面或接口证据",
      failureCode: "not_available_evidence_missing",
      url: safeLogUrl(page.url()),
    };
  }

  return { status: "no_action", reason: "未发现明确签到控件", url: safeLogUrl(page.url()) };
}

async function saveFailureScreenshot(page, logDirectory, target) {
  const host = new URL(target.origin).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const file = path.join(logDirectory, `${host}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function snapshotStateAfterNavigation(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await snapshotState(page);
    } catch (snapshotError) {
      const contextReset = /Execution context was destroyed|Cannot find context with specified id|frame was detached/i
        .test(String(snapshotError?.message ?? snapshotError));
      if (!contextReset || attempt >= 2) return null;
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      await sleep(250);
    }
  }
  return null;
}

export async function resultFromPageFailure(page, error, config) {
  const navigationError = String(error?.message ?? error);
  if (/net::ERR_CERT_(?:DATE_INVALID|AUTHORITY_INVALID|COMMON_NAME_INVALID|REVOKED|WEAK_SIGNATURE_ALGORITHM)/i.test(navigationError)) {
    // Chromium rejects an expired or otherwise invalid site certificate before
    // any page state can be inspected. Treat this as an upstream transport
    // outage, not a generic task error or a login failure: never bypass TLS
    // validation and never spend a retry on credentials that cannot be used.
    return withRetrySchedule({
      status: "deferred",
      retryCause: "upstream_unavailable",
      failureCode: "tls_certificate_invalid",
      reason: "站点 TLS 证书已过期、日期无效或主机名不匹配；未尝试重新登录",
      retryableLoginRecovery: false,
      url: safeLogUrl(page.url()),
    }, config);
  }
  if (/net::ERR_SSL_(?:VERSION_OR_CIPHER_MISMATCH|PROTOCOL_ERROR)/i.test(navigationError)) {
    return withRetrySchedule({
      status: "deferred",
      retryCause: "upstream_unavailable",
      failureCode: "tls_handshake_failed",
      reason: "站点 HTTPS 握手失败，无法建立安全连接；未尝试重新登录",
      url: safeLogUrl(page.url()),
    }, config);
  }
  const pageState = await snapshotStateAfterNavigation(page);
  if (pageState?.status === "deferred") {
    return withRetrySchedule({ ...pageState, url: safeLogUrl(page.url()) }, config);
  }
  if (pageState && pageState.status !== "ready") {
    return { ...pageState, url: safeLogUrl(page.url()) };
  }
  if (isTransientNavigationFailure(error)) {
    return withRetrySchedule({
      status: "deferred",
      retryCause: "upstream_unavailable",
      reason: "站点网络暂时不可用，已安排自动重试",
      url: safeLogUrl(page.url()),
    }, config);
  }
  return {
    status: "error",
    reason: safeErrorMessage(error),
    url: safeLogUrl(page.url()),
  };
}

export function isTransientNavigationFailure(error) {
  const message = String(error?.message ?? error ?? "");
  return /page\.goto:[\s\S]{0,300}Timeout .* exceeded|net::ERR_(?:CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED|HTTP2_PROTOCOL_ERROR|NETWORK_CHANGED)|\b(?:ECONNRESET|ETIMEDOUT)\b|socket hang up/i.test(message);
}

// A browser network service can lose a connection for one target while the
// underlying host remains reachable. The caller may recreate the shared
// context once, preserving the same profile and its login state.
export function shouldRefreshAutomationContext(result) {
  return result?.status === "deferred" && result?.retryCause === "upstream_unavailable"
    && result.failureCode !== "tls_certificate_invalid";
}

export async function launchAutomationContext(config) {
  await fs.access(config.chromeExecutable);
  const directHosts = [...new Set((config.directConnectionOrigins ?? []).flatMap((value) => {
    try {
      const url = new URL(String(value));
      if (url.protocol !== "https:" || !url.hostname) return [];
      return [url.hostname, `*.${url.hostname}`];
    } catch {
      return [];
    }
  }))];
  const disabledFeatures = [
    "Translate",
    "MediaRouter",
    ...(config.disableOptimizationGuideOnDeviceModel === false ? [] : ["OptimizationGuideOnDeviceModel"]),
  ];
  const context = await chromium.launchPersistentContext(config.automationUserDataDir, {
    executablePath: config.chromeExecutable,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
    headless: config.headless,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: config.headless ? { width: 1365, height: 900 } : null,
    acceptDownloads: false,
    proxy: ptReadProxy(config),
    serviceWorkers: config.ptPassiveReadOnly === true ? "block" : "allow",
    javaScriptEnabled: config.ptPassiveReadOnly !== true,
    args: [
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-component-update",
      "--disable-features=" + disabledFeatures.join(","),
      "--disable-blink-features=AutomationControlled",
      ...(directHosts.length > 0 ? [`--proxy-bypass-list=${directHosts.join(";")}`] : []),
      ...(config.backgroundWindowMode === "offscreen" ? ["--window-position=-32000,-32000", "--window-size=1365,900"] : []),
      ...(config.backgroundWindowMode === "visible" ? ["--window-position=80,80", "--window-size=1365,900"] : []),
    ],
  });
  return context;
}

export async function processTarget(context, target, config, qaRules, logDirectory, {
  runCandidate = processCandidate,
} = {}) {
  const configuredSkip = configuredTargetSkip(target, config);
  if (configuredSkip) return { ...configuredSkip, attempt: 0, candidateHistory: [] };
  let passivePolicy;
  if(isPtExecutionTarget(target,{root:rootDirectory})){
    try{passivePolicy=ptReadPolicy(target.origin,config);}catch{}
  }
  let lastResult = null;
  const candidateHistory = [];
  let allCandidatesUnsubmitted = true;
  const candidates = passivePolicy&&!passivePolicy.nativeMainChrome&&!passivePolicy.selfProfileHeader&&
    (passivePolicy.dailyHeader||passivePolicy.openCdHeader||ptReadPolicies[target.origin]?.completionReadFirst)
    ? [...new Set([passivePolicy.url, ...target.candidates])]
    : target.candidates;
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    const page = await context.newPage();
    let attemptResult = null;
    try {
      for (const candidateUrl of candidates) {
        let result;
        try {
          result = withRetrySchedule(
            await runCandidate(page, target, candidateUrl, config, qaRules),
            config,
          );
        } catch (error) {
          result = await resultFromPageFailure(page, error, config);
        }
        if (result?.submissionAttempted !== false) allCandidatesUnsubmitted = false;
        candidateHistory.push(candidateHistoryEntry(candidateUrl, result, attempt + 1));
        attemptResult = preferCandidateResult(attemptResult, result);
        lastResult = preferCandidateResult(lastResult, result);
        // A logical bookmark target can contain multiple related URLs.  One
        // public/API URL may require login while another dedicated check-in
        // URL already has a valid session, so only a completed result should
        // prevent trying the remaining candidates.
        if (isTerminalResult(result) || result?.submissionAttempted === true) break;
      }

      const effectiveResult = preferCandidateResult(lastResult, attemptResult);
      if (effectiveResult && !CHALLENGE.has(effectiveResult.status)
        && (!UNCONFIRMED.has(effectiveResult.status) || attempt === config.retryCount)) {
        if (config.failureScreenshots && !isTerminalResult(effectiveResult) && effectiveResult.status !== "login_required") {
          effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        }
        const completed={...effectiveResult,attempt:attempt+1,candidateHistory};
        if (completed.status === "login_required") {
          if (allCandidatesUnsubmitted) completed.submissionAttempted = false;
          else delete completed.submissionAttempted;
        }
        if((config.capturePtEvidence===true||['页面显示签到成功','今天已经签到'].includes(completed.reason))&&
           ['signed','already_signed'].includes(completed.status)&&completed.evidence?.authoritative!==true){
          const bodyText=await page.locator('body').innerText({timeout:3000}).catch(()=> '');
          const evidence=ptPageEvidence({origin:target.origin,url:page.url(),bodyText,status:completed.status});
          if(evidence)completed.evidence=evidence;
        }
        return completed;
      }
      if (effectiveResult?.status === "interactive_challenge") {
        if (config.failureScreenshots) effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        return { ...effectiveResult, attempt: attempt + 1, candidateHistory };
      }
      if (effectiveResult && CHALLENGE.has(effectiveResult.status) && attempt === config.retryCount && config.failureScreenshots) {
        effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
      }
    } catch (error) {
      const result = await resultFromPageFailure(page, error, config);
      allCandidatesUnsubmitted = false;
      candidateHistory.push(candidateHistoryEntry(page.url(), result, attempt + 1));
      attemptResult = preferCandidateResult(attemptResult, result);
      lastResult = preferCandidateResult(lastResult, result);
      if (config.failureScreenshots) {
        try { result.screenshot = await saveFailureScreenshot(page, logDirectory, target); } catch { /* 页面可能已经关闭 */ }
      }
    } finally {
      await page.close().catch(() => {});
    }

    if (attempt < config.retryCount) await sleep(config.retryDelayMs);
  }
  return {
    ...(lastResult ?? { status: "error", reason: "未知错误" }),
    attempt: config.retryCount + 1,
    candidateHistory,
  };
}
