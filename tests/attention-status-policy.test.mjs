import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { TERMINAL_STATUSES } from "../src/retry-policy.mjs";

const attentionSource = await fs.readFile(new URL("../src/attention-urls.mjs", import.meta.url), "utf8");
const manualSource = await fs.readFile(new URL("../src/manual-session.mjs", import.meta.url), "utf8");

test("关注链接与辅助会话只跳过权威终态", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["already_signed", "not_available", "signed"]);
  for (const source of [attentionSource, manualSource]) {
    assert.match(source, /import \{ TERMINAL_STATUSES \} from "\.\/retry-policy\.mjs"/);
    assert.match(source, /TERMINAL_STATUSES\.has\(result\.status\)/);
    assert.doesNotMatch(source, /\["signed", "already_signed", "visited", "clicked"\]/);
  }
});

test("访问或点击但未确认的结果仍进入关注范围", () => {
  for (const status of ["visited", "clicked", "no_action", "deferred", "interactive_challenge"]) {
    assert.equal(TERMINAL_STATUSES.has(status), false, status);
  }
});
