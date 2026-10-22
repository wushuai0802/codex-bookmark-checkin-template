import test from "node:test";
import assert from "node:assert/strict";
import { processTarget, tryNexusImageCaptcha } from "../src/browser.mjs";
import { ptReadPolicy, readPtPassivePage } from "../src/pt-read-policy.mjs";
import { normalizeEvidence } from "../../observation/src/evidence-contract.mjs";

const reviewedOrigin = "https://ptsbao.club";
const dayAt = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);

// Synthetic page state only: no browser process, network, profile or credentials.
function captchaPage({
  origin = reviewedOrigin,
  responseText = "签到成功",
  headerText = "[已签到]",
  headerHttpStatus = 200,
  nullHeaderResponse = false,
} = {}) {
  let view = "form";
  let url = origin + "/attendance.php";
  let generation = 0;
  let submissions = 0;
  const navigations = [];
  const valueAt = value => typeof value === "function" ? value(submissions) : value;
  const bodyText = () => view === "response" ? valueAt(responseText)
    : view === "header" ? "欢迎回来 " + valueAt(headerText) : "签到 请填写图片代码";
  const locate = selector => {
    const isInput = selector.includes("imagestring");
    const isHash = selector.includes("imagehash");
    const isImage = selector.includes("#showupimg");
    const isSubmit = selector.includes("#showupbutton");
    const locator = {
      count: async () => selector === "xpath=ancestor::form[1]" ? 1
        : isInput || isHash || isImage || isSubmit ? Number(view === "form")
          : selector === "#showup" ? 0 : 1,
      locator: locate,
      screenshot: async () => Buffer.from("synthetic-challenge-" + generation),
      inputValue: async () => "synthetic-hash-" + generation,
      fill: async code => assert.match(code, /^[A-Z0-9]{6}$/),
      click: async () => { submissions++; view = "response"; },
      innerText: async () => selector === "#info_block" ? "欢迎回来 " + valueAt(headerText) : bodyText(),
      evaluateAll: async (fn, argument) => fn(selector === "a"
        ? ["/logout.php", "/usercp.php", "/userdetails.php?id=7"].map(path => ({ href: origin + path }))
        : [{ href: origin + "/userdetails.php?id=7", textContent: "本人" },
          { href: origin + "/attendance.php", textContent: valueAt(headerText) }], argument),
    };
    return locator;
  };
  const page = {
    url: () => url,
    title: async () => "Synthetic Nexus attendance",
    evaluate: async () => ({ bodyText: bodyText(), passwordInputs: false, challengeSelectors: false }),
    locator: locate,
    close: async () => {},
    goto: async destination => {
      navigations.push(destination);
      url = destination;
      view = destination.endsWith("/index.php") ? "header" : "form";
      if (view === "form") generation++;
      return view === "header" && nullHeaderResponse ? null
        : { status: () => view === "header" ? headerHttpStatus : 200 };
    },
  };
  return { page, navigations, submissions: () => submissions };
}

async function runCaptcha(t, fixture, maxAttempts = 2) {
  t.mock.method(globalThis, "setTimeout", callback => { queueMicrotask(callback); return 0; });
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: { get href() { return fixture.page.url(); } }, configurable: true });
  t.after(() => priorLocation ? Object.defineProperty(globalThis, "location", priorLocation) : delete globalThis.location);
  return tryNexusImageCaptcha(fixture.page, {}, {
    maxAttempts,
    recognize: async () => ({ code: "AB12CD", confidence: 95 }),
    secondOpinion: async (_image, recognition) => recognition,
  });
}

test("reviewed HTTP 200 daily header confirms a Nexus submission", async t => {
  const fixture = captchaPage();
  const result = await runCaptcha(t, fixture);
  assert.equal(result.status, "already_signed");
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.evidence.authoritative, true);
  assert.equal(result.evidence.businessDate, dayAt());
  assert.equal(result.evidence.statusSignal, "nexus_daily_header_signed");
  assert.equal(fixture.submissions(), 1);
});

test("a completed submission retains the action provenance even when its final read is passive", async t => {
  const fixture = captchaPage();
  const result = await runCaptcha(t, fixture);
  assert.equal(result.submissionAttempted, true);
  assert.notEqual(result.operationMode, "safe_history_page");
  assert.notEqual(result.readSafety, "reviewed_passive");
});

test("Nexus daily proof supplies a real account identity to the observation evidence contract", async t => {
  const fixture = captchaPage();
  const result = await runCaptcha(t, fixture);
  const evidence = normalizeEvidence({ ...result, origin: reviewedOrigin }, {
    businessDate: dayAt(), referenceAt: new Date().toISOString(),
  });
  assert.equal(evidence.verification, "verified");
  assert.equal(evidence.authoritative, true);
});

test("a stale signed legend cannot override an unsigned daily header", async t => {
  const fixture = captchaPage({ responseText: "状态说明：已签到", headerText: "签到" });
  const result = await runCaptcha(t, fixture);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.equal(result.retryable, false);
  assert.equal(fixture.submissions(), 1);
});

test("an actual OCR unknown stops later candidates and all configured target retries", async t => {
  const fixture = captchaPage({ responseText: "状态说明：已签到", headerText: "签到" });
  let calls = 0;
  const result = await processTarget({ newPage: async () => fixture.page }, {
    origin: reviewedOrigin,
    allowedOrigins: [reviewedOrigin],
    candidates: [reviewedOrigin + "/attendance.php", reviewedOrigin + "/next.php"],
  }, { retryCount: 3, retryDelayMs: 0, failureScreenshots: false }, {}, "unused", {
    runCandidate: async () => { calls++; return runCaptcha(t, fixture); },
  });
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.retryable, false);
  assert.equal(calls, 1);
  assert.equal(fixture.submissions(), 1);
});

test("captcha rejection survives a stale signed legend and permits the next fresh challenge", async t => {
  const fixture = captchaPage({
    responseText: submissions => submissions === 1
      ? "图片代码无效！不要返回，图片代码已被清除！ 状态说明：已签到"
      : "签到成功",
    headerText: submissions => submissions === 1 ? "签到" : "[已签到]",
  });
  const result = await runCaptcha(t, fixture);
  assert.equal(fixture.submissions(), 2, "The explicit rejection must be read before navigation erases it");
  assert.equal(result.status, "already_signed");
  assert.equal(result.evidence.authoritative, true);
});

test("HTTP 503 signed-looking headers cannot authoritatively confirm a submission", async t => {
  const fixture = captchaPage({ headerHttpStatus: 503 });
  const result = await runCaptcha(t, fixture);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.notEqual(result.evidence?.authoritative, true);
  assert.equal(fixture.submissions(), 1);
});

test("a null navigation response cannot authoritatively confirm a submission", async t => {
  const fixture = captchaPage({ nullHeaderResponse: true });
  const result = await runCaptcha(t, fixture);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.notEqual(result.evidence?.authoritative, true);
  assert.equal(fixture.submissions(), 1);
});

test("an exact same-day submission receipt remains usable for Nexus sites without a daily-header policy", async t => {
  const fixture = captchaPage({
    origin: "https://nexus-fixture.example.test",
    responseText: dayAt() + " 本次签到成功",
  });
  const result = await runCaptcha(t, fixture);
  assert.ok(["signed", "already_signed"].includes(result.status));
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.evidence.authoritative, true);
  assert.equal(result.evidence.businessDate, dayAt());
  assert.equal(fixture.submissions(), 1);
});

for (const foreignPart of ["action", "authentication", "both"]) {
  test("foreign-origin " + foreignPart + " links cannot supply account completion proof", async t => {
    const policy = ptReadPolicy(reviewedOrigin);
    const priorLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", { value: { href: policy.url }, configurable: true });
    t.after(() => priorLocation ? Object.defineProperty(globalThis, "location", priorLocation) : delete globalThis.location);
    const foreign = "https://foreign-fixture.example.test";
    const actionOrigin = foreignPart === "authentication" ? reviewedOrigin : foreign;
    const authOrigin = foreignPart === "action" ? reviewedOrigin : foreign;
    const links = ["/logout.php", "/usercp.php", "/userdetails.php?id=7"].map(path => ({ href: authOrigin + path }));
    const page = {
      url: () => policy.url,
      locator: selector => ({
        innerText: async () => "欢迎回来 已签到",
        evaluateAll: async (fn, argument) => fn(selector === "a" ? links
          : [{ href: actionOrigin + "/attendance.php", textContent: "[已签到]" }], argument),
      }),
    };
    const result = await readPtPassivePage(page, policy, { origin: reviewedOrigin, httpStatus: 200 });
    assert.notEqual(result.evidence?.authoritative, true);
  });
}
