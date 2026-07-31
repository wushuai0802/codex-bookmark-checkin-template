import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { classifyPageText, formatDailyReason, isCheckinSingleChoiceChallenge, normalizeText, scoreActionText } from "./detector.mjs";
import { assertBookmarkNavigation, safeErrorMessage, safeLogUrl } from "./security.mjs";
import { recognizeOpenCdCaptcha } from "./captcha-ocr.mjs";
import { solveU2VisualChallenge } from "./u2-vision.mjs";
import { resolveQaByWebSearch } from "./qa-solver.mjs";
import { withRetrySchedule } from "./retry-policy.mjs";
import { tryOAuthReloginCheckinStatus } from "./oauth-relogin-checkin.mjs";
import { tryNewApiSignIn } from "./new-api-signin.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const COMPLETED = new Set(["signed", "already_signed", "not_available"]);
const CHALLENGE = new Set(["interactive_challenge", "managed_challenge_timeout"]);
const UNCONFIRMED = new Set(["visited", "clicked"]);
const STORAGE_CONFIRMED = new Set(["signed", "already_signed"]);
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
export const CHALLENGE_SELECTOR = 'iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, [data-cap-api-endpoint], [class*="captcha" i]';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function preferCandidateResult(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  const currentPriority = CANDIDATE_STATUS_PRIORITY.get(current.status) ?? 0;
  const candidatePriority = CANDIDATE_STATUS_PRIORITY.get(candidate.status) ?? 0;
  return candidatePriority > currentPriority ? candidate : current;
}

export function shouldPersistSiteStorage(result) {
  return STORAGE_CONFIRMED.has(result?.status);
}

export function configuredTargetSkip(target, config = {}) {
  if (!(config.disabledCheckinOrigins ?? []).includes(target?.origin)) return null;
  return {
    status: "not_available",
    reason: "已按配置取消该站签到任务",
    url: target.origin,
    disabledByConfig: true,
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
  if (target?.origin === "https://bmapi.020212.xyz") return false;
  if (Array.isArray(configuredOrigins)) {
    const configured = new Set(configuredOrigins);
    return (target?.allowedOrigins ?? [target?.origin]).some((origin) => configured.has(origin));
  }
  return target?.folderNames?.includes("公益站") ?? false;
}

export function filterExpiredBootstrapLocalEntries(entries, nowMs = Date.now()) {
  const local = (entries ?? []).filter((entry) => Array.isArray(entry) && entry.length === 2
    && entry.every((item) => typeof item === "string"));
  const rawExpiry = local.find(([key]) => key === "token_expires_at")?.[1];
  const numericExpiry = Number(rawExpiry);
  const expiryMs = numericExpiry > 0 && numericExpiry < 10_000_000_000 ? numericExpiry * 1000 : numericExpiry;
  if (!Number.isFinite(expiryMs) || expiryMs > nowMs) return local;
  const staleAuthKeys = new Set(["auth_token", "refresh_token", "token_expires_at", "auth_user"]);
  return local.filter(([key]) => !staleAuthKeys.has(key));
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
    return { status: "not_available", reason: "斑马 API 签到接口确认未启用" };
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
      status: "needs_attention",
      reason: `Turnstile 自动验证未在 ${Math.ceil(waitMs / 1000)} 秒内完成`,
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

async function tryQuotaRequestFlow(page, activeOrigin, config) {
  const rule = config.quotaRequestRules?.[activeOrigin];
  if (!rule) return null;
  const reason = formatDailyReason(String(rule.reason || "{date}正常使用服务，申请额度用于开发测试和日常体验，谢谢。"));
  const minimumLength = Math.max(10, Number(rule.minimumReasonLength) || 10);
  if ([...reason].length < minimumLength) throw new Error(`额度申请理由少于 ${minimumLength} 个字符`);
  const reasonFields = page.locator([
    'textarea:visible',
    'input[name*="reason" i]:visible',
    'input[name*="remark" i]:visible',
    'input[name*="message" i]:visible',
    'input[placeholder*="理由" i]:visible',
    'input[placeholder*="原因" i]:visible',
  ].join(", "));
  if (await reasonFields.count() !== 1) return null;
  await reasonFields.fill(reason);
  let submit = null;
  for (const label of ["领取", "領取", "提交申请", "确认申请", "确认提交", "提交", "确认"]) {
    const candidate = page.getByRole("button", { name: label, exact: true });
    if (await candidate.count() === 1 && await candidate.isVisible().catch(() => false)) { submit = candidate; break; }
    const input = page.locator(`input[type="submit"][value="${label}"], input[type="button"][value="${label}"]`);
    if (await input.count() === 1 && await input.isVisible().catch(() => false)) { submit = input; break; }
  }
  if (!submit) return { status: "needs_attention", reason: "已填写额度申请理由，但未找到提交按钮" };
  await submit.click({ timeout: 10000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await sleep(Math.max(1000, Number(config.actionWaitMs) || 0));
  const state = await waitForManagedChallenge(page, config);
  if (["signed", "already_signed"].includes(state.status)) return state;
  const bodyText = String(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/(额度申请已提交|申请额度成功|额度已发放|额度申请成功|申请成功.*额度|今日已申请|今天已申请|codex\s*(?:权益|權益)\s*已(?:领取|領取)|(?:领取|領取)\s*codex\s*(?:权益|權益)\s*成功)/i.test(bodyText)) return { status: "signed", reason: "额度申请已提交并获得页面确认" };
  const activeBenefit = await detectActiveQuotaBenefit(page, activeOrigin, config, "signed");
  if (activeBenefit) return activeBenefit;
  return { status: "unconfirmed", reason: "额度申请已提交，但页面未确认结果" };
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

async function applyQaRule(page, rule) {
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
    await page.locator('input[type="submit"], button[type="submit"]').nth(matchingSubmits[0].index).click();
  } else {
    const submit = page.getByText(submitText, { exact: true });
    if (await submit.count() !== 1) return false;
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
      const applied = await applyQaRule(page, rule);
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

async function tryNewApiCheckin(page) {
  return page.evaluate(async () => {
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
      const visibleId = String(document.body?.innerText || "").match(/ID\s*[:：]\s*(\d+)/i);
      userId = visibleId?.[1] ?? null;
    }
    if (userId == null) {
      try {
        const response = await fetch("/api/user/self", { credentials: "include", headers: { Accept: "application/json" } });
        const body = await response.json();
        userId = body?.data?.id ?? body?.data?.user?.id ?? null;
      } catch { /* not a compatible API */ }
    }
    if (userId == null) return null;

    const headers = { Accept: "application/json", "New-Api-User": String(userId) };
    const currentDate = new Date();
    const month = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, "0")}`;
    let statusResponse;
    try {
      statusResponse = await fetch(`/api/user/checkin?month=${month}`, { credentials: "include", headers });
    } catch {
      return null;
    }
    if (statusResponse.status === 404) return null;
    let statusBody;
    try { statusBody = await statusResponse.json(); } catch { return null; }
    const message = String(statusBody?.message || "");
    if (!statusBody?.success) {
      if (/未启用|未啟用|not enabled/i.test(message)) {
        return { status: "not_available", reason: "站点签到功能未启用" };
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
    if (checked) return { status: "already_signed", reason: "签到接口显示今日已签到" };

    let checkinResponse;
    try {
      checkinResponse = await fetch("/api/user/checkin", { method: "POST", credentials: "include", headers });
    } catch {
      return null;
    }
    let checkinBody;
    try { checkinBody = await checkinResponse.json(); } catch { return null; }
    if (checkinBody?.success) {
      const quota = checkinBody?.data?.quota_awarded;
      return {
        status: "signed",
        reason: quota == null ? "已通过站点签到接口完成" : `已通过站点签到接口完成，奖励额度 ${quota}`,
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
      return { status: "not_available", reason: "站点签到功能未启用" };
    }
    return null;
  });
}

async function tryOpenCdCaptcha(page, expectedOrigin) {
  if (expectedOrigin !== "https://open.cd") return null;
  const frame = page.frameLocator("iframe#i_signin");
  const input = frame.locator('input[name="imagestring"]');
  const submit = frame.locator("button#ok");
  const images = frame.locator("img");
  if (await input.count() !== 1 || await submit.count() !== 1 || await images.count() !== 1) return null;
  const screenshot = await images.first().screenshot();
  const recognition = await recognizeOpenCdCaptcha(screenshot);
  if (!/^[A-Z0-9]{6}$/.test(recognition.code)) {
    return { status: "interactive_challenge", reason: "OpenCD 六位验证码本地识别结果无效" };
  }
  await input.fill(recognition.code);
  await submit.click();
  await sleep(2000);
  const responseText = String(await frame.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (/"state"\s*:\s*"success"|签到成功|簽到成功|已签到|已簽到/i.test(responseText)) {
    return {
      status: "signed",
      reason: `OpenCD 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}）`,
    };
  }
  // OpenCD 的 iframe 有时不返回可识别的成功文本，但服务器已经完成
  // 签到。刷新主页面并检查“查看签到记录”这一权威状态，避免误报。
  await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
  await sleep(1200);
  const refreshedState = await snapshotState(page);
  if (["signed", "already_signed"].includes(refreshedState.status)) {
    return {
      ...refreshedState,
      reason: `OpenCD 图片验证码已提交并复查成功（置信度 ${Math.round(recognition.confidence)}）`,
    };
  }
  return { status: "interactive_challenge", reason: "OpenCD 验证码已提交，但未收到成功结果" };
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
    status: "interactive_challenge",
    reason: "HDDolby 要求完成两步验证，且首页未显示今日签到",
  };
}

async function tryNexusImageCaptcha(page) {
  const input = page.locator("#imagestring");
  const submit = page.locator("#showupbutton");
  const image = page.locator("#showupimg");
  if (await input.count() !== 1 || await submit.count() !== 1 || await image.count() !== 1) return null;
  const screenshot = await image.screenshot();
  const recognition = await recognizeOpenCdCaptcha(screenshot);
  if (!/^[A-Z0-9]{6}$/.test(recognition.code)) {
    return { status: "interactive_challenge", reason: "NexusPHP 六位验证码本地识别结果无效" };
  }
  await input.fill(recognition.code);
  await submit.click();
  await sleep(3000);
  const state = await snapshotState(page);
  if (["signed", "already_signed"].includes(state.status)) {
    return { ...state, reason: `${state.reason}；图片验证码置信度 ${Math.round(recognition.confidence)}` };
  }
  const showup = page.locator("#showup");
  if (await showup.count() === 1) {
    const showupText = String(await showup.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/已签到|已簽到|showed up/i.test(showupText)) {
      return { status: "signed", reason: `HDSky 图片验证码识别成功（置信度 ${Math.round(recognition.confidence)}）` };
    }
  }
  if (await page.locator("#showupimg").count() === 0) {
    return { status: "clicked", reason: `已提交 NexusPHP 图片验证码（置信度 ${Math.round(recognition.confidence)}）` };
  }
  return { status: "interactive_challenge", reason: "NexusPHP 图片验证码提交后仍显示验证弹窗" };
}

async function tryU2Captcha(page, expectedOrigin, config) {
  if (expectedOrigin !== "https://u2.dmhy.org") return null;
  const buttons = page.locator('input[type="submit"][name^="captcha_"]');
  if (await buttons.count() < 2) return null;
  const image = page.locator('img[alt="captcha"]');
  if (await image.count() !== 1) {
    return { status: "interactive_challenge", reason: "U2 验证题缺少题图" };
  }
  try {
    await page.waitForFunction(() => {
      const element = document.querySelector('img[alt="captcha"]');
      return Boolean(element?.complete && element.naturalWidth > 0 && element.naturalHeight > 0);
    }, null, { timeout: 50000 });
  } catch {
    return { status: "interactive_challenge", reason: "U2 验证题图片加载超时" };
  }
  const options = await buttons.evaluateAll((elements) => elements.map((element) => ({
    name: element.name,
    text: element.value,
  })));
  const screenshot = await image.screenshot();
  const solution = await solveU2VisualChallenge(screenshot, options);
  if (!solution.answer?.name) {
    return { status: "interactive_challenge", reason: `U2 本地视觉识别未得出可靠答案：${solution.reason}` };
  }
  const message = page.locator('textarea[name="message"]');
  if (await message.count() !== 1) return { status: "interactive_challenge", reason: "U2 留言框不存在" };
  await message.fill(String(config.u2Message || "今日天气不错"));
  const chosen = page.locator(`input[type="submit"][name="${solution.answer.name}"]`);
  if (await chosen.count() !== 1) return { status: "interactive_challenge", reason: "U2 识别答案不属于当前题目" };
  await chosen.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  if (/(回答正確|回答正确|簽到成功|签到成功|獎勵UCoin|奖励UCoin|今日已簽到|今天已签到)/i.test(bodyText)) {
    return {
      status: "signed",
      reason: `U2 图片题识别正确：${solution.answer.text}`,
    };
  }
  return { status: "interactive_challenge", reason: "U2 答案已提交，但页面未显示签到成功" };
}

async function processCandidate(page, target, candidateUrl, config, qaRules) {
  const allowedOrigins = target.allowedOrigins ?? [target.origin];
  const useNewApiCheckin = shouldTryGenericNewApiCheckin(target, config.newApiCheckinOrigins);
  const useExtendedDiscovery = targetUsesConfiguredOrigins(target, config.extendedDiscoveryOrigins);
  const destination = assertBookmarkNavigation(candidateUrl, allowedOrigins);
  await page.goto(destination, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
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
  const u2Result = await tryU2Captcha(page, activeOrigin, config);
  if (u2Result) return { ...u2Result, url: safeLogUrl(page.url()) };

  const initialBmapiStatus = await tryBmapiCheckinStatus(page, activeOrigin);
  if (initialBmapiStatus && initialBmapiStatus.status !== "ready") {
    return { ...initialBmapiStatus, url: safeLogUrl(page.url()) };
  }

  const newApiSignInStatus = await tryNewApiSignIn(page, activeOrigin, config);
  if (newApiSignInStatus) return { ...newApiSignInStatus, url: safeLogUrl(page.url()) };

  const oauthReloginStatus = await tryOAuthReloginCheckinStatus(page, activeOrigin, config);
  if (oauthReloginStatus) return { ...oauthReloginStatus, url: safeLogUrl(page.url()) };

  // New API exposes an authoritative current-day status endpoint.  Query it
  // before interpreting generic page copy such as “每日签到可获得奖励”, which is
  // a feature description rather than proof that today's check-in succeeded.
  let initialApiResult = null;
  if (useNewApiCheckin) {
    initialApiResult = await tryNewApiCheckin(page);
    if (initialApiResult && initialApiResult.status !== "not_available") {
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

  const qaResult = await tryQaFlow(page, qaRules, activeOrigin, config);
  if (qaResult) return { ...qaResult, url: safeLogUrl(page.url()) };

  let action = await findCheckinAction(page, allowedOrigins);
  if (!action && useExtendedDiscovery) {
    const discoveryUrls = await findCheckinDiscoveryUrls(page, activeOrigin);
    for (const discoveryUrl of discoveryUrls) {
      if (discoveryUrl === page.url()) continue;
      await navigateDiscoveryUrl(page, discoveryUrl, allowedOrigins, config);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      state = await waitForManagedChallenge(page, config);
      state = await classifyManualAttention(page, state, activeOrigin, config);
      if (state.status !== "ready") return { ...state, url: safeLogUrl(page.url()) };
      await dismissBlockingModal(page, config);
      action = await findCheckinAction(page, allowedOrigins);
      if (action) break;
    }
  }
  if (action) {
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
      const quotaResult = await tryQuotaRequestFlow(page, activeOrigin, config);
      if (quotaResult) return { ...quotaResult, action: `${action.text} → 申请理由`, url: safeLogUrl(page.url()) };
    }

    const openCdResult = await tryOpenCdCaptcha(page, activeOrigin);
    if (openCdResult) return { ...openCdResult, action: action.text, url: safeLogUrl(page.url()) };
    const nexusCaptchaResult = await tryNexusImageCaptcha(page);
    if (nexusCaptchaResult) return { ...nexusCaptchaResult, action: action.text, url: safeLogUrl(page.url()) };

    const secondAction = await findCheckinAction(page, allowedOrigins, action);
    if (secondAction) {
      await clickCandidate(page, secondAction);
      await sleep(/转动|轉動/.test(secondAction.text) ? Math.max(config.actionWaitMs, 8000) : config.actionWaitMs);
      activeUrl = assertBookmarkNavigation(page.url(), allowedOrigins);
      activeOrigin = new URL(activeUrl).origin;
      state = await waitForManagedChallenge(page, config);
      state = await classifyManualAttention(page, state, activeOrigin, config);
      if (["signed", "already_signed", "login_required", "needs_attention", "interactive_challenge", "managed_challenge_timeout", "deferred"].includes(state.status)) {
        return { ...state, action: `${action.text} → ${secondAction.text}`, url: safeLogUrl(page.url()) };
      }
      return {
        status: "clicked",
        reason: "已依次点击明确的签到流程控件",
        action: `${action.text} → ${secondAction.text}`,
        url: safeLogUrl(page.url()),
      };
    }
    return { status: "clicked", reason: "已点击明确的签到控件", action: action.text, url: safeLogUrl(page.url()) };
  }

  if (/(attendance|check[-_]?in|showup)\.(php|asp)|\/(attendance|check[-_]?in|showup)(?:[/?#]|$)/i.test(activeUrl)) {
    return { status: "visited", reason: "已访问打开即签到的网址", url: safeLogUrl(page.url()) };
  }

  if (useNewApiCheckin) {
    const apiResult = initialApiResult ?? await tryNewApiCheckin(page);
    if (apiResult) return { ...apiResult, url: safeLogUrl(page.url()) };
  }
  if ((config.knownNoCheckinFeatureOrigins ?? []).includes(activeOrigin)) {
    return { status: "not_available", reason: "站点当前版本未提供签到功能", url: safeLogUrl(page.url()) };
  }

  return { status: "no_action", reason: "未发现明确签到控件", url: safeLogUrl(page.url()) };
}

async function saveFailureScreenshot(page, logDirectory, target) {
  const host = new URL(target.origin).hostname.replace(/[^a-z0-9.-]/gi, "_");
  const file = path.join(logDirectory, `${host}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

export async function launchAutomationContext(config) {
  await fs.access(config.chromeExecutable);
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
    serviceWorkers: "allow",
    args: [
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-component-update",
      "--disable-features=" + disabledFeatures.join(","),
      "--disable-blink-features=AutomationControlled",
      ...(config.backgroundWindowMode === "offscreen" ? ["--window-position=-32000,-32000", "--window-size=1365,900"] : []),
      ...(config.backgroundWindowMode === "visible" ? ["--window-position=80,80", "--window-size=1365,900"] : []),
    ],
  });
  for (const [origin, relativeFile] of Object.entries(config.siteStorageBootstrap ?? {})) {
    const storagePath = path.resolve(rootDirectory, String(relativeFile));
    const allowedRoot = path.resolve(rootDirectory, "data");
    if (!storagePath.startsWith(`${allowedRoot}${path.sep}`)) continue;
    const value = await fs.readFile(storagePath, "utf8").then(JSON.parse).catch(() => null);
    if (value?.origin !== origin || !Array.isArray(value.local) || !Array.isArray(value.session)) continue;
    const local = filterExpiredBootstrapLocalEntries(value.local);
    const session = value.session.filter((entry) => Array.isArray(entry) && entry.length === 2 && entry.every((item) => typeof item === "string"));
    await context.addInitScript(({ expectedOrigin, localEntries, sessionEntries, marker }) => {
      if (location.origin !== expectedOrigin) return;
      if (sessionStorage.getItem(marker) === expectedOrigin) return;
      sessionStorage.setItem(marker, expectedOrigin);
      for (const [key, item] of localEntries) {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, item);
      }
      for (const [key, item] of sessionEntries) {
        if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, item);
      }
    }, { expectedOrigin: origin, localEntries: local, sessionEntries: session, marker: "__codex_storage_bootstrap_applied_v1" });
  }
  return context;
}

export async function writeSiteStorageSnapshot(storagePath, value) {
  await fs.mkdir(path.dirname(storagePath), { recursive: true });
  const temporary = `${storagePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.copyFile(storagePath, `${storagePath}.bak`).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await fs.rename(temporary, storagePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function persistSiteStorage(page, target, config, result) {
  if (!shouldPersistSiteStorage(result)) return;
  const relativeFile = config.siteStorageBootstrap?.[target.origin];
  if (!relativeFile) return;
  let activeOrigin;
  try { activeOrigin = new URL(page.url()).origin; } catch { return; }
  if (activeOrigin !== target.origin) return;
  if (/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(page.url())) return;
  const visiblePassword = await page.locator('input[type="password"]:visible').count().catch(() => 0);
  if (visiblePassword > 0) return;
  const storagePath = path.resolve(rootDirectory, String(relativeFile));
  const allowedRoot = path.resolve(rootDirectory, "data");
  if (!storagePath.startsWith(`${allowedRoot}${path.sep}`)) return;
  const storage = await page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
  await writeSiteStorageSnapshot(storagePath, {
    version: 1,
    origin: target.origin,
    capturedAt: new Date().toISOString(),
    ...storage,
  });
}

export async function processTarget(context, target, config, qaRules, logDirectory) {
  const configuredSkip = configuredTargetSkip(target, config);
  if (configuredSkip) return { ...configuredSkip, attempt: 0, candidateHistory: [] };
  let lastResult = null;
  const candidateHistory = [];
  for (let attempt = 0; attempt <= config.retryCount; attempt += 1) {
    const page = await context.newPage();
    let attemptResult = null;
    try {
      for (const candidateUrl of target.candidates) {
        let result;
        try {
          result = withRetrySchedule(
            await processCandidate(page, target, candidateUrl, config, qaRules),
            config,
          );
        } catch (error) {
          result = {
            status: "error",
            reason: safeErrorMessage(error),
            url: safeLogUrl(page.url()),
          };
        }
        candidateHistory.push(candidateHistoryEntry(candidateUrl, result, attempt + 1));
        attemptResult = preferCandidateResult(attemptResult, result);
        lastResult = preferCandidateResult(lastResult, result);
        // A logical bookmark target can contain multiple related URLs.  One
        // public/API URL may require login while another dedicated check-in
        // URL already has a valid session, so only a completed result should
        // prevent trying the remaining candidates.
        if (COMPLETED.has(result.status)) break;
      }

      const effectiveResult = preferCandidateResult(lastResult, attemptResult);
      if (effectiveResult && !CHALLENGE.has(effectiveResult.status)
        && (!UNCONFIRMED.has(effectiveResult.status) || attempt === config.retryCount)) {
        if (config.failureScreenshots && !COMPLETED.has(effectiveResult.status) && effectiveResult.status !== "login_required") {
          effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        }
        return { ...effectiveResult, attempt: attempt + 1, candidateHistory };
      }
      if (effectiveResult?.status === "interactive_challenge") {
        if (config.failureScreenshots) effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
        return { ...effectiveResult, attempt: attempt + 1, candidateHistory };
      }
      if (effectiveResult && CHALLENGE.has(effectiveResult.status) && attempt === config.retryCount && config.failureScreenshots) {
        effectiveResult.screenshot = await saveFailureScreenshot(page, logDirectory, target);
      }
    } catch (error) {
      const result = { status: "error", reason: safeErrorMessage(error), url: safeLogUrl(page.url()) };
      candidateHistory.push(candidateHistoryEntry(page.url(), result, attempt + 1));
      attemptResult = preferCandidateResult(attemptResult, result);
      lastResult = preferCandidateResult(lastResult, result);
      if (config.failureScreenshots) {
        try { result.screenshot = await saveFailureScreenshot(page, logDirectory, target); } catch { /* 页面可能已经关闭 */ }
      }
    } finally {
      await persistSiteStorage(page, target, config, attemptResult).catch(() => {});
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
