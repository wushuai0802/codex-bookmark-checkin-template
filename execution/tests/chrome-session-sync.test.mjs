import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("批量站点会话同步先提取标签页 sessionStorage 再验证目标会话", async () => {
  const source = await fs.readFile(new URL("../scripts/Sync-ChromeSiteSessions.ps1", import.meta.url), "utf8");
  const extractorDeclaration = source.indexOf("Extract-ChromeSessionStorage.mjs");
  const extractorCall = source.indexOf("& node $sessionExtractor");
  const helperCall = source.indexOf("& node $helper");
  assert.ok(extractorDeclaration > 0);
  assert.ok(extractorCall > extractorDeclaration);
  assert.ok(helperCall > extractorCall);
  assert.match(source, /Test-Path -LiteralPath \$sessionDatabase/);
  assert.match(source, /Chrome sessionStorage 提取器返回了无效结果/);
  assert.match(source, /Remove-Item -LiteralPath \$temporaryPath -Recurse -Force/);
  assert.ok(source.indexOf("$resolvedSessionStoragePath, \"$resolvedSessionStoragePath.bak\"") < source.indexOf("+ @($resolvedShadowRoot)"));
  assert.match(source, /sessionTemporaryFiles/);
  assert.match(source, /cleanupErrors/);
});

test("New API 的直接 uid 会参与只读账号验证", async () => {
  const source = await fs.readFile(new URL("../scripts/Sync-ChromeSiteSession.mjs", import.meta.url), "utf8");
  assert.match(source, /storage\.getItem\("uid"\)/);
  assert.match(source, /\^\[1-9\]\\d\{0,18\}\$/);
  assert.match(source, /"New-Api-User": id/);
});

test("含会话值的 Node 临时文件在重命名失败时也会清理", async () => {
  for (const relative of ["../scripts/Extract-ChromeSessionStorage.mjs", "../scripts/Sync-ChromeSiteSession.mjs"]) {
    const source = await fs.readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /finally \{\s*await fs\.rm\((?:temporary|temporaryOutput), \{ force: true \}\)\.catch/);
  }
});

test("sessionStorage 提取器兼容 Chrome 插件的新旧依赖目录", async () => {
  const source = await fs.readFile(new URL("../scripts/Extract-ChromeSessionStorage.mjs", import.meta.url), "utf8");
  const currentLayout = source.indexOf('path.join(pluginRoot, version, "node_modules", "classic-level")');
  const legacyLayout = source.indexOf('path.join(pluginRoot, version, "scripts", "node_modules", "classic-level")');
  assert.ok(currentLayout > 0);
  assert.ok(legacyLayout > currentLayout);
});
