import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs/promises";
import { checkNewApiAccount, oauthAccountCheckinMode } from "../src/new-api-account-checkin.mjs";
import { planFingerprint } from "../src/result-identity.mjs";

const origin = "https://new-api.example";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const self = (id = 100) => ({ success: true, data: { id } });
const calendar = (signed = true, date = today) => ({ success: true, data: {
  enabled: true, stats: { checked_in_today: signed, records: signed ? [{ checkin_date: date, quota_awarded: 321 }] : [] },
} });
function fixture(responses, storedId = 100) {
  const calls = [];
  const storage = { getItem: (key) => key === "user" && storedId != null ? JSON.stringify({ id: storedId }) : null };
  const page = {
    url: () => `${origin}/profile`,
    evaluate: async (fn, input) => {
      const environment = {
        input, localStorage: storage, sessionStorage: { getItem: () => null }, Intl, Date, AbortSignal,
        setTimeout: (callback) => callback(),
        fetch: async (url, options) => {
          calls.push({ url, ...options });
          assert.ok(responses.length, `Unexpected request: ${url}`);
          const next = responses.shift();
          if (next instanceof Error) throw next;
          const status = next.httpStatus ?? 200;
          return { status, ok: status >= 200 && status < 300, json: async () => next.body ?? next };
        },
      };
      return JSON.parse(JSON.stringify(await vm.runInNewContext(`(${fn.toString()})(input)`, environment)));
    },
  };
  return { page, calls };
}
test("calendar proof belongs to the expected account and current Shanghai day", async () => {
  const f = fixture([self(), calendar()]);
  const result = await checkNewApiAccount(f.page, origin, "100");
  assert.equal(result.status, "already_signed");
  assert.equal(result.evidence.accountId, "100");
  assert.equal(result.evidence.checkinDate, today);
  assert.equal(result.evidence.quotaAwarded, 321);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 0);
});
test("another logged-in account cannot submit or reuse success", async () => {
  const f = fixture([self(200)], 200);
  const result = await checkNewApiAccount(f.page, origin, "100");
  assert.equal(result.failureCode, "account_mismatch");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].headers["New-Api-User"], "200");
});
test("fresh encrypted-cookie sessions can authenticate using the configured ID", async () => {
  const f = fixture([self(), calendar()], null);
  assert.equal((await checkNewApiAccount(f.page, origin, "100")).status, "already_signed");
  assert.equal(f.calls[0].headers["New-Api-User"], "100");
});
test("a successful action needs calendar readback and a final identity check", async () => {
  const f = fixture([self(), calendar(false), { success: true }, calendar(), self()]);
  const result = await checkNewApiAccount(f.page, origin, "100");
  assert.equal(result.status, "signed");
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.ok(f.calls.every(c => c.redirect === "error" && c.credentials === "include"));
});
test("an uncertain POST is not repeated and can recover from authoritative readback", async () => {
  const f = fixture([self(), calendar(false), new Error("timeout"), calendar(), self()]);
  assert.equal((await checkNewApiAccount(f.page, origin, "100")).status, "already_signed");
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
test("missing post-action proof stops retries rather than claiming success", async () => {
  const f = fixture([self(), calendar(false), { success: true }, calendar(false), calendar(false), calendar(false)]);
  const result = await checkNewApiAccount(f.page, origin, "100");
  assert.equal(result.failureCode, "submission_outcome_unknown");
  assert.equal(result.retryable, false);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});
test("stale records and string booleans cannot confirm or trigger an action", async () => {
  for (const body of [calendar(true, "2000-01-01"), { success: true, data: { stats: { checked_in_today: "false" } } }]) {
    const f = fixture([self(), body]);
    assert.equal((await checkNewApiAccount(f.page, origin, "100")).status, "deferred");
    assert.equal(f.calls.length, 2);
  }
});
test("read-only checks never POST, even when unsigned", async () => {
  const f = fixture([self(), calendar(false)]);
  assert.equal((await checkNewApiAccount(f.page, origin, "100", { submit: false })).status, "not_signed");
  assert.equal(f.calls.length, 2);
});
test("identity changes during an action prevent success", async () => {
  const f = fixture([self(), calendar(false), { success: true }, calendar(), self(200)]);
  assert.equal((await checkNewApiAccount(f.page, origin, "100")).failureCode, "submission_outcome_unknown");
});
test("unknown identity, foreign origins, and invalid IDs fail closed", async () => {
  const f = fixture([{ httpStatus: 401 }]);
  assert.equal((await checkNewApiAccount(f.page, origin, "100")).status, "login_required");
  await assert.rejects(checkNewApiAccount(f.page, "https://other.example", "100"), /origin/);
  await assert.rejects(checkNewApiAccount(f.page, origin, "bad"), /account ID/);
});
test("execution mode is validated and invalidates plan reuse", () => {
  assert.equal(oauthAccountCheckinMode(), "oauth_relogin");
  assert.equal(oauthAccountCheckinMode("new_api"), "new_api");
  assert.throws(() => oauthAccountCheckinMode("typo"), /checkinMode/);
  const base = { origin, accountKey: "example-100", accountId: "100" };
  assert.equal(planFingerprint([base]), planFingerprint([{ ...base, checkinMode: "oauth_relogin" }]));
  assert.notEqual(planFingerprint([base]), planFingerprint([{ ...base, checkinMode: "new_api" }]));
});

test("OAuth consent targets the accessible checkbox, not a hidden implementation input", async () => {
  const source = await fs.readFile(new URL("../src/native-oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /agreementCheckbox = activePage.getByRole\("checkbox"\)/);
  assert.match(source, /agreementCheckbox.check\(\{ timeout: 5000 \}\)/);
  assert.doesNotMatch(source, /agreementCheckbox.check\(\{ force: true/);
});
