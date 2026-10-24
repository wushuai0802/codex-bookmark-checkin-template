import { createRequire } from "node:module";
import crypto from 'node:crypto';
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acceptConfiguredLoginTerms, waitForLoginSubmitEnabled } from "./protected-login-flow.mjs";
import { connectOverCdpWithRetry } from "./native-cdp.mjs";
import { safeLogUrl } from "./security.mjs";
import { isCredentialLoginRoute } from "./url-routes.mjs";
import { classifyPageText, readPageTwoFactorStructure } from "./detector.mjs";
import { recoverHhclubTwoFactorLogin, verifyHhclubNativeProfile,fillNexusBitwardenCredentials } from "./hhclub-two-factor-login.mjs";
import {recoverPiggoPasswordLogin,piggoPasswordLoginEnabled,guardPiggoPasswordAutofill} from './native-pt-two-factor.mjs';
import {readNativePtApiHeaderInContext,piggoNativePassiveContext} from './native-pt-api.mjs';
import {waitForNativePasswordLoginPage} from './login-recovery.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const port = Number.parseInt(process.argv[2], 10);
const expectedOrigin = new URL(process.argv[3]).origin;
const actualProfile = path.resolve(rootDirectory, process.argv[4] || config.automationUserDataDir || "");
const hhclub = expectedOrigin === "https://hhanclub.net";
const hddolbyLogin=expectedOrigin==='https://www.uhddolby.com'&&config.siteTwoFactorRecovery?.[expectedOrigin]?.allowPasswordLogin===true;
if (!Number.isInteger(port) || port <= 0) throw new Error("用法: node src/native-login.mjs <port> <origin>");

const browser = await connectOverCdpWithRetry(chromium, port, { timeoutMs: 20000 });
let status = "needs_attention";
let failureCode = null;
let page = null;
let twoFactorRecovery = null;
try {
  page = await waitForNativePasswordLoginPage(()=>browser.contexts().flatMap((context) => context.pages()),expectedOrigin);
  if (!page) throw new Error("原生 Chrome 中没有找到目标登录页");
  if(piggoPasswordLoginEnabled(config,expectedOrigin)||hddolbyLogin)await guardPiggoPasswordAutofill(page,expectedOrigin);
  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await acceptConfiguredLoginTerms(page, expectedOrigin, config);
  const password = page.locator('input[type="password"]:visible');
  const namedUsername=page.locator('input[name="username"]:visible');
  const username = hhclub || await namedUsername.count()===1 ? namedUsername : page.locator('input[type="email"]:visible, input[name*="user" i]:visible, input[name*="login" i]:visible, input[name*="email" i]:visible, input[type="text"]:visible');
  if (await password.count() !== 1 || await username.count() !== 1) {
    status = "unsupported";
  } else {
    const fieldsFilled = async () => Boolean(
      await username.evaluate((element) => Boolean(element.value))
      && await password.evaluate((element) => Boolean(element.value))
    );
    let filled = await fieldsFilled();
    if(hddolbyLogin){
      const imported=await fillNexusBitwardenCredentials({root:rootDirectory,origin:expectedOrigin,config,page,profile:actualProfile,
        profileProof:()=>verifyHhclubNativeProfile(actualProfile,port)});
      filled=imported.filled===true&&await fieldsFilled();
      if(imported.authenticated===true)twoFactorRecovery={handled:true,status:'logged_in',siteTwoFactorRecovery:{attempted:false,accepted:false,reason:'already_authenticated'}};
    }
    if (!filled&&!hddolbyLogin) {
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
      const submitReady = submit
        ? await waitForLoginSubmitEnabled(page, submit, expectedOrigin, config)
        : false;
      if (submit && challengeReady && submitReady) {
        let assisted = await recoverHhclubTwoFactorLogin({root:rootDirectory,origin:expectedOrigin,config,page,
          profile:actualProfile,submit:()=>submit.click(),profileProof:()=>verifyHhclubNativeProfile(actualProfile,port)});
        if(!assisted.handled)assisted=await recoverPiggoPasswordLogin({root:rootDirectory,origin:expectedOrigin,page,
          profile:actualProfile,submit:()=>submit.click(),profileProof:()=>verifyHhclubNativeProfile(actualProfile,port)});
        if (assisted.handled) {
          twoFactorRecovery = assisted;
          status = assisted.status;
          failureCode = assisted.failureCode ?? null;
        } else {
        await submit.click();
        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
        await page.waitForFunction(() => {
          const visiblePassword = [...document.querySelectorAll('input[type="password"]')].some((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          });
          return !visiblePassword || !isCredentialLoginRoute(location.href);
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
      } else if (submit && !submitReady) status = "needs_attention";
    }
  }

  const finalLocation = new URL(page.url());
  const visiblePassword = await page.locator('input[type="password"]:visible').count() > 0;
  if ((hhclub||hddolbyLogin) && !twoFactorRecovery?.handled && !visiblePassword) {
    const assisted = await recoverHhclubTwoFactorLogin({root:rootDirectory,origin:expectedOrigin,config,page,
      profile:actualProfile,submit:async()=>{throw new Error("Login form unavailable");},
      profileProof:()=>verifyHhclubNativeProfile(actualProfile,port)});
    if (assisted.handled) twoFactorRecovery = assisted;
  }
  const finalState = classifyPageText({
    url: page.url(),
    title: await page.title(),
    bodyText: await page.locator("body").innerText().catch(() => ""),
    hasPassword: visiblePassword,
    ...await readPageTwoFactorStructure(page),
  });
  if (twoFactorRecovery?.handled) {
    status = twoFactorRecovery.status;
    failureCode = twoFactorRecovery.failureCode ?? null;
  } else if (finalState.failureCode === "two_factor_required") {
    status = "needs_attention";
    failureCode = finalState.failureCode;
  } else if (finalLocation.origin === expectedOrigin
    && !isCredentialLoginRoute(finalLocation.href)
    && !visiblePassword) {
    status = "logged_in";
  }
  if(expectedOrigin==='https://piggo.me'&&status==='logged_in'&&config.ptReadOnlyPolicies?.[expectedOrigin]?.nativeApiHeaderFallback===true){
    const key=process.platform==='win32'?actualProfile.toLowerCase():actualProfile;
    const verified=await readNativePtApiHeaderInContext({root:rootDirectory,origin:expectedOrigin,context:piggoNativePassiveContext(page),
      expectedProfileBinding:crypto.createHash('sha256').update(key).digest('hex'),
      profileProof:()=>verifyHhclubNativeProfile(actualProfile,port)});
    if(!['already_signed','not_signed'].includes(verified.status)||verified.evidence?.authoritative!==true){
      status='needs_attention';failureCode=verified.status==='login_required'?'login_required':'two_factor_required';
    }
  }
  if (status === "logged_in") await page.waitForTimeout(3000);
  console.log(JSON.stringify({
    origin: expectedOrigin,
    status,
    ...(twoFactorRecovery?.siteTwoFactorRecovery ? { siteTwoFactorRecovery: twoFactorRecovery.siteTwoFactorRecovery } : {}),
    ...(twoFactorRecovery?.nativeTwoFactorRecovery ? { nativeTwoFactorRecovery: twoFactorRecovery.nativeTwoFactorRecovery } : {}),
    ...(failureCode ? { failureCode, attentionKind: "trusted_device_initialization" } : {}),
    finalUrl: safeLogUrl(page.url()),
    title: await page.title(),
  }));
  if (status !== "logged_in") process.exitCode = 2;
} catch(error){
  if(page)throw error;
  const pageKinds=browser.contexts().flatMap(context=>context.pages()).map(candidate=>{
    try{const url=new URL(candidate.url());return url.origin===expectedOrigin?'site':url.protocol==='about:'?'blank':
      url.protocol==='chrome-error:'?'network_error':'other';}catch{return 'unavailable';}
  });
  console.log(JSON.stringify({origin:expectedOrigin,status:'needs_attention',failureCode:'browser_startup',stage:'target_page',pageKinds}));
  process.exitCode=2;
} finally {
  await browser.close().catch(() => {});
}
