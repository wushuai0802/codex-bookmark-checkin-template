import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { processTarget } from "../src/browser.mjs";
import { guardPtSubmission, knownPtDialogOpener } from "../src/pt-submission-guard.mjs";

const origin = "https://u2.dmhy.org";
const opener = { tagName: "A", text: "立即簽到", href: origin + "/showup.php", formAction: null };

test("U2 only exempts the exact GET link that opens its question form", () => {
  for (const text of ["立即簽到", "立即签到"]) assert.equal(knownPtDialogOpener(origin, { ...opener, text }), true);
  const userinfoLink = new URL(opener.href);
  userinfoLink.username = "fixture";
  const rejected = [
    { ...opener, tagName: "INPUT", href: null, formAction: origin + "/showup.php" },
    { ...opener, tagName: "BUTTON" },
    { ...opener, text: "签到" },
    { ...opener, text: "[立即签到]" },
    { ...opener, href: origin + "/showup.php?submit=1" },
    { ...opener, href: origin + "/showup.php#answer" },
    { ...opener, href: origin + "/showup.php/" },
    { ...opener, href: "https://other.invalid/showup.php" },
    { ...opener, href: "http://u2.dmhy.org/showup.php" },
    { ...opener, href: userinfoLink.href },
    { ...opener, href: "/showup.php" },
    { ...opener, formAction: origin + "/showup.php" },
  ];
  for (const action of rejected) assert.equal(knownPtDialogOpener(origin, action), false);
  assert.equal(knownPtDialogOpener("https://other.invalid", opener), false);
});

test("U2 answer submission still invokes the PT gate after its opener was exempted", async () => {
  let gateChecks = 0;
  const opened = await guardPtSubmission(async beforeSubmit => {
    if (!knownPtDialogOpener(origin, opener)) beforeSubmit();
    return { status: "interactive_challenge", reason: "U2 验证题缺少题图", submissionAttempted: false };
  }, () => { gateChecks++; return null; });
  assert.equal(opened.submissionAttempted, false);
  assert.equal(gateChecks, 0);

  const answerSubmit = { tagName: "INPUT", text: "立即签到", href: null, formAction: origin + "/showup.php" };
  const submitted = await guardPtSubmission(async beforeSubmit => {
    if (!knownPtDialogOpener(origin, answerSubmit)) beforeSubmit();
    return { status: "interactive_challenge", submissionAttempted: false };
  }, () => { gateChecks++; return null; });
  assert.equal(gateChecks, 1);
  assert.equal(submitted.submissionAttempted, true);
  assert.equal(submitted.failureCode, "submission_outcome_unknown");
});

test("U2 homepage-to-question navigation runs the dedicated solver before generic CAPTCHA classification", async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext();
  const visits = [];
  let submissions = 0;
  const auth = '<a href="/logout.php">退出</a><a href="/usercp.php">设置</a><a href="/userdetails.php?id=7">本人</a>';
  try {
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      visits.push({ path: url.pathname, method: request.method() });
      if (request.method() !== "GET") submissions++;
      const body = url.pathname === "/index.php"
        ? auth + '<div id="info_block"><a href="/showup.php">立即簽到</a></div>'
        : auth + '<form class="captcha" method="post" action="/showup.php"><textarea name="message"></textarea>'
          + '<input type="submit" name="captcha_a" value="Reference A"><input type="submit" name="captcha_b" value="Reference B"></form>';
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    });
    const result = await processTarget(context, {
      origin,
      candidates: [origin + "/index.php"],
      allowedOrigins: [origin],
      folderNames: ["PT"],
    }, {
      retryCount: 0,
      failureScreenshots: false,
      navigationTimeoutMs: 5000,
      cloudflareWaitMs: 1000,
      actionWaitMs: 1,
      ptReadOnlyPolicies: {
        [origin]: { reviewed: true, mode: "safe_history_page", url: origin + "/index.php", selector: "#info_block", nativeMainChrome: true },
      },
    }, [], "");
    assert.ok(visits.some(visit => visit.path === "/index.php"));
    assert.ok(visits.some(visit => visit.path === "/showup.php"));
    assert.equal(submissions, 0);
    assert.equal(result.status, "interactive_challenge");
    assert.equal(result.reason, "U2 验证题缺少题图");
    assert.equal(result.submissionAttempted, false);
    assert.equal(result.candidateHistory.length, 1);
  } finally {
    await context.close();
    await browser.close();
  }
});
