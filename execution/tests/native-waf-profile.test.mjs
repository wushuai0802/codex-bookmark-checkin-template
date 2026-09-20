import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { nativeWafProfileForOrigin, resolveProjectDataProfile } from "../src/native-waf-profile.mjs";

const root = path.resolve("test-project");

test("原生 WAF 普通登录恢复使用该站专属 Profile", () => {
  const config = {
    nativeWafPreflightUrls: [{
      url: "https://protected.example/attendance.php",
      automationUserDataDir: "data/sites/protected/chrome-user-data",
    }],
  };
  assert.equal(
    nativeWafProfileForOrigin(config, "https://protected.example", root),
    path.resolve(root, "data/sites/protected/chrome-user-data"),
  );
});

test("原生 WAF Profile 不能逃出项目 data 目录", () => {
  assert.throws(
    () => resolveProjectDataProfile(root, "../outside", "test profile"),
    /strict child/,
  );
});

test("原生挑战预热也能提供站点专属 Profile", () => {
  const config = {
    nativeChallengePreflight: [{
      url: "https://challenge.example/checkin",
      automationUserDataDir: "data/sites/challenge/chrome-user-data",
    }],
  };
  assert.equal(
    nativeWafProfileForOrigin(config, "https://challenge.example", root),
    path.resolve(root, "data/sites/challenge/chrome-user-data"),
  );
});

test("同源相同 Profile 会去重", () => {
  const profile = "data/sites/shared/chrome-user-data";
  const config = {
    nativeWafPreflightUrls: [{ url: "https://shared.example/attendance.php", automationUserDataDir: profile }],
    nativeChallengePreflight: [{ url: "https://shared.example/checkin", automationUserDataDir: profile }],
  };
  assert.equal(
    nativeWafProfileForOrigin(config, "https://shared.example", root),
    path.resolve(root, profile),
  );
});

test("同源不同 Profile 会立即拒绝", () => {
  const config = {
    nativeWafPreflightUrls: [{
      url: "https://conflict.example/attendance.php",
      automationUserDataDir: "data/sites/conflict-a/chrome-user-data",
    }],
    nativeChallengePreflight: [{
      url: "https://conflict.example/checkin",
      automationUserDataDir: "data/sites/conflict-b/chrome-user-data",
    }],
  };
  assert.throws(
    () => nativeWafProfileForOrigin(config, "https://conflict.example", root),
    /conflicting native WAF profiles/,
  );
});

test("同源首项无 Profile 时继续采用后续有效配置", () => {
  const config = {
    nativeWafPreflightUrls: [{ url: "https://later.example/attendance.php", automationUserDataDir: "" }],
    nativeChallengePreflight: [{
      url: "https://later.example/checkin",
      automationUserDataDir: "data/sites/later/chrome-user-data",
    }],
  };
  assert.equal(
    nativeWafProfileForOrigin(config, "https://later.example", root),
    path.resolve(root, "data/sites/later/chrome-user-data"),
  );
});

test("同源配置的 Profile 逃出 data 时拒绝", () => {
  assert.throws(
    () => nativeWafProfileForOrigin({
      nativeChallengePreflight: [{
        url: "https://escape.example/checkin",
        automationUserDataDir: "../outside",
      }],
    }, "https://escape.example", root),
    /strict child/,
  );
});
