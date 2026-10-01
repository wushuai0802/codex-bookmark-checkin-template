import test from "node:test";
import assert from "node:assert/strict";
import { resolveOAuthRecoveryTargetOrigin, oauthRecoveryProvider } from "../src/oauth-recovery-target.mjs";

test("OAuth 恢复默认留在书签来源", () => {
  assert.equal(
    resolveOAuthRecoveryTargetOrigin("https://old.example/path", {}, ["https://old.example"]),
    "https://old.example",
  );
});

test('a migrated allowed origin supplies only an unambiguous LinuxDO provider label',()=>{
  const config={automaticOAuthProviders:{'https://related.example':'LinuxDO'}};
  assert.equal(oauthRecoveryProvider('https://primary.example',['https://primary.example','https://related.example'],config),'LinuxDO');
  assert.equal(oauthRecoveryProvider('https://primary.example',['https://primary.example'],config),null);
  assert.equal(oauthRecoveryProvider('https://primary.example',['https://related.example','https://other.example'],{
    automaticOAuthProviders:{...config.automaticOAuthProviders,'https://other.example':'GitHub'}}),null);
  assert.equal(oauthRecoveryProvider('https://primary.example',['https://related.example'],{
    automaticOAuthProviders:{...config.automaticOAuthProviders,'https://primary.example':'GitHub'}}),'GitHub');
});

test("OAuth 恢复别名只能指向书签明确允许的相关来源", () => {
  const config = {
    oauthRecoveryTargetOrigins: { "https://old.example": "https://new.example" },
  };
  assert.equal(
    resolveOAuthRecoveryTargetOrigin(
      "https://old.example",
      config,
      ["https://old.example", "https://new.example"],
    ),
    "https://new.example",
  );
  assert.throws(
    () => resolveOAuthRecoveryTargetOrigin("https://old.example", config, ["https://old.example"]),
    /不在书签允许来源中/,
  );
});

test("OAuth 恢复别名拒绝非 HTTPS 或带凭据来源", () => {
  assert.throws(
    () => resolveOAuthRecoveryTargetOrigin("https://old.example", {
      oauthRecoveryTargetOrigins: { "https://old.example": "http://new.example" },
    }, ["http://new.example"]),
    /HTTPS origin/,
  );
  const credentialUrl = ["https://user:secret", "new.example"].join("@");
  assert.throws(
    () => resolveOAuthRecoveryTargetOrigin("https://old.example", {
      oauthRecoveryTargetOrigins: { "https://old.example": credentialUrl },
    }, ["https://new.example"]),
    /无凭据 HTTPS origin/,
  );
});
