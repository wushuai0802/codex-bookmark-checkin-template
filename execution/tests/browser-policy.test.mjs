import test from "node:test";
import assert from "node:assert/strict";
import {
  CHALLENGE_SELECTOR,
  candidateHistoryEntry,
  classifyVibeClaimResponse,
  configuredLoginCompletion,
  configuredTargetSkip,
  dismissBlockingModal,
  isNexusCaptchaRejectedText,
  isOpenCdCaptchaRejectedText,
  preferCandidateResult,
  resultFromPageFailure,
  shouldTryGenericNewApiCheckin,
  shouldRefreshAutomationContext,
  turnstileWaitMs,
  tryBmapiCheckinStatus,
  tryNexusImageCaptcha,
  tryOpenCdCaptcha,
  tryQuotaRequestFlow,
  waitForActiveQuotaBenefit,
  waitForQuotaRequestField,
} from "../src/browser.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("NexusPHP 图片验证码拒绝提示会触发同轮换图重试", () => {
  assert.equal(isNexusCaptchaRejectedText("图片代码无效！不要返回，图片代码已被清除！"), true);
  assert.equal(isNexusCaptchaRejectedText("Captcha invalid, please retry"), true);
  assert.equal(isNexusCaptchaRejectedText("签到成功"), false);
});

test("NexusPHP 验证码按真实表单字段处理且先于通用签到按钮", async () => {
  const source = await fs.readFile(path.join(root, "src", "browser.mjs"), "utf8");
  assert.match(source, /input\[name=["']imagestring["']\]/);
  assert.match(source, /input\[type=["']hidden["']\]\[name=["']imagehash["']\]/);
  assert.match(source, /img\[alt=["']CAPTCHA["'] i\]\[src\*=["']image\.php["']\]/);
  assert.match(source, /submittedChallenges\.has\(challengeKey\)/);
  assert.ok(source.indexOf("const initialNexusCaptchaResult = await tryNexusImageCaptcha(page, config)")
    < source.indexOf("let action = await findCheckinAction(page, allowedOrigins)"));
});

test("Nexus captcha passes runtime config to optional OCR before any submission", async () => {
  const config = { baiduOcr: { enabled: false } };
  let secondOpinionCalled = false;
  const locator = {
    count: async () => 1,
    locator() { return this; },
    screenshot: async () => Buffer.from("synthetic-image"),
    inputValue: async () => "synthetic-hash",
    fill: async () => { throw new Error("must not submit an invalid OCR result"); },
    click: async () => { throw new Error("must not click an invalid OCR result"); },
  };
  const page = { url: () => "https://nexus.example.test/attendance.php", locator: () => locator };
  const result = await tryNexusImageCaptcha(page, config, {
    maxAttempts: 1,
    recognize: async () => ({ code: "", confidence: 0 }),
    secondOpinion: async (image, local, options) => {
      secondOpinionCalled = true;
      assert.equal(options.config, config);
      assert.equal(options.origin, "https://nexus.example.test");
      assert.equal(options.length, 6);
      return local;
    },
  });
  assert.equal(secondOpinionCalled, true);
  assert.equal(result.failureCode, "captcha_ocr_exhausted");
});

test("瞬时上游失败请求重建共享浏览器上下文", () => {
  assert.equal(shouldRefreshAutomationContext({
    status: "deferred",
    retryCause: "upstream_unavailable",
  }), true);
  assert.equal(shouldRefreshAutomationContext({
    status: "deferred",
    retryCause: "login_required",
  }), false);
  assert.equal(shouldRefreshAutomationContext({ status: "already_signed" }), false);
});

test("delayed claim dialog retries only opening, never blind submission", async () => {
  let opened = 0;
  let waits = 0;
  const page = { getByRole: (role, options) => {
    assert.equal(role, "button");
    assert.equal(options.name, "领取 Codex 权益");
    return { count: async () => 1, isVisible: async () => true, click: async () => { opened++; } };
  } };
  const result = await tryQuotaRequestFlow(page, "https://quota.example.test", {
    quotaRequestRules: { "https://quota.example.test": { reason: "申请用于学习编程与个人项目开发测试" } },
  }, { waitForField: async () => { waits++; return null; } });
  assert.equal(opened, 1);
  assert.equal(waits, 2);
  assert.equal(result, null);
});

test("Vibe claim requires the exact claimed receipt", () => {
  const now = new Date("2026-09-28T00:42:00Z");
  const claimed = classifyVibeClaimResponse({ code: 1, data: { claimed: true } }, 200, now);
  assert.equal(claimed.status, "signed");
  assert.equal(claimed.evidence.source, "vibe_claim_response");
  assert.equal(claimed.evidence.endpoint, "/frontend-api/vibe-code/codex/claim");
  assert.equal(claimed.evidence.businessDate, "2026-09-28");
  assert.equal(claimed.evidence.authoritative,false);
  const bound={code:1,data:{claimed:true,accountId:'7'}};
  assert.equal(classifyVibeClaimResponse(bound,200,now,{expectedAccountId:'7'}).evidence.authoritative,true);
  assert.equal(classifyVibeClaimResponse(bound,200,now,{expectedAccountId:'8'}).failureCode,'account_mismatch');
  assert.equal(classifyVibeClaimResponse({ code: 1, data: { claimed: false } }, 200, now).retryable, false);
  assert.equal(classifyVibeClaimResponse({ code: 1, data: { claimed: true } }, 502, now), null);
  assert.equal(classifyVibeClaimResponse({ code: "1", data: { claimed: true } }, 200, now), null);
});

test("Vibe claim observes the matching POST response before the page toast", async () => {
  const origin = "https://new.sharedchat.cc";
  const receipt = {
    url: () => `${origin}/frontend-api/vibe-code/codex/claim`,
    request: () => ({ method: () => "POST" }),
    status: () => 200,
    json: async () => ({ code: 1, data: { claimed: true } }),
  };
  const page = {
    getByRole: (_role, { name }) => ({
      count: async () => name === "领取" ? 1 : 0,
      isVisible: async () => name === "领取",
      click: async () => {},
    }),
    waitForResponse: async predicate => {
      assert.equal(predicate(receipt), true);
      assert.equal(predicate({ ...receipt, url: () => "https://other.example/frontend-api/vibe-code/codex/claim" }), false);
      return receipt;
    },
  };
  const result = await tryQuotaRequestFlow(page, origin, {
    quotaRequestRules: { [origin]: { reason: "用于个人编程学习和项目开发测试" } },
  }, { waitForField: async () => ({ fill: async () => {} }) });
  assert.equal(result.status, "signed");
  assert.equal(result.evidence.source, "vibe_claim_response");
});

test("a submission with unknown outcome cannot reach another candidate", async () => {
  const visited = [];
  const context = { newPage: async () => ({ close: async () => {} }) };
  const target = { origin: "https://example.test", candidates: ["https://example.test/first", "https://example.test/second"] };
  const result = await (await import("../src/browser.mjs")).processTarget(context, target,
    { retryCount: 2, failureScreenshots: false }, [], "", {
      runCandidate: async (_page, _target, url) => {
        visited.push(url);
        return { status: "needs_attention", reason: "提交结果未知", failureCode: "submission_outcome_unknown",
          submissionAttempted: true, retryable: false };
      },
    });
  assert.deepEqual(visited, ["https://example.test/first"]);
  assert.equal(result.failureCode, "submission_outcome_unknown");
});

test('Depth Studio checks its daily header before visiting the formal attendance endpoint',async()=>{
  const visited=[];
  const context={newPage:async()=>({close:async()=>{}})};
  const result=await (await import('../src/browser.mjs')).processTarget(context,
    {origin:'https://dstudio.me',candidates:['https://dstudio.me/attendance.php']},
    {retryCount:0,failureScreenshots:false},[],'',{runCandidate:async(_page,_target,url)=>{
      visited.push(url);
      if(url.endsWith('/attendance.php'))throw Error('Already complete must not revisit attendance');
      return {status:'already_signed',reason:'Current daily header',submissionAttempted:false,evidence:{authoritative:true}};
    }});
  assert.deepEqual(visited,['https://dstudio.me/index.php']);
  assert.equal(result.status,'already_signed');assert.equal(result.submissionAttempted,false);
});

test("a pre-submit login failure can be retried after login, while mixed candidates stay uncertain", async () => {
  const context = { newPage: async () => ({ close: async () => {} }) };
  const start = { status: "login_required", reason: "session expired", submissionAttempted: false };
  const single = await (await import("../src/browser.mjs")).processTarget(context,
    { origin: "https://login.example", candidates: ["https://login.example/status"] },
    { retryCount: 0, failureScreenshots: false }, [], "", { runCandidate: async () => start });
  assert.equal(single.submissionAttempted, false);
  const mixed = await (await import("../src/browser.mjs")).processTarget(context,
    { origin: "https://login.example", candidates: ["https://login.example/status", "https://login.example/action"] },
    { retryCount: 0, failureScreenshots: false }, [], "", {
      runCandidate: async (_page, _target, url) => url.endsWith("/status") ? start
        : { status: "needs_attention", reason: "action uncertain", submissionAttempted: true },
    });
  assert.notEqual(mixed.submissionAttempted, false);
});

test("TLS handshake failure cannot be reclassified using a stale login page", async () => {
  const result = await resultFromPageFailure({ url: () => "https://tls.example.test/login" }, new Error("page.goto: net::ERR_SSL_VERSION_OR_CIPHER_MISMATCH"), {});
  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "upstream_unavailable");
  assert.equal(result.failureCode, "tls_handshake_failed");
});

test("invalid site certificates are deferred without bypassing TLS or retrying login", async () => {
  const result = await resultFromPageFailure({ url: () => "https://expired.example.test/console" }, new Error("page.goto: net::ERR_CERT_DATE_INVALID"), {});
  assert.equal(result.status, "deferred");
  assert.equal(result.retryCause, "upstream_unavailable");
  assert.equal(result.failureCode, "tls_certificate_invalid");
  assert.match(result.reason, /TLS 证书/);
  assert.ok(result.nextEligibleAt);
  assert.equal(result.retryableLoginRecovery, false);
  assert.equal(shouldRefreshAutomationContext(result), false);
});

test("AnyRouter 使用动态地址与 ESA 校验专用 API 通道，不能回退为普通页面点击", async () => {
  const browser = await fs.readFile(path.join(root, "src", "browser.mjs"), "utf8");
  const api = await fs.readFile(path.join(root, "src", "anyrouter-api-checkin.mjs"), "utf8");
  assert.match(browser, /target\.origin === "https:\/\/anyrouter\.top"/);
  assert.match(browser, /tryAnyRouterApiCheckin\(page, config, target\.origin\)/);
  assert.match(api, /resolveDynamicOriginRoutes/);
  assert.match(api, /rejectUnauthorized:\s*true/);
  assert.match(api, /solveEsaChallenge/);
  assert.match(api, /signInUrl|sign_in/);
  assert.match(api, /logUrl|log\/self/);
  assert.match(api, /sign_in_already_claimed_contract/);
  assert.doesNotMatch(api, /ignoreHTTPSErrors/);
});

test("候选弱结果不会覆盖登录、挑战或延迟状态", () => {
  for (const status of ["login_required", "interactive_challenge", "managed_challenge_timeout", "deferred"]) {
    const valuable = { status, reason: "actionable" };
    assert.equal(preferCandidateResult(valuable, { status: "no_action" }), valuable);
    assert.equal(preferCandidateResult(valuable, { status: "error" }), valuable);
  }
});

test("候选完成状态会覆盖此前异常状态", () => {
  const completed = { status: "signed", reason: "done" };
  assert.equal(preferCandidateResult({ status: "login_required" }, completed), completed);
});

test("打开即签到地址也必须取得权威回读", async () => {
  const source = await fs.readFile(path.join(root, "src", "browser.mjs"), "utf8");
  assert.match(source, /Visiting an attendance URL is an action attempt/i);
  assert.match(source, /const confirmed = await waitForAuthoritativeCheckin\(page, activeOrigin, config\)/);
  assert.doesNotMatch(source, /return \{ status: "visited", reason: "已访问打开即签到的网址"/);
});

test('daily page success attempts same-day evidence capture without PT-only mode',async()=>{
  const source=await fs.readFile(path.join(root,'src','browser.mjs'),'utf8');
  assert.match(source,/capturePtEvidence===true\|\|\['页面显示签到成功','今天已经签到'\]/);
  assert.match(source,/ptPageEvidence\(\{origin:target\.origin,url:page\.url\(\),bodyText,status:completed\.status\}\)/);
});

test('native status and post-submit captcha evidence require current-day signals',async()=>{
  const native=await fs.readFile(path.join(root,'src','native-browser-inspect.mjs'),'utf8');
  const browser=await fs.readFile(path.join(root,'src','browser.mjs'),'utf8');
  assert.match(native,/ptPageEvidence\(\{origin:expectedOrigin,url:page\.url\(\),bodyText:snapshot\.bodyText/);
  assert.match(native,/allowUndatedActionText:false/);
  assert.match(browser,/statusSignal:'submitted_success_response'/);
});

test("跳转登录页时执行上下文销毁会恢复为登录失效", async () => {
  let snapshots = 0;
  let structureReads = 0;
  const page = {
    evaluate: async (_function, argument) => {
      if(typeof argument!=='string'){
        structureReads++;
        return {hasOtpInput:false,hasOtpForm:false,hasRequiredOtpInput:false};
      }
      snapshots += 1;
      if (snapshots === 1) throw new Error("Execution context was destroyed, most likely because of a navigation");
      return {
        bodyText: "登录 使用 LinuxDO 继续",
        passwordInputs: false,
        challengeSelectors: false,
      };
    },
    title: async () => "登录",
    url: () => "https://example.test/login?expired=1",
    waitForLoadState: async () => {},
  };
  const result = await resultFromPageFailure(page, new Error("Execution context was destroyed"), {});
  assert.equal(result.status, "login_required");
  assert.equal(result.url, "https://example.test/login?expired=%5BVALUE%5D");
  assert.equal(snapshots, 2);
  assert.equal(structureReads,1);
});

test("候选历史会脱敏网址和错误原因", () => {
  const entry = candidateHistoryEntry(
    "https://example.test/checkin?token=secret-value&day=2026-07-23",
    {
      status: "error",
      reason: "authorization=private-value https://example.test/error?code=secret-code",
    },
    2,
  );
  const serialized = JSON.stringify(entry);
  assert.equal(entry.attempt, 2);
  assert.equal(entry.status, "error");
  assert.doesNotMatch(serialized, /secret-value|private-value|secret-code|2026-07-23/);
  assert.match(decodeURIComponent(entry.candidateUrl), /token=\[REDACTED\]/);
  assert.match(decodeURIComponent(entry.candidateUrl), /day=\[VALUE\]/);
});

test("通用安全验证选择器覆盖 Cap.js", () => {
  assert.match(CHALLENGE_SELECTOR, /cap-widget/);
  assert.match(CHALLENGE_SELECTOR, /data-cap-api-endpoint/);
});

test("配置取消的站点直接返回终止状态", () => {
  const result = configuredTargetSkip(
    { origin: "https://captcha.example" },
    { disabledCheckinOrigins: ["https://captcha.example"] },
  );
  assert.equal(result.status, "not_available");
  assert.equal(result.reason, "已按配置取消该站签到任务");
  assert.equal(result.url, "https://captcha.example");
  assert.equal(result.disabledByConfig, true);
  assert.equal(result.availabilityKind, "task_disabled");
  assert.equal(result.evidence.source, "configuration");
  assert.equal(result.evidence.authoritative, true);
  assert.ok(Number.isFinite(Date.parse(result.evidence.confirmedAt)));
  assert.equal(configuredTargetSkip(
    { origin: "https://enabled.example" },
    { disabledCheckinOrigins: ["https://captcha.example"] },
  ), null);
});

test("显式停用账号只影响绑定账号，旧交接标记不再改变执行计划", () => {
  const origin = "https://pt.example";
  const disabled = configuredTargetSkip({origin,accountKey:"account-a"},
    {disabledAccountKeys:["account-a"]});
  assert.equal(disabled.status,"not_available");
  assert.equal(disabled.disabledByAccountConfig,true);
  assert.equal(disabled.evidence.authoritative,true);
  assert.equal(configuredTargetSkip({origin,accountKey:"account-b"},
    {disabledAccountKeys:["account-a"]}),null);
  assert.equal(configuredTargetSkip({origin,accountKey:"account-a"},
    {executionEngine:"v1",disabledAccountBindings:[{origin,accountKey:"account-a"}]}),null);
});

test("配置为登录即完成的站点返回签到成功", () => {
  assert.deepEqual(
    configuredLoginCompletion("https://login-only.example", {
      loginAsCheckinOrigins: ["https://login-only.example"],
    }),
    { status: "signed", reason: "站点登录成功，按配置视为签到完成" },
  );
  assert.equal(configuredLoginCompletion("https://other.example", {
    loginAsCheckinOrigins: ["https://login-only.example"],
  }), null);
});

test("连续关闭标记已读和今日关闭弹窗", async () => {
  const visibleLabels = ["标记已读", "今日关闭"];
  const clicked = [];
  const page = {
    getByRole(_role, options) {
      const matches = () => visibleLabels[0] === options.name;
      const locator = {
        count: async () => matches() ? 1 : 0,
        first: () => locator,
        isVisible: async () => matches(),
        click: async () => {
          assert.equal(matches(), true);
          clicked.push(options.name);
          visibleLabels.shift();
        },
      };
      return locator;
    },
  };

  const dismissed = await dismissBlockingModal(page, { actionWaitMs: 0 });
  assert.deepEqual(dismissed, ["标记已读", "今日关闭"]);
  assert.deepEqual(clicked, dismissed);
});

test("斑马签到使用接口确认最终状态", async () => {
  const page = {
    evaluate: async () => ({
      ok: true,
      status: 200,
      body: { code: 0, data: { enabled: true, checked_in: true } },
    }),
  };
  assert.deepEqual(
    await tryBmapiCheckinStatus(page, "https://bmapi.020212.xyz", "signed"),
    { status: "signed", reason: "斑马 API 接口确认签到成功" },
  );
  assert.equal(await tryBmapiCheckinStatus(page, "https://other.example"), null);
});

test("Turnstile 使用完整配置等待时间并设置安全上下限", () => {
  assert.equal(turnstileWaitMs({ cloudflareWaitMs: 90000 }), 90000);
  assert.equal(turnstileWaitMs({ cloudflareWaitMs: 1000 }), 5000);
  assert.equal(turnstileWaitMs({ cloudflareWaitMs: 300000 }), 120000);
  assert.equal(turnstileWaitMs({ cloudflareWaitMs: "invalid" }), 30000);
});

test("斑马状态查询优先使用不受页面导航影响的请求通道", async () => {
  let evaluated = false;
  const page = {
    context: () => ({
      storageState: async () => ({
        origins: [{
          origin: "https://bmapi.020212.xyz",
          localStorage: [{ name: "auth_token", value: "test-token" }],
        }],
      }),
      request: {
        get: async (url, options) => {
          assert.equal(url, "https://bmapi.020212.xyz/api/v1/checkin/status?timezone=Asia%2FShanghai");
          assert.equal(options.headers.authorization, "Bearer test-token");
          return {
            ok: () => true,
            status: () => 200,
            json: async () => ({ code: 0, data: { enabled: true, checked_in: true } }),
          };
        },
      },
    }),
    evaluate: async () => {
      evaluated = true;
      throw new Error("Execution context was destroyed");
    },
  };

  assert.equal((await tryBmapiCheckinStatus(page, "https://bmapi.020212.xyz")).status, "already_signed");
  assert.equal(evaluated, false);
});

test("斑马跳过包含提交动作的通用 New API 探测", () => {
  const bmapi = { origin: "https://bmapi.020212.xyz", folderNames: ["公益站"] };
  const publicSite = { origin: "https://public.example", folderNames: ["公益站"] };
  const explicitlyConfigured = { origin: "https://configured.example", folderNames: ["签到"] };
  const tracker = { origin: "https://tracker.example", folderNames: ["签到"] };
  assert.equal(shouldTryGenericNewApiCheckin(bmapi), false);
  assert.equal(shouldTryGenericNewApiCheckin(bmapi, [bmapi.origin]), false);
  for (const origin of ["https://open.cd", "https://ptsbao.club"]) {
    const historicallyLabelledPt = {origin,folderNames:["公益站"]};
    assert.equal(shouldTryGenericNewApiCheckin(historicallyLabelledPt), false);
    assert.equal(shouldTryGenericNewApiCheckin(historicallyLabelledPt,[origin]), false);
  }
  assert.equal(shouldTryGenericNewApiCheckin(publicSite), true);
  assert.equal(shouldTryGenericNewApiCheckin(publicSite, [publicSite.origin]), true);
  assert.equal(shouldTryGenericNewApiCheckin(publicSite, [explicitlyConfigured.origin]), true);
  assert.equal(shouldTryGenericNewApiCheckin(explicitlyConfigured, [explicitlyConfigured.origin]), true);
  assert.equal(shouldTryGenericNewApiCheckin(tracker), false);
});

test("领取权益后等待页面出现有效套餐再确认成功", async () => {
  let checks = 0;
  const page = {
    locator: () => ({
      innerText: async () => {
        checks += 1;
        return checks < 2 ? "正在更新套餐" : "当前套餐 - Codex 剩余额度 100 下次重置 明天";
      },
    }),
    getByRole: () => ({
      count: async () => 0,
      isVisible: async () => false,
    }),
  };
  const result = await waitForActiveQuotaBenefit(page, "https://benefit.example", {
    quotaRequestRules: { "https://benefit.example": {} },
  }, "signed", 1000);
  assert.deepEqual(result, { status: "signed", reason: "Codex 权益已领取，页面显示有效套餐" });
  assert.equal(checks, 2);
});

test("额度申请弹窗延迟渲染时等待唯一理由输入框", async () => {
  let checks = 0;
  const field = {
    count: async () => {
      checks += 1;
      return checks < 2 ? 0 : 1;
    },
  };
  const page = { locator: () => field };
  assert.equal(await waitForQuotaRequestField(page, 1000), field);
  assert.equal(checks, 2);
});

test("OpenCD 验证码拒绝文本匹配只放行明确拒绝提示", () => {
  assert.equal(isOpenCdCaptchaRejectedText('{"state":"false","msg":"验证码错误"}'), true);
  assert.equal(isOpenCdCaptchaRejectedText("图片代码无效，请重试"), true);
  assert.equal(isOpenCdCaptchaRejectedText("Captcha invalid"), true);
  assert.equal(isOpenCdCaptchaRejectedText('{"state":"success","msg":"签到成功"}'), false);
  assert.equal(isOpenCdCaptchaRejectedText(""), false);
  assert.equal(isOpenCdCaptchaRejectedText("502 Bad Gateway"), false);
});

function createOpenCdCaptchaFixture({ images, responses, reloadBody = "今日未签到", initialBody = "", throwOnSubmit = false }) {
  let imageIndex = 0;
  let submitIndex = 0;
  let refreshed = 0;
  let reloaded = 0;
  let beforeSubmitCalls = 0;
  let frameBodyText = initialBody;
  const filledCodes = [];
  const frame = {
    locator(selector) {
      if (selector === 'input[name="imagestring"]') {
        return {
          count: async () => 1,
          fill: async (value) => { filledCodes.push(value); },
        };
      }
      if (selector === "button#ok") {
        return {
          count: async () => 1,
          click: async () => {
            submitIndex += 1;
            if (throwOnSubmit) throw new Error("frame detached after click");
            frameBodyText = responses[Math.min(submitIndex - 1, responses.length - 1)] ?? "";
          },
        };
      }
      if (selector === "img") {
        return {
          count: async () => 1,
          first() { return this; },
          screenshot: async () => Buffer.from(images[Math.min(imageIndex, images.length - 1)]),
        };
      }
      if (selector === "body") {
        return {
          innerText: async () => frameBodyText,
        };
      }
      return { count: async () => 0 };
    },
  };
  const page = {
    url: () => "https://open.cd/index.php",
    title: async () => "OpenCD",
    frameLocator: () => frame,
    reload: async () => { reloaded += 1; },
    evaluate: async () => ({ bodyText: reloadBody, passwordInputs: false, challengeSelectors: false }),
    locator: () => ({ innerText: async () => reloadBody }),
  };
  return {
    page,
    config: { beforePtSubmit: () => { beforeSubmitCalls += 1; } },
    refreshCaptcha: async () => { refreshed += 1; imageIndex += 1; frameBodyText = ""; },
    stats: () => ({ submitIndex, refreshed, reloaded, beforeSubmitCalls, filledCodes }),
  };
}

test("OpenCD 提交前低置信度识别先换图再提交，不提交可疑答案", async () => {
  const fixture = createOpenCdCaptchaFixture({
    images: ["img-blurry", "img-clear"],
    responses: ['{"state":"success","msg":"签到成功"}'],
  });
  const ocrResults = [
    { code: "", rawCode: "AB", confidence: 20 },
    { code: "AB12CD", rawCode: "AB12CD", confidence: 88 },
  ];
  let idx = 0;
  const result = await tryOpenCdCaptcha(fixture.page, "https://open.cd", fixture.config, {
    recognize: async () => ocrResults[idx++],
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: fixture.refreshCaptcha,
  });
  assert.equal(result.status, "signed");
  assert.deepEqual(fixture.stats().filledCodes, ["AB12CD"]);
  assert.equal(fixture.stats().beforeSubmitCalls, 1);
  assert.equal(fixture.stats().refreshed, 1);
});

test("OpenCD 明确验证码拒绝时换图重试一次并确认成功", async () => {
  const fixture = createOpenCdCaptchaFixture({
    images: ["img-1", "img-2"],
    responses: ['{"state":"false","msg":"验证码错误"}', '{"state":"success","msg":"签到成功"}'],
  });
  const codes = ["WRONG1", "RIGHT2"];
  let idx = 0;
  const result = await tryOpenCdCaptcha(fixture.page, "https://open.cd", fixture.config, {
    recognize: async () => ({ code: codes[idx++], confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: fixture.refreshCaptcha,
  });
  assert.equal(result.status, "signed");
  assert.deepEqual(fixture.stats().filledCodes, ["WRONG1", "RIGHT2"]);
  assert.equal(fixture.stats().submitIndex, 2);
  assert.equal(fixture.stats().reloaded, 0);
});

test("OpenCD 连续明确拒绝达到提交上限时停止且不误标为结果不明", async () => {
  const fixture = createOpenCdCaptchaFixture({
    images: ["img-1", "img-2", "img-3"],
    responses: ['{"state":"false","msg":"验证码错误"}', '{"state":"false","msg":"验证码错误"}'],
  });
  const result = await tryOpenCdCaptcha(fixture.page, "https://open.cd", fixture.config, {
    recognize: async () => ({ code: "ABC123", confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: fixture.refreshCaptcha,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "captcha_ocr_exhausted");
  assert.equal(result.captchaRejected, true);
  assert.equal(fixture.stats().submitIndex, 2);
});

test("OpenCD 提交后响应模糊时禁止重试并严格 fail-closed", async () => {
  const fixture = createOpenCdCaptchaFixture({
    images: ["img-1", "img-2"],
    responses: [""],
    reloadBody: "OpenCD 首页",
  });
  const result = await tryOpenCdCaptcha(fixture.page, "https://open.cd", fixture.config, {
    recognize: async () => ({ code: "ABC123", confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: fixture.refreshCaptcha,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.equal(result.submissionAttempted, true);
  assert.equal(result.retryable, false);
  assert.equal(fixture.stats().submitIndex, 1);
  assert.equal(fixture.stats().refreshed, 0);
  assert.equal(fixture.stats().reloaded, 1);
});

test("OpenCD 验证码刷新后返回同一图片时阻止重复提交", async () => {
  const fixture = createOpenCdCaptchaFixture({
    images: ["same-img", "same-img", "same-img"],
    responses: ['{"state":"false","msg":"验证码错误"}'],
  });
  const result = await tryOpenCdCaptcha(fixture.page, "https://open.cd", fixture.config, {
    recognize: async () => ({ code: "ABC123", confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: fixture.refreshCaptcha,
  });
  assert.equal(result.status, "needs_attention");
  assert.equal(result.failureCode, "captcha_not_refreshed");
  assert.equal(fixture.stats().submitIndex, 1);
});

test("OpenCD 提交点击异常或陈旧拒绝文本均严格 fail-closed 不重试", async () => {
  const crashFixture = createOpenCdCaptchaFixture({
    images: ["img-1", "img-2"],
    responses: [""],
    throwOnSubmit: true,
  });
  const crashResult = await tryOpenCdCaptcha(crashFixture.page, "https://open.cd", crashFixture.config, {
    recognize: async () => ({ code: "ABC123", confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: crashFixture.refreshCaptcha,
  });
  assert.equal(crashResult.status, "needs_attention");
  assert.equal(crashResult.failureCode, "submission_outcome_unknown");
  assert.equal(crashResult.submissionAttempted, true);
  assert.equal(crashFixture.stats().submitIndex, 1);

  const staleFixture = createOpenCdCaptchaFixture({
    images: ["img-1", "img-2"],
    initialBody: "验证码错误",
    responses: ["验证码错误"],
    reloadBody: "OpenCD 首页",
  });
  const staleResult = await tryOpenCdCaptcha(staleFixture.page, "https://open.cd", staleFixture.config, {
    recognize: async () => ({ code: "ABC123", confidence: 90 }),
    secondOpinion: async (_img, local) => local,
    sleepFn: async () => {},
    refreshCaptcha: staleFixture.refreshCaptcha,
  });
  assert.equal(staleResult.status, "needs_attention");
  assert.equal(staleResult.failureCode, "submission_outcome_unknown");
  assert.equal(staleFixture.stats().submitIndex, 1);
  assert.equal(staleFixture.stats().refreshed, 0);
});
