import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAutomationContext } from "./browser.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedUrl = process.argv[2];
if (!requestedUrl) throw new Error("用法: node src/search-site-checkin.mjs <url>");
const expectedOrigin = new URL(requestedUrl).origin;
const pattern = /checkin_setting|\/api\/user\/(?:checkin|sign)|checkin[-_](?:status|history)|daily[-_]sign|签到|簽到/gi;

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(requestedUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const scriptUrls = await page.evaluate(() => [...new Set([
    ...[...document.querySelectorAll("script[src]")].map((element) => element.src),
    ...performance.getEntriesByType("resource").map((entry) => entry.name).filter((url) => /\.js(?:[?#]|$)/i.test(url)),
  ].filter(Boolean))]);
  const matches = [];
  let totalBytes = 0;
  for (const scriptUrl of [...new Set(scriptUrls)].slice(0, 40)) {
    if (new URL(scriptUrl).origin !== expectedOrigin) continue;
    const response = await context.request.get(scriptUrl, { timeout: config.navigationTimeoutMs }).catch(() => null);
    if (!response?.ok()) continue;
    const body = await response.body();
    totalBytes += body.length;
    if (totalBytes > 35 * 1024 * 1024) break;
    const text = body.toString("utf8");
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) && matches.length < 100) {
      matches.push({
        scriptUrl,
        term: match[0],
        excerpt: text.slice(Math.max(0, match.index - 250), Math.min(text.length, match.index + 500)),
      });
    }
    if (matches.length >= 100) break;
  }
  console.log(JSON.stringify({ requestedUrl, scriptCount: scriptUrls.length, totalBytes, matches }, null, 2));
} finally {
  await context.close();
}
