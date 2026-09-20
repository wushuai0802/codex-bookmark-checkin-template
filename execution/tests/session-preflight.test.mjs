import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionPreflightPlan, probeSessionPage } from "../src/session-preflight.mjs";

test("相同共享 OAuth Profile 只生成一次无副作用会话体检", () => {
  const profiles = new Map([["linuxdo-shared", "D:/fixture/data/sessions/linuxdo-shared"]]);
  const siteBindings = new Map([
    ["https://one.example", "linuxdo-shared"],
    ["https://two.example", "linuxdo-shared"],
  ]);
  const plan = buildSessionPreflightPlan({
    targets: [
      { origin: "https://one.example" },
      { origin: "https://two.example" },
    ],
    sessionProfiles: { profiles, siteBindings },
    config: {
      oauthSessionProbeRules: {
        "linuxdo-shared": {
          url: "https://linux.do/my/preferences/account",
          apiUrl: "https://linux.do/session/current.json",
          accountIdPaths: ["current_user.id"],
        },
      },
    },
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].key, "linuxdo-shared");
  assert.equal(plan[0].kind, "shared_oauth");
  assert.equal(plan[0].apiUrl, "https://linux.do/session/current.json");
  assert.deepEqual(plan[0].accountIdPaths, ["current_user.id"]);
});

test("共享 OAuth 会话优先使用会话范围的权威 JSON 回读", async () => {
  let closed = false;
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://linux.do/my/preferences/account",
    evaluate: async () => ({ status: 200, ok: true, body: { current_user: { id: 42, username: "redacted" } } }),
    close: async () => { closed = true; },
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "shared_oauth",
    key: "linuxdo-shared",
    probeUrl: "https://linux.do/my/preferences/account",
    apiUrl: "https://linux.do/session/current.json",
    accountIdPaths: ["current_user.id", "current_user.username"],
  });
  assert.deepEqual(result, {
    key: "linuxdo-shared",
    kind: "shared_oauth",
    status: "authenticated",
    checkedUrl: "https://linux.do/session/current.json",
  });
  assert.equal(closed, true);
});

test("共享 OAuth 会话权威接口无用户时明确返回登录失效", async () => {
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://linux.do/my/preferences/account",
    evaluate: async () => ({ status: 404, ok: false, body: null }),
    close: async () => {},
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "shared_oauth",
    key: "linuxdo-shared",
    probeUrl: "https://linux.do/my/preferences/account",
    apiUrl: "https://linux.do/session/current.json",
    accountIdPaths: ["current_user.id"],
  });
  assert.equal(result.status, "login_required");
});

test("共享 OAuth 权威接口限频不会误判为登录失效", async () => {
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://linux.do/my/preferences/account",
    evaluate: async () => ({ status: 429, ok: false, body: null }),
    close: async () => {},
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "shared_oauth",
    key: "linuxdo-shared",
    probeUrl: "https://linux.do/my/preferences/account",
    apiUrl: "https://linux.do/session/current.json",
    accountIdPaths: ["current_user.id"],
  });
  assert.equal(result.status, "rate_limited");
});

test("共享 OAuth 权威接口 5xx 明确归类为上游不可用", async () => {
  const page = {
    goto: async () => ({ status: () => 200 }),
    url: () => "https://linux.do/my/preferences/account",
    evaluate: async () => ({ status: 503, ok: false, body: null }),
    close: async () => {},
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "shared_oauth",
    key: "linuxdo-shared",
    probeUrl: "https://linux.do/my/preferences/account",
    apiUrl: "https://linux.do/session/current.json",
    accountIdPaths: ["current_user.id"],
  });
  assert.equal(result.status, "unavailable");
});

test("共享 OAuth 权威体检接口不得跨到其他 origin", () => {
  assert.throws(() => buildSessionPreflightPlan({
    targets: [{ origin: "https://one.example" }],
    sessionProfiles: {
      profiles: new Map([["shared", "D:/fixture/data/sessions/shared"]]),
      siteBindings: new Map([["https://one.example", "shared"]]),
    },
    config: {
      oauthSessionProbeRules: {
        shared: {
          url: "https://linux.do/my/preferences/account",
          apiUrl: "https://evil.example/session/current.json",
        },
      },
    },
  }), /必须属于 https:\/\/linux\.do/);
});

test("账号会话体检只采集权威账号 ID，不返回存储内容", async () => {
  let closed = false;
  const page = {
    goto: async () => ({ status: () => 200, json: async () => ({ data: { id: "200" } }) }),
    url: () => "https://agent.example/api/user/self",
    title: async () => "Console",
    evaluate: async (callback) => String(callback).includes("bodyText")
      ? { bodyText: "console", hasPassword: false }
      : "200",
    close: async () => { closed = true; },
  };
  const context = { newPage: async () => page };
  const result = await probeSessionPage(context, {
    kind: "oauth_account",
    key: "secondary",
    probeUrl: "https://agent.example/api/user/self",
    expectedAccountId: "200",
    accountIdPaths: ["data.id"],
  });
  assert.deepEqual(result, {
    key: "secondary",
    kind: "oauth_account",
    status: "authenticated",
    checkedUrl: "https://agent.example/api/user/self",
  });
  assert.equal(closed, true);
});

test("账号会话体检发现串号时返回确定性错误", async () => {
  const page = {
    goto: async () => ({ status: () => 200, json: async () => null }),
    url: () => "https://agent.example/api/user/self",
    title: async () => "Console",
    evaluate: async (callback) => String(callback).includes("bodyText")
      ? { bodyText: "console", hasPassword: false }
      : "999",
    close: async () => {},
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "oauth_account",
    key: "secondary",
    probeUrl: "https://agent.example/api/user/self",
    expectedAccountId: "200",
    accountIdPaths: ["data.id"],
  });
  assert.equal(result.status, "account_mismatch");
  assert.equal("observedAccountId" in result, false);
});

test("账号会话体检跨域跳转时按登录失效处理", async () => {
  const page = {
    goto: async () => ({ status: () => 200, json: async () => null }),
    url: () => "https://login.example/sign-in",
    title: async () => "Sign in",
    evaluate: async () => ({ bodyText: "Sign in", hasPassword: true }),
    close: async () => {},
  };
  const result = await probeSessionPage({ newPage: async () => page }, {
    kind: "oauth_account",
    key: "secondary",
    probeUrl: "https://agent.example/console",
    expectedAccountId: "200",
    accountIdPaths: ["data.id"],
  });
  assert.equal(result.status, "login_required");
});
