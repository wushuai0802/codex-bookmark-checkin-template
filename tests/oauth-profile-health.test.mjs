import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("健康检查把主 OAuth 专属 profile 纳入存在、唯一和孤立校验", async () => {
  const source = await fs.readFile(path.join(root, "scripts", "Test-CheckinHealth.ps1"), "utf8");
  assert.match(source, /oauthAccountIdentities\.PSObject\.Properties/);
  assert.match(source, /identity\.automationUserDataDir/);
  assert.match(source, /oauthIdentityProfilesPresent/);
  assert.match(source, /oauthAccountProfilesUnique/);
  assert.match(source, /configuredOAuthProfilePathKeys/);
  assert.match(source, /noOrphanOAuthProfiles/);
});

test("公开示例为主身份使用匿名专属 profile", async () => {
  const example = JSON.parse(await fs.readFile(path.join(root, "config", "config.local.example.json"), "utf8"));
  const identity = example.oauthAccountIdentities["https://example.com"];
  assert.equal(identity.automationUserDataDir, "data/accounts/example-primary/chrome-user-data");
  assert.doesNotMatch(JSON.stringify(example), /agentrouter|245770|336/iu);
});

test("原生 OAuth 的权威终态直接进入恢复结果且不启动全局 profile 复查", async () => {
  const source = await fs.readFile(path.join(root, "src", "index.mjs"), "utf8");
  assert.match(source, /authoritativeNativeOAuthDailyCheckin\(method\.method, outcome\)/);
  assert.match(source, /loginRecovery\?\.authoritativeDailyCheckin/);
  assert.match(source, /\["signed", "already_signed"\]\.includes\(helperDailyCheckin\?\.status\)/);
  assert.match(source, /recoveryContext \?\?= await launchAutomationContext\(config\)/);
  assert.doesNotMatch(source, /const recoveryContext = await launchAutomationContext\(config\)/);
});
