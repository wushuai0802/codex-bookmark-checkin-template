import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBookmarkTarget } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { assertBookmarkNavigation, safeLogUrl } from "./security.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const requestedUrl = process.argv[3] || null;
if (!requestedOrigin) throw new Error("用法: node src/inspect-target.mjs <origin>");

const { target } = await findBookmarkTarget(config.bookmarksPath, requestedOrigin, config);

const context = await launchAutomationContext(config);
try {
  const candidates = requestedUrl ? [assertBookmarkNavigation(requestedUrl, target.allowedOrigins ?? [target.origin])] : target.candidates;
  for (const candidate of candidates) {
    const page = await context.newPage();
    try {
      await page.goto(assertBookmarkNavigation(candidate, target.allowedOrigins ?? [target.origin]), {
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      });
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      if (process.argv.includes("--click-showup")) {
        const showup = page.locator("#showup");
        if (await showup.count() !== 1) throw new Error("没有找到唯一的 #showup 控件");
        await showup.click();
        await page.waitForTimeout(3000);
        const captcha = page.locator("#showupimg");
        if (await captcha.count() === 1) {
          await captcha.screenshot({ path: path.join(rootDirectory, "tmp", "inspect-showup-captcha.png") });
        }
      }
      const leichiSamples = [];
      if (process.argv.includes("--click-leichi")) {
        const leichi = page.locator("button#sl-check");
        if (await leichi.count() !== 1) throw new Error("没有找到唯一的雷池确认控件");
        await leichi.click();
        for (const delay of [500, 1500, 3000, 5000, 8000]) {
          await page.waitForTimeout(delay - (leichiSamples.at(-1)?.delay ?? 0));
          leichiSamples.push(await page.evaluate((sampleDelay) => ({
            delay: sampleDelay,
            url: location.href,
            buttonDisplay: getComputedStyle(document.querySelector("#sl-check") ?? document.body).display,
            text: String(document.querySelector("#sl-text")?.textContent || "").replace(/\s+/g, " ").trim(),
            error: String(document.querySelector("#sl-error-msg")?.textContent || "").replace(/\s+/g, " ").trim(),
            bodyText: String(document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1000),
          }), delay));
        }
      }
      const detail = await page.evaluate(() => {
        const bodyText = String(document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20000);
        const controls = [...document.querySelectorAll('a, button, input, select, textarea, [role="button"]')]
          .slice(0, 300)
          .map((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
            const type = element instanceof HTMLInputElement ? element.type : null;
            return {
              tag: element.tagName,
              type,
              name: element.getAttribute("name"),
              id: element.id || null,
              text: String(element.innerText || (type === "password" ? "" : element.value) || element.getAttribute("aria-label") || "")
                .replace(/\s+/g, " ").trim().slice(0, 300),
              href: element instanceof HTMLAnchorElement ? element.href : null,
              onclick: element.getAttribute("onclick"),
              visible,
            };
          })
          .filter((item) => item.visible);
        const pageFunctions = {
          signin: typeof window.signin === "function" ? String(window.signin).slice(0, 5000) : null,
          initshowupajax: typeof window.initshowupajax === "function" ? String(window.initshowupajax).slice(0, 10000) : null,
        };
        const specialHtml = String(document.querySelector("#imagestring")?.parentElement?.parentElement?.outerHTML || "").slice(0, 20000);
        const showupHtml = String(document.querySelector("#showup")?.outerHTML || "").slice(0, 5000);
        const frames = [...document.querySelectorAll("iframe")].map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return {
            id: element.id || null,
            name: element.name || null,
            src: element.src || null,
            visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
            rect: rect.toJSON(),
          };
        });
        const visibleSurfaces = [...document.querySelectorAll("canvas, svg, [onclick], [role], body *")]
          .slice(0, 1000)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
            const interesting = /确认|合法用户|客户端异常/.test(text)
              || ["CANVAS", "SVG"].includes(element.tagName)
              || Boolean(element.getAttribute("onclick") || element.getAttribute("role"));
            if (!interesting || style.display === "none" || style.visibility === "hidden" || rect.width <= 0 || rect.height <= 0) return null;
            return {
              tag: element.tagName,
              id: element.id || null,
              className: typeof element.className === "string" ? element.className : null,
              role: element.getAttribute("role"),
              text: text.slice(0, 500),
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              html: String(element.outerHTML || "").slice(0, 1000),
            };
          })
          .filter(Boolean)
          .slice(0, 100);
        return { bodyText, controls, pageFunctions, frames, specialHtml, showupHtml, visibleSurfaces };
      });
      const screenshotPath = path.join(rootDirectory, "tmp", `inspect-${new URL(target.origin).hostname.replace(/[^a-z0-9.-]/gi, "_")}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(JSON.stringify({ candidate, url: safeLogUrl(page.url()), title: await page.title(), screenshotPath, leichiSamples, ...detail }, null, 2));
    } finally {
      await page.close().catch(() => {});
    }
  }
} finally {
  await context.close();
}
