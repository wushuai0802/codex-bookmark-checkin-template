import test from "node:test";
import assert from "node:assert/strict";
import { connectOverCdpWithRetry } from "../src/native-cdp.mjs";

test("原生 Chrome 调试端口冷启动时会重试直到连接成功", async () => {
  let attempts = 0;
  const expected = { connected: true };
  const chromium = {
    connectOverCDP: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return expected;
    },
  };
  assert.equal(await connectOverCdpWithRetry(chromium, 12345, {
    timeoutMs: 1000, attemptTimeoutMs: 50, retryDelayMs: 1,
  }), expected);
  assert.equal(attempts, 3);
});

test("原生 Chrome 调试连接拒绝无效端口", async () => {
  await assert.rejects(() => connectOverCdpWithRetry({ connectOverCDP() {} }, 0), /参数无效/);
});
