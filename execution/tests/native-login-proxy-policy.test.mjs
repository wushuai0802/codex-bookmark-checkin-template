import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("native login proxy is origin-scoped, bound to the account profile and local SOCKS4", async () => {
  const launcher = await fs.readFile(new URL("../scripts/Open-PlainLoginChrome.ps1", import.meta.url), "utf8");
  assert.match(launcher, /nativeLoginProxyByOrigin/);
  assert.match(launcher, /\$origins\.Count -ne 1/);
  assert.match(launcher, /oauthExecutionAccountBindings/);
  assert.match(launcher, /Resolve-OAuthAccountConfiguration/);
  assert.match(launcher, /\$profilePath, \[string\]\$binding\.AutomationUserDataDir/);
  assert.match(launcher, /\$loginProxy\.Scheme -ne 'socks4'/);
  assert.match(launcher, /\$loginProxy\.DnsSafeHost -ne '127\.0\.0\.1'/);
  assert.match(launcher, /\$loginProxy\.UserInfo/);
  assert.match(launcher, /--proxy-server=/);
  assert.doesNotMatch(launcher, /--ignore-certificate-errors|--disable-web-security/);
});
