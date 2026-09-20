import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAutomationContext } from "./browser.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const requestedOrigin = process.argv[2];
const shouldPost = process.argv.includes("--post");
if (!requestedOrigin) throw new Error("用法: node src/checkin-api.mjs <origin> [--post]");
const origin = new URL(requestedOrigin).origin;

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto(new URL(requestedOrigin, origin).href, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  const month = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(new Date());
  const result = await page.evaluate(async ({ month, shouldPost }) => {
    let userId = null;
    for (const key of ["user", "user_info", "userInfo"]) {
      try {
        const value = JSON.parse(localStorage.getItem(key) || "null");
        userId = value?.id ?? value?.user?.id ?? null;
        if (userId != null) break;
      } catch { /* continue */ }
    }
    if (userId == null) {
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          try {
            const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
            userId = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? null;
            if (userId != null) break;
          } catch { /* continue */ }
        }
        if (userId != null) break;
      }
    }
    if (userId == null) {
      const visibleId = String(document.body?.innerText || "").match(/ID\s*[:：]\s*(\d+)/i);
      userId = visibleId?.[1] ?? null;
    }
    if (userId == null) {
      try {
        const selfResponse = await fetch("/api/user/self", { credentials: "include", headers: { Accept: "application/json" } });
        const selfBody = await selfResponse.json();
        userId = selfBody?.data?.id ?? selfBody?.data?.user?.id ?? null;
      } catch { /* continue without header */ }
    }
    const endpoint = shouldPost ? "/api/user/checkin" : `/api/user/checkin?month=${month}`;
    const response = await fetch(endpoint, {
      method: shouldPost ? "POST" : "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(userId == null ? {} : { "New-Api-User": String(userId) }),
      },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
    return { endpoint, status: response.status, ok: response.ok, userIdDetected: userId != null, body };
  }, { month, shouldPost });
  console.log(JSON.stringify({ origin, pageUrl: page.url(), title: await page.title(), method: shouldPost ? "POST" : "GET", ...result }, null, 2));
} finally {
  await context.close();
}
