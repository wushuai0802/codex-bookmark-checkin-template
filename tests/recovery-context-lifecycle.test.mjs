import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeSharedContexts } from "../src/shared-context-lifecycle.mjs";

test("登录恢复前释放任务持有的全部共享浏览器配置", async () => {
  const closed = [];
  const first = { close: async () => closed.push("first") };
  const second = { close: async () => closed.push("second") };
  const shared = new Map([["profile-a", first], ["profile-b", second], ["alias", first]]);
  const active = new Set([first, second]);
  assert.equal(await closeSharedContexts(shared, active), 2);
  assert.equal(shared.size, 0);
  assert.equal(active.size, 0);
  assert.deepEqual(closed.sort(), ["first", "second"]);
});

test("主流程在启动外部登录助手前释放共享 context", async () => {
  const source = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  const closeCall = source.indexOf("await closeSharedContexts(sharedContexts, activeContexts)");
  const helperLoop = source.indexOf("for (const method of methods)", closeCall);
  assert.notEqual(closeCall, -1);
  assert.ok(helperLoop > closeCall);
});
