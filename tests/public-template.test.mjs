import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("公开默认配置不启用外部通知", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  assert.equal(defaults.notification.mode, "none");
  assert.equal(defaults.notification.executable, "");
});

test("公开模板不预设任何用户的书签文件夹名称", async () => {
  const defaults = JSON.parse(await fs.readFile(new URL("../config/defaults.json", import.meta.url), "utf8"));
  const answers = JSON.parse(await fs.readFile(new URL("../setup/answers.example.json", import.meta.url), "utf8"));
  const questions = JSON.parse(await fs.readFile(new URL("../setup/questions.json", import.meta.url), "utf8"));
  assert.deepEqual(defaults.mobileFolderNames, []);
  assert.deepEqual(defaults.targetFolderNames, []);
  assert.deepEqual(answers.mobileFolderNames, []);
  assert.deepEqual(answers.targetFolderNames, []);
  const scope = questions.groups.find((group) => group.id === "bookmark_scope");
  assert.deepEqual(scope.askBefore, ["automation_policy", "notification"]);
});

test("公开站点规则只包含无凭据 HTTPS URL", async () => {
  const rules = JSON.parse(await fs.readFile(new URL("../config/site-rules.public.json", import.meta.url), "utf8"));
  const serialized = JSON.stringify(rules);
  assert.doesNotMatch(serialized, /(?:password|passwd|cookie|access_token|authorization)[=:]/i);
  const collectStrings = (value) => typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.entries(value).flatMap(([key, nested]) => [key, ...collectStrings(nested)])
        : [];
  for (const value of collectStrings(rules).filter((item) => item.startsWith("http"))) {
    const url = new URL(value);
    assert.equal(url.protocol, "https:");
    assert.equal(url.username, "");
    assert.equal(url.password, "");
  }
});

test("本机配置、结果和凭据目录被 Git 忽略", async () => {
  const ignore = await fs.readFile(new URL("../.gitignore", import.meta.url), "utf8");
  for (const pattern of ["config/config.json", "config/config.local.json", "setup/answers.json", "data/", "logs/*", "tmp/*"]) {
    assert.match(ignore, new RegExp(pattern.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
});
