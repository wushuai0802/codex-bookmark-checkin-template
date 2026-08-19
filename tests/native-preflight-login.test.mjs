import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("native WAF preflight login state enters login recovery before challenge retry", async () => {
  const source = await fs.readFile(new URL("../src/index.mjs", import.meta.url), "utf8");
  const loginBranch = source.indexOf('preflight?.inspectionStatus === "login_required"');
  const genericWafBranch = source.indexOf("if (nativeWafOrigins.has(target.origin))", loginBranch + 1);
  assert.ok(loginBranch > 0 && genericWafBranch > loginBranch);
  assert.match(source, /loginRecovery\?\.succeeded && nativeWafOrigins\.has\(target\.origin\)/);
  assert.match(source, /loginRecovered: true/);
});
