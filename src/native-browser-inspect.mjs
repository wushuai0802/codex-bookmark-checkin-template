import { createRequire } from "node:module";
import { classifyPageText } from "./detector.mjs";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const maxWaitSeconds = Math.max(0, Math.min(60, Number.parseInt(process.argv[4] || "0", 10) || 0));
const inspectionMode = process.argv[5] || "require-confirmed";
const allowEndpointReady = inspectionMode === "allow-endpoint";
const performNativeCheckin = inspectionMode === "native-checkin";
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-browser-inspect.mjs <port> <origin> [max-wait-seconds] [allow-endpoint|native-checkin]");

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
  if (expectedOrigin !== "https://bmapi.020212.xyz") return null;
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
    return { status: "not_available", reason: "斑马 API 签到接口确认未启用" };
  }
  if (response.body.data.checked_in === true) {
    return { status: "signed", reason: "原生 Chrome 完成斑马签到，API 接口已确认" };
  }
  return { status: "ready", reason: "斑马 API 接口确认今日尚未签到" };
}

let browser = null;
const connectDeadline = Date.now() + Math.max(5000, Math.min(15000, maxWaitSeconds * 1000));
while (!browser && Date.now() < connectDeadline) {
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 2000 });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (!browser) throw new Error("无法连接原生 Chrome 调试端口");
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
  let checkinStarted = false;
  let lastCheckboxClickAt = 0;
  const dismissedPrompts = [];
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
      const bmapiState = await getBmapiCheckinState(page);
      if (bmapiState && bmapiState.status !== "ready") state = bmapiState;

      if (performNativeCheckin && expectedOrigin === "https://bmapi.020212.xyz"
        && !["signed", "already_signed", "not_available"].includes(state.status)) {
        dismissedPrompts.push(...await dismissBlockingModals(page));
        if (!checkinStarted) {
          const action = page.getByRole("button", { name: /^(?:立即签到|立即簽到)$/, exact: true }).first();
          if (await action.count().catch(() => 0) === 1
            && await action.isVisible().catch(() => false)
            && await action.isEnabled().catch(() => false)) {
            await action.click({ timeout: 5000 });
            checkinStarted = true;
            await page.waitForTimeout(800);
          }
        }
      }

      if (performNativeCheckin && !snapshot.challengeTokenReady && Date.now() - lastCheckboxClickAt >= 4000) {
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
        lastCheckboxClickAt = clickedThisRound ? Date.now() : Date.now() - 3000;
      }
      if (performNativeCheckin && snapshot.challengeTokenReady && !checkinClicked) {
        const submit = page.locator("#checkin-submit");
        if (await submit.count() === 1 && await submit.isVisible() && await submit.isEnabled()) {
          await submit.click({ timeout: 5000 });
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
        checkinStarted,
        dismissedPrompts,
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
  console.log(JSON.stringify(output));
} finally {
  await browser.close().catch(() => {});
}
