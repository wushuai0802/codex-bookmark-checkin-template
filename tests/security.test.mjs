import test from "node:test";
import assert from "node:assert/strict";
import { assertBookmarkNavigation, safeErrorMessage } from "../src/security.mjs";

test("导航仅允许书签源站与显式关联源站", () => {
  assert.equal(
    assertBookmarkNavigation("https://new.example/checkin", ["https://old.example", "https://new.example"]),
    "https://new.example/checkin",
  );
  assert.throws(
    () => assertBookmarkNavigation("https://unexpected.example/", ["https://old.example", "https://new.example"]),
    /拒绝跨站导航/,
  );
  assert.throws(
    () => assertBookmarkNavigation("http://new.example/checkin", ["http://new.example"]),
    /无凭据 HTTPS/,
  );
});

test("错误原因会移除用户目录、邮箱、令牌和 URL 查询凭据", () => {
  const value = safeErrorMessage(new Error(
    "failed C:\\Users\\private-user\\profile user" + "@example.net "
      + "token=secret-value https://example.test/callback?code=secret-value",
  ));
  assert.doesNotMatch(value, /private-user|user@example\.net|secret-value/);
  assert.match(value, /\[USER_PATH\]|\[EMAIL\]|\[REDACTED\]/);
});
