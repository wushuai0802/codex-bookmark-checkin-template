import test from "node:test";
import assert from "node:assert/strict";
import {
  trustedLinuxDoAuthorizeRequest,
  trustedLinuxDoAuthorizeState,
} from "../src/oauth-recovery-target.mjs";

test("站点直达 LinuxDO 授权页时复用受信 state", () => {
  assert.equal(
    trustedLinuxDoAuthorizeState("https://connect.linux.do/oauth2/authorize?client_id=example&state=safe-state"),
    "safe-state",
  );
  assert.equal(trustedLinuxDoAuthorizeState("https://connect.linux.do/other?state=safe-state"), "");
  assert.equal(trustedLinuxDoAuthorizeState("https://evil.example/oauth2/authorize?state=safe-state"), "");
  assert.equal(trustedLinuxDoAuthorizeState("https://connect.linux.do/oauth2/authorize?state="), "");
});

test("站点 JSON 登录入口只接受回调到目标站点的 LinuxDO 授权地址", () => {
  const url = "https://connect.linux.do/oauth2/authorize?client_id=example&redirect_uri=https%3A%2F%2Fup.example%2Fapi%2Fauth%2Fcallback&response_type=code&state=safe-state";
  assert.deepEqual(trustedLinuxDoAuthorizeRequest(url, "https://up.example"), { href: url, state: "safe-state" });
  assert.equal(trustedLinuxDoAuthorizeRequest(url, "https://other.example"), null);
  assert.equal(trustedLinuxDoAuthorizeRequest(url.replace("connect.linux.do", "evil.example"), "https://up.example"), null);
  assert.equal(trustedLinuxDoAuthorizeRequest(url.replace("response_type=code", "response_type=token"), "https://up.example"), null);
});
