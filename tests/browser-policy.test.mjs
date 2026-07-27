import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHALLENGE_SELECTOR,
  candidateHistoryEntry,
  configuredLoginCompletion,
  configuredTargetSkip,
  dismissBlockingModal,
  filterExpiredBootstrapLocalEntries,
  preferCandidateResult,
  shouldTryGenericNewApiCheckin,
  shouldPersistSiteStorage,
  tryBmapiCheckinStatus,
  writeSiteStorageSnapshot,
} from "../src/browser.mjs";

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

test("只有已确认签到结果允许保存站点会话", () => {
  assert.equal(shouldPersistSiteStorage({ status: "signed" }), true);
  assert.equal(shouldPersistSiteStorage({ status: "already_signed" }), true);
  for (const status of ["login_required", "error", "no_action", "unconfirmed", "not_available"]) {
    assert.equal(shouldPersistSiteStorage({ status }), false);
  }
});

test("配置取消的站点直接返回终止状态", () => {
  const result = configuredTargetSkip(
    { origin: "https://captcha.example" },
    { disabledCheckinOrigins: ["https://captcha.example"] },
  );
  assert.deepEqual(result, {
    status: "not_available",
    reason: "已按配置取消该站签到任务",
    url: "https://captcha.example",
    disabledByConfig: true,
  });
  assert.equal(configuredTargetSkip(
    { origin: "https://enabled.example" },
    { disabledCheckinOrigins: ["https://captcha.example"] },
  ), null);
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
  const tracker = { origin: "https://tracker.example", folderNames: ["签到"] };
  assert.equal(shouldTryGenericNewApiCheckin(bmapi), false);
  assert.equal(shouldTryGenericNewApiCheckin(bmapi, [bmapi.origin]), false);
  assert.equal(shouldTryGenericNewApiCheckin(publicSite), true);
  assert.equal(shouldTryGenericNewApiCheckin(publicSite, [publicSite.origin]), true);
  assert.equal(shouldTryGenericNewApiCheckin(tracker), false);
});

test("过期的站点快照不会反复注入认证令牌", () => {
  const expired = [
    ["auth_token", "old-access"],
    ["refresh_token", "old-refresh"],
    ["auth_user", "old-user"],
    ["token_expires_at", "1785066910718"],
    ["ann_dismiss_today_23", "2026-07-27"],
  ];
  assert.deepEqual(filterExpiredBootstrapLocalEntries(expired, 1785114265000), [
    ["ann_dismiss_today_23", "2026-07-27"],
  ]);
  assert.deepEqual(filterExpiredBootstrapLocalEntries(expired, 1785000000000), expired);
});

test("站点会话更新前会把旧内容保留为 bak", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "checkin-storage-"));
  const storagePath = path.join(directory, "session.json");
  try {
    const previous = { version: 1, origin: "https://example.test", local: [["auth", "old"]], session: [] };
    const current = { version: 1, origin: "https://example.test", local: [["auth", "new"]], session: [] };
    await fs.writeFile(storagePath, `${JSON.stringify(previous)}\n`, "utf8");

    await writeSiteStorageSnapshot(storagePath, current);

    assert.deepEqual(JSON.parse(await fs.readFile(storagePath, "utf8")), current);
    assert.deepEqual(JSON.parse(await fs.readFile(`${storagePath}.bak`, "utf8")), previous);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
