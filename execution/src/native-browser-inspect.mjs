import { createRequire } from "node:module";
import { classifyPageText, scoreActionText } from "./detector.mjs";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(120, Number.parseInt(process.argv[4] || "0", 10) || 0));
const inspectionMode = process.argv[5] || "require-confirmed";
const reloadOnChallengeAfterSeconds = Math.max(
  0,
  Math.min(maxWaitSeconds, Number.parseInt(process.argv[6] || "0", 10) || 0),
);
const allowEndpointReady = inspectionMode === "allow-endpoint";
const performNativeCheckin = inspectionMode === "native-checkin";
const BMAPI_ORIGIN = "https://bmapi.020212.xyz";
const BMAPI_EXPIRED_CHALLENGE = /(?:验证码|驗證碼)(?:已)?(?:过期|過期)|重新(?:验证|驗證)/;
const nativeCheckinActionOrigins = new Set([
  BMAPI_ORIGIN,
  "https://audiences.me",
  "https://ourbits.club",
]);
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [allow-endpoint|native-checkin]");

const NATIVE_ACTION_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"]';

async function findNativeCheckinAction(page, mode = "start") {
  const raw = await page.locator(NATIVE_ACTION_SELECTOR).evaluateAll((elements) => {
    return elements.slice(0, 400).map((element, index) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        index,
        id: String(element.id || ""),
        text: String(element.innerText || element.value || element.getAttribute("aria-label") || element.title || "")
          .replace(/\s+/g, " ").trim(),
        visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        tagName: element.tagName,
        href: element instanceof HTMLAnchorElement ? element.href : null,
        formAction: element.form ? element.form.action : null,
      };
    });
  });
  return raw
    .map((candidate) => ({
      ...candidate,
      score: mode === "challenge-submit"
        ? (candidate.id === "checkin-submit" ? 120
          : (/^(?:提交|確認|确认|驗證|验证|签到|簽到|submit|verify|check[ -]?in)$/i.test(candidate.text)
            ? 100 : -1))
        : scoreActionText(candidate.text),
    }))
    .filter((candidate) => candidate.visible && !candidate.disabled && candidate.score >= 0)
    .filter((candidate) => {
      if (!candidate.href) return true;
      if (mode === "challenge-submit") return false;
      try {
        const href = new URL(candidate.href);
        if (href.origin !== expectedOrigin) return false;
        if (/(attendance|check[-_]?in|showup|bakatest|sign|签到|簽到)/i.test(href.href)) return true;
        return candidate.href.endsWith("#") && /^(?:\[?\s*)?(?:签到|簽到)(?:\s*\]?)$/i.test(candidate.text);
      } catch {
        return false;
      }
    })
    .filter((candidate) => {
      if (!candidate.formAction) return true;
      try { return new URL(candidate.formAction).origin === expectedOrigin; } catch { return false; }
    })
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

async function clickNativeCheckinAction(page, candidate) {
  await page.locator(NATIVE_ACTION_SELECTOR).nth(candidate.index).click({ timeout: 5000 });
}

async function dismissBlockingModals(page) {
  const labels = ["标记已读", "今天关闭", "今日关闭", "不再提示", "我知道了", "知道了", "关闭"];
  const dismissed = [];
  for (let pass = 0; pass < 5; pass += 1) {
    let clicked = null;
    for (const label of labels) {
      const button = page.getByRole("button", { name: label, exact: true });
      if (await button.count().catch(() => 0) > 0 && await button.first().isVisible().catch(() => false)) {
        await button.first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        dismissed.push(label);
        clicked = label;
        break;
      }
    }
    if (!clicked) break;
  }
  return dismissed;
}

async function getBmapiCheckinState(page) {
  if (expectedOrigin !== BMAPI_ORIGIN) return null;
  const endpoint = `${expectedOrigin}/api/v1/checkin/status?timezone=Asia%2FShanghai`;
  let response = null;
  try {
    const context = page.context();
    let authToken = null;
    if (typeof context?.storageState === "function") {
      const storage = await context.storageState();
      authToken = storage.origins?.find((item) => item.origin === expectedOrigin)?.localStorage
        ?.find((item) => item.name === "auth_token")?.value ?? null;
    }
    const request = context?.request;
    if (request?.get) {
      const headers = { accept: "application/json", ...(authToken ? { authorization: `Bearer ${authToken}` } : {}) };
      const value = await request.get(endpoint, { headers });
      response = { ok: value.ok(), body: await value.json() };
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
      return { ok: value.ok, body: await value.json() };
    } catch {
      return null;
    }
  }).catch(() => null);
  if (!response?.ok || response.body?.code !== 0 || !response.body?.data) return null;
  if (response.body.data.enabled === false) {
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
  if (response.body.data.checked_in === true) {
    return { status: "signed", reason: "原生 Chrome 完成斑马签到，API 接口已确认" };
  }
  return { status: "ready", reason: "斑马 API 接口确认今日尚未签到" };
}

const browser = await connectOverCdpWithRetry(chromium, port, {
  timeoutMs: Math.max(5000, Math.min(15000, maxWaitSeconds * 1000)),
});
try {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let page = null;
  while (!page && Date.now() <= deadline) {
    page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
      try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
    });
    if (!page) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!page) throw new Error("原生 Chrome 中没有找到目标站点页面");

  let output = null;
  let checkboxClicked = false;
  let checkinClicked = false;
  let challengeSubmitAttempted = false;
  let checkinStarted = false;
  let challengeDetectedAt = null;
  let challengeReloaded = false;
  let checkinRestartCount = 0;
  let widgetInteractionAttempted = false;
  const dismissedPrompts = [];
  const inspectionStartedAt = Date.now();
  do {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
      const snapshot = await page.evaluate(() => ({
      bodyText: String(document.body?.innerText || "").slice(0, 30000),
      htmlLength: String(document.documentElement?.outerHTML || "").length,
      readyState: document.readyState,
      webdriver: navigator.webdriver === true,
      leichiButton: Boolean(document.querySelector("#sl-check")),
      leichiText: String(document.querySelector("#sl-text")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300),
      hasPassword: [...document.querySelectorAll('input[type="password"]')].some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }),
      challengeSelectors: [...document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="turnstile" i], iframe[src*="challenge" i], .cf-turnstile, .h-captcha, .g-recaptcha, cap-widget, [data-cap-api-endpoint]')]
        .some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }) || document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]') !== null,
      challengeTokenReady: [...document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]')]
        .some((element) => String(element.value || "").length > 20),
      }));
      const title = await page.title();
      const explicitState = classifyPageText({
        url: page.url(),
        title,
        bodyText: snapshot.bodyText,
        hasPassword: snapshot.hasPassword,
        challengeSelectors: false,
      });
      let state = ["signed", "already_signed"].includes(explicitState.status) ? explicitState : classifyPageText({
        url: page.url(),
        title,
        bodyText: snapshot.bodyText,
        hasPassword: snapshot.hasPassword,
        challengeSelectors: snapshot.challengeSelectors,
      });
      if (!challengeReloaded
        && reloadOnChallengeAfterSeconds > 0
        && ["interactive_challenge", "managed_challenge"].includes(state.status)
        && Date.now() - inspectionStartedAt >= reloadOnChallengeAfterSeconds * 1000) {
        challengeReloaded = true;
        await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }
      const bmapiState = await getBmapiCheckinState(page);
      if (expectedOrigin === BMAPI_ORIGIN) {
        // Page copy can be stale after a challenge failure.  Only the
        // authenticated status endpoint may declare the Zebra check-in done.
        state = bmapiState ?? { status: "unconfirmed", reason: "斑马 API 暂未返回权威签到状态" };
      }

      const bmapiChallengeExpired = expectedOrigin === BMAPI_ORIGIN
        && BMAPI_EXPIRED_CHALLENGE.test(snapshot.bodyText);
      if (performNativeCheckin
        && bmapiChallengeExpired
        && bmapiState?.status === "ready"
        && checkinRestartCount < 1) {
        // An expired challenge leaves the modal in a terminal UI state. Reload
        // the dashboard and start the bounded native flow once more; the API
        // check above prevents a stale error message from repeating success.
        checkinRestartCount += 1;
        checkinStarted = false;
        checkinClicked = false;
        challengeSubmitAttempted = false;
        challengeDetectedAt = null;
        widgetInteractionAttempted = false;
        await page.reload({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);
        continue;
      }

      if (performNativeCheckin && nativeCheckinActionOrigins.has(expectedOrigin)
        && !["signed", "already_signed", "not_available"].includes(state.status)) {
        dismissedPrompts.push(...await dismissBlockingModals(page));
        if (!checkinStarted && snapshot.challengeSelectors) checkinStarted = true;
        if (!checkinStarted) {
          const action = await findNativeCheckinAction(page);
          if (action) {
            await clickNativeCheckinAction(page, action);
            checkinStarted = true;
            await page.waitForTimeout(800);
          }
        }
      }

      if (snapshot.challengeSelectors && challengeDetectedAt === null) challengeDetectedAt = Date.now();
      // Prefer passive verification in the real Chrome window.  Interact at
      // most once after eight seconds because repeated clicks during the
      // provider's verification phase can turn a slow success into a failure.
      if (performNativeCheckin
        && nativeCheckinActionOrigins.has(expectedOrigin)
        && snapshot.challengeSelectors
        && !snapshot.challengeTokenReady
        && !widgetInteractionAttempted
        && challengeDetectedAt !== null
        && Date.now() - challengeDetectedAt >= 8000) {
        widgetInteractionAttempted = true;
        let clickedThisRound = false;
        for (const frame of page.frames()) {
          const checkbox = frame.locator('#checkbox, [role="checkbox"], input[type="checkbox"]').first();
          if (await checkbox.count().catch(() => 0) === 1 && await checkbox.isVisible().catch(() => false)) {
            clickedThisRound = await checkbox.click({ timeout: 5000 }).then(() => true).catch(() => false);
            if (clickedThisRound) break;
          }
        }
        if (!clickedThisRound) {
          const widgetSurface = page.locator(
            '.h-captcha iframe, iframe[src*="hcaptcha" i], .turnstile-container iframe, iframe[src*="turnstile" i], .turnstile-container',
          ).first();
          const box = await widgetSurface.boundingBox().catch(() => null);
          if (box && box.width >= 250 && box.height >= 60) {
            clickedThisRound = await page.mouse.click(box.x + 25, box.y + box.height / 2)
              .then(() => true).catch(() => false);
          }
        }
        checkboxClicked = checkboxClicked || clickedThisRound;
      }
      if (performNativeCheckin
        && nativeCheckinActionOrigins.has(expectedOrigin)
        && snapshot.challengeTokenReady
        && !challengeSubmitAttempted) {
        challengeSubmitAttempted = true;
        const submit = await findNativeCheckinAction(page, "challenge-submit");
        if (submit) {
          await clickNativeCheckinAction(page, submit);
          checkinClicked = true;
          await page.waitForTimeout(1200);
          const confirmed = await getBmapiCheckinState(page);
          if (confirmed && confirmed.status !== "ready") state = confirmed;
        }
      }
      const attendanceEndpoint = /\/(?:attendance|check[-_]?in|showup)(?:\.php)?(?:[/?#]|$)/i.test(page.url());
      const siteBodyLoaded = snapshot.bodyText.trim().length > 80;
      output = {
        origin: expectedOrigin,
        url: safeLogUrl(page.url()),
        title,
        status: state.status,
        reason: state.reason,
        siteBodyLoaded,
        htmlLength: snapshot.htmlLength,
        readyState: snapshot.readyState,
        webdriver: snapshot.webdriver,
        leichiButton: snapshot.leichiButton,
        leichiText: snapshot.leichiText,
        challengeSelectors: snapshot.challengeSelectors,
        challengeTokenReady: snapshot.challengeTokenReady,
        checkboxClicked,
        checkinClicked,
        challengeSubmitAttempted,
        checkinStarted,
        dismissedPrompts,
        challengeReloaded,
        checkinRestartCount,
        attendanceEndpoint,
      };
      const explicitlyConfirmed = ["signed", "already_signed"].includes(state.status);
      const endpointReady = allowEndpointReady && state.status === "ready" && siteBodyLoaded && attendanceEndpoint;
      if (explicitlyConfirmed || endpointReady || Date.now() >= deadline) break;
    } catch {
      if (Date.now() >= deadline) throw new Error("原生页面在导航完成前超时");
    }
    await page.waitForTimeout(1000);
  } while (true);
  if (output?.checkinClicked === true && !["signed", "already_signed"].includes(output.status)) {
    output = {
      ...output,
      status: "needs_attention",
      reason: "原生 Chrome 已提交签到动作，但页面或接口未返回权威结果",
      failureCode: "submission_outcome_unknown",
      submissionAttempted: true,
      retryable: false,
    };
  }
  console.log(JSON.stringify(output));
} finally {
  await browser.close().catch(() => {});
}
