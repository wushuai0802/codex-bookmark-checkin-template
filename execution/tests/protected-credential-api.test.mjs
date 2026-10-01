import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCredentialApiLoginResponse,
  classifyCredentialApiSelfResponse,
  configuredProtectedCredentialApiRule,
  credentialApiUserData,
  credentialApiStoredUser,
} from "../src/protected-credential-api.mjs";

const origin = "https://api.example";

test("受保护凭据 API 规则仅接受同源 HTTPS", () => {
  const rule = configuredProtectedCredentialApiRule(origin, {
    protectedCredentialApiLoginRules: {
      [origin]: { loginPath: "/api/user/login", selfPath: "/api/user/self" },
    },
  });
  assert.equal(rule.loginUrl.href, `${origin}/api/user/login`);
  assert.equal(rule.selfUrl.href, `${origin}/api/user/self`);
  assert.throws(() => configuredProtectedCredentialApiRule(origin, {
    protectedCredentialApiLoginRules: { [origin]: { loginPath: "https://other.example/login" } },
  }), /same-origin HTTPS/);
});

test("受保护凭据 API 登录与身份回读需要明确成功和一致用户 ID", () => {
  const body = { success: true, data: { id: 123456, username: "redacted" } };
  assert.deepEqual(credentialApiUserData(body).id, "123456");
  assert.equal(classifyCredentialApiLoginResponse({ statusCode: 200, body }).status, "ready");
  assert.equal(classifyCredentialApiSelfResponse({ statusCode: 200, body, expectedUserId: "123456" }).authenticated, true);
  assert.equal(classifyCredentialApiSelfResponse({ statusCode: 200, body, expectedUserId: "1" }).diagnostic, "self_identity_mismatch");
  assert.equal(classifyCredentialApiLoginResponse({ statusCode: 401, body: { success: false, message: "密码错误" } }).status, "invalid_credential");
});

test('nested login user keeps the same verified session after storage serialization', () => {
  const session = ['fixture','session'].join('.');
  const refresh = ['fixture','refresh'].join('.');
  const body = {success:true, data:{user:{id:123,username:'example'},access_token:session,refresh_token:refresh}};
  const stored = JSON.parse(JSON.stringify(credentialApiStoredUser(body)));
  assert.equal(stored.id, 123);
  assert.equal(stored.access_token, session);
  assert.equal(stored.refresh_token, refresh);
  assert.equal(credentialApiUserData(body).value.access_token, undefined);
  assert.equal(credentialApiStoredUser({success:true,data:{user:{id:123}}}), null);
});
