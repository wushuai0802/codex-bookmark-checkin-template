import { createRequire } from "node:module";
import { safeLogUrl } from "./security.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-login.mjs <port> <origin>");

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10000 });
let status = "needs_attention";
let page = null;
try {
  page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => {
    try { return new URL(candidate.url()).origin === expectedOrigin; } catch { return false; }
  });
  if (!page) throw new Error("原生 Chrome 中没有找到目标登录页");
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  const password = page.locator('input[type="password"]:visible');
  const username = page.locator('input[type="email"]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[name*="email" i]:visible, input[type="text"]:visible');
  if (await password.count() !== 1 || await username.count() !== 1) {
    status = "unsupported";
  } else {
    const fieldsFilled = async () => Boolean(
      await username.evaluate((element) => Boolean(element.value))
      && await password.evaluate((element) => Boolean(element.value))
    );
    let filled = await fieldsFilled();
    if (!filled) {
      // Chrome may anchor the password-manager popup to either field.  Trying
      // both also handles credentials saved on /sign-up but restored on
      // /sign-in without reading or printing either field's value.
      for (const field of [username, password, username]) {
        await field.click().catch(() => {});
        await field.press("ArrowDown").catch(() => {});
        await field.press("Enter").catch(() => {});
        await page.waitForTimeout(1000);
        filled = await fieldsFilled();
        if (filled) break;
      }
    }

    if (!filled) {
      status = "no_saved_credential";
    } else {
      const challengeDeadline = Date.now() + 55000;
      const challengeStartedAt = Date.now();
      let checkboxClicked = false;
      let challengeReady = false;
      while (Date.now() < challengeDeadline) {
        const challenge = await page.evaluate(() => {
          const response = document.querySelector('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
          const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i]');
          const widget = document.querySelector('.cf-turnstile, .g-recaptcha, .h-captcha, [data-sitekey]');
          return { solved: Boolean(response?.value && response.value.length > 20), hasFrame: Boolean(frame), hasWidget: Boolean(widget) };
        });
        if (challenge.solved) { challengeReady = true; break; }
        if (!challenge.hasFrame && !challenge.hasWidget && Date.now() - challengeStartedAt > 8000) {
          challengeReady = true;
          break;
        }
        if (!checkboxClicked) {
          const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
          const checkbox = frame.locator('input[type="checkbox"]');
          if (await checkbox.count().catch(() => 0) === 1) {
            await checkbox.click({ timeout: 5000 }).catch(() => {});
            checkboxClicked = true;
          }
        }
        await page.waitForTimeout(1500);
      }

      if (!challengeReady) {
        status = "needs_attention";
      }
      let submit = null;
      for (const label of ["登录", "登入", "Log in", "Sign in"]) {
        const candidate = page.getByRole("button", { name: label, exact: true });
        if (await candidate.count() === 1) { submit = candidate; break; }
      }
      if (!submit) {
        const candidate = page.locator('button[type="submit"]:visible, input[type="submit"]:visible');
        if (await candidate.count() === 1) submit = candidate;
      }
      if (submit && challengeReady) {
        await submit.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => {
          const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          return !visiblePassword || !/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(location.href);
        }, null, { timeout: 12000 }).catch(() => {});
        let stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
        if (stillHasPassword) {
          // Some forms render Turnstile only after the first submit.  Give the
          // newly-created widget one bounded native-browser pass, then submit
          // once more when its response token is present.
          const secondDeadline = Date.now() + 55000;
          const secondStartedAt = Date.now();
          let secondSolved = false;
          let secondCheckboxClicked = false;
          while (Date.now() < secondDeadline) {
            const challenge = await page.evaluate(() => {
              const response = document.querySelector('input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
              const frame = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
              const widget = document.querySelector('.cf-turnstile, [data-sitekey]');
              return { solved: Boolean(response?.value && response.value.length > 20), hasFrame: Boolean(frame), hasWidget: Boolean(widget) };
            });
            if (challenge.solved) { secondSolved = true; break; }
            if (!challenge.hasFrame && !challenge.hasWidget) {
              if (Date.now() - secondStartedAt > 8000) break;
              await page.waitForTimeout(1500);
              continue;
            }
            if (!secondCheckboxClicked) {
              const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile" i]');
              const checkbox = frame.locator('input[type="checkbox"]');
              if (await checkbox.count().catch(() => 0) === 1) {
                await checkbox.click({ timeout: 5000 }).catch(() => {});
                secondCheckboxClicked = true;
              }
            }
            await page.waitForTimeout(1500);
          }
          if (secondSolved) {
            await submit.click();
            await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
            await page.waitForFunction(() => !document.querySelector('input[type="password"]'), null, { timeout: 12000 }).catch(() => {});
            stillHasPassword = await page.locator('input[type="password"]:visible').count() > 0;
          }
        }
        status = stillHasPassword ? "needs_attention" : "logged_in";
      }
    }
  }

  const finalLocation = new URL(page.url());
  const visiblePassword = await page.locator('input[type="password"]:visible').count() > 0;
  if (finalLocation.origin === expectedOrigin
    && !/\/(?:log[-_]?in|sign[-_]?in|auth)(?:[/?#]|$)/i.test(finalLocation.href)
    && !visiblePassword) {
    status = "logged_in";
  }
  if (status === "logged_in") await page.waitForTimeout(3000);
  console.log(JSON.stringify({
    origin: expectedOrigin,
    status,
    finalUrl: safeLogUrl(page.url()),
    title: await page.title(),
  }));
  if (status !== "logged_in") process.exitCode = 2;
} finally {
  await browser.close().catch(() => {});
}
