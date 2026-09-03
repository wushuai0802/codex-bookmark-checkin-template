import test from "node:test";
import assert from "node:assert/strict";
import {
  isConfirmedNotAvailable,
  isTerminalResult,
  normalizeResultContract,
} from "../src/result-contract.mjs";

function unavailable(overrides = {}) {
  return {
    status: "not_available",
    availabilityKind: "feature_disabled",
    evidence: {
      source: "new_api_checkin_status",
      outcome: "message_not_enabled",
      authoritative: true,
      confirmedAt: "2026-09-03T00:00:00.000Z",
    },
    ...overrides,
  };
}

test("未开放签到只有证据完整时才是终态", () => {
  assert.equal(isConfirmedNotAvailable(unavailable()), true);
  assert.equal(isTerminalResult(unavailable()), true);
  assert.equal(isTerminalResult({ status: "not_available" }), false);
  assert.equal(isTerminalResult(unavailable({ evidence: { source: "api", authoritative: false, confirmedAt: "2026-09-03T00:00:00Z" } })), false);
});

test("配置取消和临时维护必须带匹配的分类标记", () => {
  const configDisabled = unavailable({
    availabilityKind: "task_disabled",
    disabledByConfig: true,
    evidence: { source: "configuration", authoritative: true, confirmedAt: "2026-09-03T00:00:00Z" },
  });
  const temporary = unavailable({
    availabilityKind: "temporary_unavailable",
    temporarilyUnavailable: true,
    evidence: { source: "operator_confirmation", authoritative: true, confirmedAt: "2026-09-03T00:00:00Z" },
  });
  assert.equal(isTerminalResult(configDisabled), true);
  assert.equal(isTerminalResult(temporary), true);
  assert.equal(isTerminalResult({ ...configDisabled, disabledByConfig: false }), false);
});

test("缺失证据的未开放结果会降级为未确认", () => {
  const normalized = normalizeResultContract({ status: "not_available", reason: "guessed" });
  assert.equal(normalized.status, "unconfirmed");
  assert.equal(normalized.failureCode, "missing_not_available_evidence");
});

test("任意来源、错误 outcome 和明显未来时间不能伪装成权威终态", () => {
  const now = new Date("2026-09-03T00:00:00.000Z");
  assert.equal(isConfirmedNotAvailable(unavailable({
    evidence: { source: "arbitrary_claim", outcome: "message_not_enabled", authoritative: true, confirmedAt: now.toISOString() },
  }), now), false);
  assert.equal(isConfirmedNotAvailable(unavailable({
    evidence: { source: "new_api_checkin_status", outcome: "success", authoritative: true, confirmedAt: now.toISOString() },
  }), now), false);
  assert.equal(isConfirmedNotAvailable(unavailable({
    evidence: { source: "new_api_checkin_status", outcome: "message_not_enabled", authoritative: true, confirmedAt: "2099-01-01T00:00:00Z" },
  }), now), false);
});

test("缓存证据必须保留受信任的原始来源和 outcome", () => {
  const evidence = {
    source: "cached_confirmation",
    originalSource: "new_api_checkin_status",
    outcome: "message_not_enabled",
    authoritative: true,
    confirmedAt: "2026-09-03T00:00:00.000Z",
  };
  assert.equal(isConfirmedNotAvailable(unavailable({ evidence })), true);
  assert.equal(isConfirmedNotAvailable(unavailable({ evidence: { ...evidence, originalSource: "arbitrary_claim" } })), false);
});
