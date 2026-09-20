import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import { TERMINAL_STATUSES } from "../src/retry-policy.mjs";
import { isTerminalResult } from "../src/result-contract.mjs";

const attentionSource = await fs.readFile(new URL("../src/attention-urls.mjs", import.meta.url), "utf8");
const manualSource = await fs.readFile(new URL("../src/manual-session.mjs", import.meta.url), "utf8");

test("关注链接与辅助会话只跳过权威终态", () => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["already_signed", "signed"]);
  assert.equal(isTerminalResult({ status: "not_available" }), false);
  assert.equal(isTerminalResult({
    status: "not_available",
    availabilityKind: "feature_disabled",
    evidence: {
      source: "new_api_checkin_status",
      outcome: "message_not_enabled",
      authoritative: true,
      confirmedAt: "2026-09-03T00:00:00Z",
    },
  }), true);
  for (const source of [attentionSource, manualSource]) {
    assert.match(source, /import \{ isTerminalResult \} from "\.\/result-contract\.mjs"/);
    assert.match(source, /isTerminalResult\(result\)/);
    assert.doesNotMatch(source, /\["signed", "already_signed", "visited", "clicked"\]/);
  }
});

test("访问或点击但未确认的结果仍进入关注范围", () => {
  for (const status of ["visited", "clicked", "no_action", "deferred", "interactive_challenge"]) {
    assert.equal(TERMINAL_STATUSES.has(status), false, status);
    assert.equal(isTerminalResult({ status }), false, status);
  }
});
