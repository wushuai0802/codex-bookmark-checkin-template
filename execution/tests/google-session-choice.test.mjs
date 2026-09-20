import test from "node:test";
import assert from "node:assert/strict";
import { resumeSingleGoogleAccount } from "../src/google-session-choice.mjs";

function fakePage({ url = "https://accounts.google.com/v3/signin/accountchooser", choices = 1, credentials = 0, clickError = false } = {}) {
  let clicks = 0;
  return { url: () => url, clicks: () => clicks,
    locator: selector => selector.startsWith("input") ? { count: async () => credentials } : {
      count: async () => choices, isEnabled: async () => true,
      click: async () => { clicks++; if (clickError) throw new Error("unknown click outcome"); },
    },
  };
}

test("one existing Google choice may resume only once in an isolated identity", async () => {
  const page = fakePage(), state = { attempted: false };
  assert.equal(await resumeSingleGoogleAccount(page, state, { isolatedIdentity: true }), true);
  assert.equal(await resumeSingleGoogleAccount(page, state, { isolatedIdentity: true }), false);
  assert.equal(page.clicks(), 1);
});

test("ambiguous accounts, credential forms, consent, and foreign origins are not automated", async () => {
  for (const options of [{choices:0},{choices:2},{credentials:1},
    {url:"https://accounts.google.com/signin/oauth/consent"},
    {url:"https://accounts.google.com.attacker.test/v3/signin/accountchooser"},
    {url:"http://accounts.google.com/v3/signin/accountchooser"}]) {
    const page = fakePage(options);
    assert.equal(await resumeSingleGoogleAccount(page, {}, { isolatedIdentity: true }), false);
    assert.equal(page.clicks(), 0);
  }
  const page = fakePage();
  assert.equal(await resumeSingleGoogleAccount(page, {}), false);
});

test("an uncertain click is not repeated", async () => {
  const page = fakePage({clickError:true}), state = {};
  await assert.rejects(resumeSingleGoogleAccount(page, state, {isolatedIdentity:true}), /unknown click outcome/);
  assert.equal(await resumeSingleGoogleAccount(page, state, {isolatedIdentity:true}), false);
  assert.equal(page.clicks(), 1);
});
