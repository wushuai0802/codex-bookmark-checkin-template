import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { acceptConfiguredLoginTerms, waitForLoginSubmitEnabled } from "../src/protected-login-flow.mjs";

test("受保护登录先接受显式配置的新条款", async () => {
  let clicked = false;
  const button = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { clicked = true; },
  };
  const page = {
    getByRole: (_role, options) => {
      assert.deepEqual(options, { name: "同意并继续", exact: true });
      return button;
    },
    waitForTimeout: async () => {},
  };
  assert.equal(await acceptConfiguredLoginTerms(page, "https://protected.example", {
    autoAcceptUpdatedTermsOrigins: ["https://protected.example"],
    actionWaitMs: 0,
  }), true);
  assert.equal(clicked, true);
});

test("受保护登录等待 Cap 完成并启用提交按钮", async () => {
  let enabled = false;
  let clicked = false;
  const submit = { isEnabled: async () => enabled };
  const capButton = {
    count: async () => 1,
    isVisible: async () => true,
    click: async () => { clicked = true; enabled = true; },
  };
  const page = {
    getByRole: () => capButton,
    locator: () => ({ count: async () => 0 }),
    frameLocator: () => ({ locator: () => ({ count: async () => 0 }) }),
    waitForTimeout: async () => {},
  };
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", {
    autoClickTurnstileOrigins: ["https://protected.example"],
    cloudflareWaitMs: 10000,
  }), true);
  assert.equal(clicked, true);
});

test("未授权自动验证的登录页不会点击挑战控件", async () => {
  let inspected = false;
  const page = { getByRole: () => { inspected = true; throw new Error("unexpected"); } };
  const submit = { isEnabled: async () => false };
  assert.equal(await waitForLoginSubmitEnabled(page, submit, "https://protected.example", {}), false);
  assert.equal(inspected, false);
});

test("受保护凭据和原生保存密码恢复都先处理条款与挑战", async () => {
  for (const file of ["credential-login.mjs", "native-login.mjs"]) {
    const source = await fs.readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    const acceptCall = source.indexOf("await acceptConfiguredLoginTerms(page");
    const passwordLookup = source.indexOf("const password = page.locator");
    const challengeCall = source.indexOf("await waitForLoginSubmitEnabled(page");
    const submitClick = source.indexOf("await submit.click");
    assert.ok(acceptCall >= 0 && acceptCall < passwordLookup, `${file} 应先处理条款`);
    assert.ok(challengeCall >= 0 && challengeCall < submitClick, `${file} 应先完成挑战再提交`);
  }
});
