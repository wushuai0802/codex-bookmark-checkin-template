import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("OAuth provider discovery accepts an exact short provider label before image fallback", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  const alternateBlock = source.slice(
    source.indexOf("for (const label of providerAltLabels)"),
    source.indexOf("return null;", source.indexOf("for (const label of providerAltLabels)")),
  );

  assert.match(alternateBlock, /getByText\(label, \{ exact: true \}\)/);
  assert.match(alternateBlock, /exactText\.count\(\) === 1/);
  assert.ok(
    alternateBlock.indexOf("getByText") < alternateBlock.indexOf("img[alt="),
    "short visible provider text should be checked before the image alt fallback",
  );
});

test("LinuxDO OAuth can fall back to the provider's official authorize endpoint", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /readJson\("\/api\/status"\)/);
  assert.match(source, /JSON\.stringify\(\{ provider: "linuxdo", intent: "login" \}\)/);
  assert.match(source, /"Content-Type": "application\/json"/);
  assert.match(source, /body\.data\?\.flow_token/);
  assert.match(source, /legacyPostState/);
  assert.match(source, /extractOAuthState\(await readJson\("\/api\/oauth\/state"\)\)/);
  assert.match(source, /new URL\("https:\/\/connect\.linux\.do\/oauth2\/authorize"\)/);
  assert.match(source, /resolved\.origin !== "https:\/\/connect\.linux\.do"/);
  assert.match(source, /url\.searchParams\.set\("redirect_uri", redirect\.href\)/);
  assert.match(source, /await startDirectLinuxDoOAuth\(page, redirectOverride\)/);
  assert.ok(
    source.indexOf("await startDirectLinuxDoOAuth(page, redirectOverride)")
      < source.indexOf("providerButton.click({ timeout: 5000 })"),
    "a configured callback override must start before the provider UI can discard it",
  );
});

test("OAuth recovery reuses authoritative daily API evidence before looking for a provider button", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  const evidenceCheck = source.indexOf("let existingDailyCheckin = await tryNewApiSignIn");
  const providerLookup = source.indexOf("let providerButton = await findVisibleProviderButton");
  assert.ok(evidenceCheck > 0 && evidenceCheck < providerLookup);
  assert.match(source, /reusedExistingDailyEvidence: true/);
  assert.match(source, /existingDailyCheckin = await tryNewApiCheckin\(page\)/);
  assert.match(source, /dailyCheckin = await tryNewApiCheckin\(page\)/);
});

test("OAuth provider click preserves a trusted gesture through transient overlays", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /providerButton\.click\(\{ timeout: 5000 \}\)\.catch/);
  assert.match(source, /page\.locator\("\.semi-portal"\)\.evaluateAll/);
  assert.match(source, /element\.style\.pointerEvents = "none"/);
  assert.equal(/element\.click\(\)/.test(source), false);
});

test("OAuth helper reports LinuxDO 429 without logging route traces", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /response\.status\(\) === 429/);
  assert.match(source, /failureCode: "oauth_rate_limited"/);
  assert.doesNotMatch(source, /oauthRouteTrace/);
});

test("OAuth helper classifies a failed top-level navigation without logging the route", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /request\.resourceType\(\) !== "document"/);
  assert.match(source, /unexpected_oauth_navigation_failed/);
  assert.match(source, /finalLocation\.protocol === "chrome-error:"/);
  assert.match(source, /failureCode: "site_flow_changed"/);
  assert.doesNotMatch(source, /excerpt: bodyText/);
});

test("OAuth helper classifies a rejected transferred callback as upstream unavailable", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /transferredCallbackRejected/);
  assert.match(source, /failureCode: "oauth_upstream_unavailable"/);
});

test("OAuth helper returns a bounded failure code when the flow throws", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  assert.match(source, /function classifyOAuthRecoveryFailure/);
  assert.match(source, /failureCode: classifyOAuthRecoveryFailure\(error\)/);
  assert.match(source, /site_flow_changed/);
  assert.match(source, /oauth_recovery_failed/);
  assert.doesNotMatch(source, /error\?\.stack/);
});

test("LinuxDO OAuth completes the Discourse SSO hop before connect authorization", async () => {
  const source = await fs.readFile(new URL("../src/oauth-login.mjs", import.meta.url), "utf8");
  const phaseLoop = source.indexOf("for (let authorizationPhase = 0; authorizationPhase < 3");
  const discourseHop = source.indexOf('authorizationLocation.hostname === "linux.do"', phaseLoop);
  const connectHop = source.indexOf('authorizationLocation.hostname !== "connect.linux.do"', phaseLoop);
  assert.ok(phaseLoop > 0 && discourseHop > phaseLoop && connectHop > discourseHop);
  assert.match(source, /url\.hostname !== "linux\.do"/);
  assert.match(source, /authorizationClicked = true/);
});
