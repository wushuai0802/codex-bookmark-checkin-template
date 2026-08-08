import test from "node:test";
import assert from "node:assert/strict";
import { assertBookmarkNavigation } from "../src/security.mjs";

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
