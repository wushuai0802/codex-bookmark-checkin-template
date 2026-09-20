import process from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

const [sourceUserDataDir, targetUserDataDir, requestedOrigin, executablePath, sessionStorageOutputPath] = process.argv.slice(2);
if (!sourceUserDataDir || !targetUserDataDir || !requestedOrigin || !executablePath || !sessionStorageOutputPath) {
  throw new Error("usage: Sync-ChromeSiteSession.mjs <source-user-data> <target-user-data> <origin> <chrome-executable> <session-storage-output>");
}

const requestedUrl = new URL(requestedOrigin);
if (requestedUrl.protocol !== "https:" || requestedUrl.username || requestedUrl.password) {
  throw new Error("目标页面必须是无凭据 HTTPS 地址");
}
const origin = requestedUrl.origin;
const commonOptions = {
  executablePath,
  headless: true,
  ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain", "--enable-automation"],
  args: [
    "--profile-directory=Default",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-component-update",
    "--disable-features=Translate,MediaRouter,OptimizationGuideOnDeviceModel",
  ],
};

async function openOrigin(context) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(requestedUrl.href, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  return page;
}

async function readStorage(page) {
  return page.evaluate(() => ({
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
  }));
}

async function openRestoredSourceOrigin(context) {
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const matchingPages = context.pages().filter((page) => {
    try { return new URL(page.url()).origin === origin; } catch { return false; }
  });
  if (matchingPages.length === 0) return openOrigin(context);

  const candidates = [];
  for (const page of matchingPages) {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
    const storage = await readStorage(page).catch(() => ({ local: [], session: [] }));
    const landing = await inspectLanding(page);
    candidates.push({ page, storage, landing });
  }
  candidates.sort((left, right) => (
    Number(right.landing.authenticated) - Number(left.landing.authenticated)
    || right.storage.session.length - left.storage.session.length
    || right.storage.local.length - left.storage.local.length
  ));
  return candidates[0].page;
}

async function inspectLanding(page) {
  const url = page.url();
  const bodyText = String(await page.locator("body").innerText().catch(() => ""));
  const visiblePassword = await page.locator('input[type="password"]:visible').count().catch(() => 0) > 0;
  const self = await page.evaluate(async () => {
    try {
      const ids = new Set();
      for (const storage of [localStorage, sessionStorage]) {
        for (let index = 0; index < storage.length; index += 1) {
          try {
            const value = JSON.parse(storage.getItem(storage.key(index)) || "null");
            const id = value?.id ?? value?.user?.id ?? value?.state?.user?.id ?? value?.data?.id ?? value?.data?.user?.id;
            if (id != null) ids.add(String(id));
          } catch { /* ignore unrelated browser storage */ }
        }
      }
      const headersToTry = [
        { Accept: "application/json" },
        ...[...ids].slice(0, 8).map((id) => ({ Accept: "application/json", "New-Api-User": id })),
      ];
      let supported = false;
      let rejected = false;
      for (const headers of headersToTry) {
        const response = await fetch("/api/user/self", { credentials: "include", headers });
        if (response.status === 404) continue;
        supported = true;
        const body = await response.json().catch(() => null);
        const message = String(body?.message || "");
        const id = body?.data?.id ?? body?.data?.user?.id ?? body?.user?.id ?? null;
        const denied = [401, 403].includes(response.status)
          || body?.success === false
          || /未登录|未登入|无权|未授权|unauthori[sz]ed|login required/i.test(message);
        if (response.ok && !denied && id != null) return { supported: true, authenticated: true };
        rejected ||= denied;
      }
      // LinuxDO is a Discourse site. Its authenticated session is exposed by
      // the current-session endpoint rather than New API's /api/user/self.
      if (location.origin === "https://linux.do") {
        try {
          const response = await fetch("/session/current.json", {
            credentials: "include",
            headers: { Accept: "application/json" },
          });
          supported ||= response.status !== 404;
          const body = await response.json().catch(() => null);
          const currentUser = body?.current_user ?? body?.user ?? null;
          if (response.ok && currentUser?.id != null) return { supported: true, authenticated: true };
          rejected ||= response.status === 401 || response.status === 403;
        } catch { /* continue with visible-page checks */ }
      }
      return { supported, authenticated: false, rejected };
    } catch {
      return { supported: false, authenticated: false };
    }
  }).catch(() => ({ supported: false, authenticated: false }));
  const loginRoute = /(?:#\/|\/)login(?:\.(?:php|asp|aspx|html?))?(?:[/?#]|$)|\/(?:sign-in|signin)(?:\.(?:php|asp|aspx|html?))?(?:[/?#]|$)/i.test(url);
  const explicitAccountUi = /退出登录|退出登入|登出|注销登录|個人中心|个人中心|个人设置|個人設定|账户设置|賬戶設置|log\s*out|sign\s*out|account\s+settings|api\s+keys?|current\s+balance/i.test(bodyText);
  const requestedAccountPage = new URL(url).origin === origin
    && /\/(?:profile|console|settings|account)(?:[/?#]|$)/i.test(new URL(url).pathname)
    && /个人|個人|账户|賬戶|余额|餘額|令牌|錢包|钱包|profile|account|balance|api\s+key|dashboard|console/i.test(bodyText)
    && !/404\s+not\s+found|page\s+not\s+found|页面不存在|頁面不存在/i.test(bodyText)
    && !visiblePassword;
  const hasBenefitUi = /领取\s*Codex\s*权益|当前套餐|剩余(?:额度|額度)/i.test(bodyText);
  return {
    loginRoute,
    hasBenefitUi,
    apiSelfSupported: self.supported,
    apiSelfAuthenticated: self.authenticated,
    authenticated: !loginRoute && !visiblePassword
      && (self.authenticated || explicitAccountUi || requestedAccountPage || hasBenefitUi),
  };
}

async function trySavedPasswordLogin(page) {
  const password = page.locator('input[type="password"]:visible').first();
  const username = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])').first();
  if (await password.count() < 1 || await username.count() < 1) return false;
  await username.click().catch(() => {});
  await username.press("ArrowDown").catch(() => {});
  await username.press("Enter").catch(() => {});
  await page.waitForTimeout(800);
  await password.click().catch(() => {});
  await password.press("ArrowDown").catch(() => {});
  await password.press("Enter").catch(() => {});
  await page.waitForTimeout(800);
  const filled = Boolean(
    await username.evaluate((element) => Boolean(element.value))
    && await password.evaluate((element) => Boolean(element.value))
  );
  if (!filled) return false;
  const submit = page.getByRole("button", { name: /^(?:用户)?登录$/ }).first();
  if (await submit.count() < 1) return false;
  await submit.click();
  await page.waitForFunction(() => {
    const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    return !visiblePassword || !/(?:#\/|\/)login(?:[/?#]|$)/i.test(location.href);
  }, null, { timeout: 15000 }).catch(() => {});
  return !(await inspectLanding(page)).loginRoute;
}

let sourceContext;
let targetContext;
try {
  sourceContext = await chromium.launchPersistentContext(sourceUserDataDir, {
    ...commonOptions,
    headless: false,
    args: [...commonOptions.args, "--restore-last-session", "--window-position=-32000,-32000", "--window-size=1365,900"],
  });
  const sourcePage = await openRestoredSourceOrigin(sourceContext);
  const initialSourceLanding = await inspectLanding(sourcePage);
  if (initialSourceLanding.loginRoute) await trySavedPasswordLogin(sourcePage);
  const sourceStorage = await readStorage(sourcePage);
  const extractedStorage = await fs.readFile(sessionStorageOutputPath, "utf8").then(JSON.parse).catch(() => null);
  if (sourceStorage.session.length === 0 && extractedStorage?.origin === origin && Array.isArray(extractedStorage.session)) {
    sourceStorage.session = extractedStorage.session;
  }
  const cookies = await sourceContext.cookies(origin);
  const sourceLanding = await inspectLanding(sourcePage);
  await sourceContext.close();
  sourceContext = null;

  if (!sourceLanding.authenticated) {
    const safeUrl = new URL(sourcePage.url());
    safeUrl.search = "";
    safeUrl.hash = "";
    throw new Error(`一次性影子配置未取得已登录页面，拒绝覆盖机器人现有会话（url=${safeUrl.href}; loginRoute=${sourceLanding.loginRoute}; apiSelf=${sourceLanding.apiSelfAuthenticated}; cookies=${cookies.length}; local=${sourceStorage.local.length}; session=${sourceStorage.session.length}）`);
  }

  if (sourceStorage.local.length === 0 && sourceStorage.session.length === 0 && cookies.length === 0) {
    throw new Error("源 Chrome 中没有找到该站点的会话数据");
  }

  await fs.mkdir(path.dirname(sessionStorageOutputPath), { recursive: true });
  const temporaryOutput = `${sessionStorageOutputPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryOutput, `${JSON.stringify({
    version: 1,
    origin,
    capturedAt: new Date().toISOString(),
    local: sourceStorage.local,
    session: sourceStorage.session,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryOutput, sessionStorageOutputPath);

  targetContext = await chromium.launchPersistentContext(targetUserDataDir, commonOptions);
  if (cookies.length > 0) await targetContext.addCookies(cookies);
  const targetPage = await openOrigin(targetContext);
  await targetPage.evaluate(({ local, session }) => {
    localStorage.clear();
    sessionStorage.clear();
    for (const [key, value] of local) localStorage.setItem(key, value);
    for (const [key, value] of session) sessionStorage.setItem(key, value);
  }, sourceStorage);
  await targetPage.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await targetPage.waitForTimeout(2500);
  const persistedStorage = await readStorage(targetPage);
  const targetLanding = await inspectLanding(targetPage);
  if (!targetLanding.authenticated) {
    const safeUrl = new URL(targetPage.url());
    safeUrl.search = "";
    safeUrl.hash = "";
    throw new Error(`会话转移后未通过登录验证，拒绝报告同步成功（url=${safeUrl.href}; loginRoute=${targetLanding.loginRoute}; apiSelf=${targetLanding.apiSelfAuthenticated}）`);
  }
  await targetContext.close();
  targetContext = null;

  process.stdout.write(JSON.stringify({
    copiedCookies: cookies.length,
    copiedLocalStorageEntries: sourceStorage.local.length,
    copiedSessionStorageEntries: sourceStorage.session.length,
    persistedLocalStorageEntries: persistedStorage.local.length,
    localStorageMatches: JSON.stringify(sourceStorage.local.sort()) === JSON.stringify(persistedStorage.local.sort()),
    sourceLoginRoute: sourceLanding.loginRoute,
    sourceHasBenefitUi: sourceLanding.hasBenefitUi,
    sourceAuthenticated: sourceLanding.authenticated,
    sourceApiSelfAuthenticated: sourceLanding.apiSelfAuthenticated,
    targetLoginRoute: targetLanding.loginRoute,
    targetHasBenefitUi: targetLanding.hasBenefitUi,
    targetAuthenticated: targetLanding.authenticated,
    targetApiSelfAuthenticated: targetLanding.apiSelfAuthenticated,
  }));
} finally {
  await sourceContext?.close().catch(() => {});
  await targetContext?.close().catch(() => {});
  await fs.rm(sessionStorageOutputPath, { force: true }).catch(() => {});
  await fs.rm(`${sessionStorageOutputPath}.bak`, { force: true }).catch(() => {});
}
