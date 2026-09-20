import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { tryNewApiCheckin } from "../src/browser.mjs";
import { isTerminalResult } from "../src/result-contract.mjs";

async function probe(status, body) {
  let requests = 0;
  const storage = { length: 1, key: () => "user", getItem: () => '{"id":123}' };
  const sandbox = { localStorage: storage, sessionStorage: storage, document: { cookie: "x=1" }, Date, fetch: async () => {
    requests++;
    return { status, text: async () => JSON.stringify(body), json: async () => body };
  } };
  const result = await tryNewApiCheckin({ evaluate: fn => vm.runInNewContext("(" + fn.toString() + ")()", sandbox) });
  return { result, requests };
}

test("feature-disabled API evidence survives cold starts and does not submit", async () => {
  for (let coldStart = 0; coldStart < 2; coldStart++) {
    const { result, requests } = await probe(200, { success: false, message: "签到功能未启用" });
    assert.equal(result.status, "not_available");
    assert.equal(isTerminalResult(result), true);
    assert.equal(requests, 2);
  }
});

test('a current-day New API status carries account-bound authoritative evidence',async()=>{
  const {result,requests}=await probe(200,{success:true,data:{stats:{checked_in_today:true}}});
  assert.equal(result.status,'already_signed');
  assert.equal(result.evidence.source,'new_api_checkin_status');
  assert.equal(result.evidence.accountId,'123');
  assert.equal(result.evidence.statusSignal,'checked_in_today');
  assert.equal(result.evidence.authoritative,true);
  assert.equal(requests,2);
});

test("a 401/403 is not disguised as feature disabled", async () => {
  for (const status of [401, 403]) {
    const { result, requests } = await probe(status, { success: false, message: "未启用" });
    assert.equal(result.status, "login_required");
    assert.equal(requests, 3);
  }
});

test("verified disabled result is returned before generic login-page classification", async () => {
  const source = await fs.readFile(new URL("../src/browser.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("let initialApiResult = null;");
  const apiGate = source.indexOf('initialApiResult.status !== "not_available" || isTerminalResult(initialApiResult)', begin);
  assert.ok(apiGate > begin && apiGate < source.indexOf("let state = await waitForManagedChallenge", begin));
  assert.match(source, /discoveredApiResult.status !== "not_available" \|\| isTerminalResult\(discoveredApiResult\)/);
});

test("server errors and rate limits cannot claim disabled or signed", async () => {
  for (const status of [429, 500, 521]) {
    const { result, requests } = await probe(status, { success: false, message: "未启用" });
    assert.equal(result.status, "deferred");
    assert.equal(isTerminalResult(result), false);
    assert.equal(requests, 2);
  }
});
