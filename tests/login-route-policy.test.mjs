import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isCredentialLoginRoute, isLoginOrSignInRoute } from "../src/url-routes.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("登录路由识别覆盖 NexusPHP 的 login.php", () => {
  for (const value of [
    "https://tracker.example/login",
    "https://tracker.example/login.php?returnto=%2Fattendance.php",
    "https://tracker.example/sign-in.aspx",
    "https://tracker.example/#/signin",
  ]) assert.equal(isCredentialLoginRoute(value), true, value);
  assert.equal(isCredentialLoginRoute("https://tracker.example/attendance.php"), false);
  assert.equal(isLoginOrSignInRoute("https://tracker.example/auth/callback"), false);
});

test("原生恢复脚本不会把 login.php 误报为已登录", async () => {
  const savedPassword = await fs.readFile(path.join(root, "scripts", "Invoke-PlainSavedPasswordAccessibility.ps1"), "utf8");
  const plainWaf = await fs.readFile(path.join(root, "scripts", "Invoke-PlainWafAccessibility.ps1"), "utf8");
  assert.match(savedPassword, /\(\?:\\\.\(\?:php\|asp\|aspx\|html\?\)\)\?/i);
  assert.match(plainWaf, /\(\?:\\\.\(\?:php\|asp\|aspx\|html\?\)\)\?/i);
  assert.match(savedPassword, /Dismiss-PasswordProtectionPrompt/);
  assert.match(savedPassword, /Disable-AutoLogoutOption/);
});
