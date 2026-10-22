import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { awaitOffscreenWindow, installOffscreenWindows } from "../src/offscreen-windows.mjs";
import { launchAutomationContext } from "../src/browser.mjs";

const execFileAsync = promisify(execFile);
const offscreen = { headless: false, backgroundWindowMode: "offscreen" };

function fixture({ state = "normal", failure } = {}) {
  const context = new EventEmitter();
  const calls = [];
  const page = { isClosed: () => false, waitForEvent: () => {} };
  context.pages = () => [page];
  context.newPage = () => {};
  context.waitForEvent = () => {};
  context.newCDPSession = async (target) => ({
    send: async (method, params) => {
      calls.push({ target, method, params });
      if (failure) throw failure;
      if (method === "Browser.getWindowForTarget") return { windowId: target === page ? 1 : 2, bounds: { windowState: state } };
    },
    detach: async () => { calls.push({ target, method: "detach" }); },
  });
  return { context, page, calls };
}

test("visible manual sessions and headless contexts never install window management", async () => {
  for (const config of [{ headless: false, backgroundWindowMode: "visible" },
    { headless: true, backgroundWindowMode: "offscreen" }, {}]) {
    const { context, page, calls } = fixture();
    const methods = [context.newPage, context.waitForEvent, page.waitForEvent];
    await installOffscreenWindows(context, config);
    assert.equal(context.listenerCount("page"), 0);
    assert.deepEqual(calls, []);
    assert.deepEqual([context.newPage, context.waitForEvent, page.waitForEvent], methods);
  }
});

test("offscreen management waits for existing windows and constrains new popup windows", async () => {
  const { context, page, calls } = fixture();
  const methods = [context.newPage, context.waitForEvent, page.waitForEvent];
  await installOffscreenWindows(context, offscreen);
  const popup = { isClosed: () => false, waitForEvent: () => {} };
  context.emit("page", popup);
  await awaitOffscreenWindow(popup);
  assert.deepEqual(calls.filter((call) => call.method === "Browser.setWindowBounds").map((call) => call.params), [
    { windowId: 1, bounds: { left: -32000, top: -32000 } },
    { windowId: 2, bounds: { left: -32000, top: -32000 } },
  ]);
  assert.equal(calls.filter((call) => call.method === "detach").length, 2);
  assert.deepEqual([context.newPage, context.waitForEvent, page.waitForEvent], methods);
});

test("maximized popup windows are normalized before changing their geometry", async () => {
  const { context, calls } = fixture({ state: "maximized" });
  await installOffscreenWindows(context, offscreen);
  assert.deepEqual(calls.filter((call) => call.method === "Browser.setWindowBounds").map((call) => call.params), [
    { windowId: 1, bounds: { windowState: "normal" } },
    { windowId: 1, bounds: { left: -32000, top: -32000 } },
  ]);
});

test("reinstalling the same context preserves its original placement result", async () => {
  const { context, calls } = fixture();
  await installOffscreenWindows(context, offscreen);
  await installOffscreenWindows(context, offscreen);
  assert.equal(context.listenerCount("page"), 1);
  assert.equal(calls.filter((call) => call.method === "detach").length, 1);
  const broken = fixture({ failure: new Error("synthetic CDP failure") });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(() => installOffscreenWindows(broken.context, offscreen),
      { failureCode: "offscreen_window_management_failed" });
  }
});

test("a callback that already closed its popup does not become a window management failure", async () => {
  const { context } = fixture();
  await installOffscreenWindows(context, offscreen);
  const popup = { isClosed: () => true };
  context.emit("page", popup);
  await assert.doesNotReject(() => awaitOffscreenWindow(popup));
});

test("positioning failures remain observable while event listeners do not reject unhandled", async () => {
  const { context } = fixture({ failure: new Error("synthetic CDP failure") });
  await assert.rejects(() => installOffscreenWindows(context, offscreen), { failureCode: "offscreen_window_management_failed" });
  const popup = { isClosed: () => false };
  context.emit("page", popup);
  await assert.rejects(() => awaitOffscreenWindow(popup), { failureCode: "offscreen_window_management_failed" });
});

test("a stalled CDP command times out without waiting indefinitely for detach", async () => {
  const { context } = fixture();
  context.newCDPSession = async () => ({
    send: () => new Promise(() => {}),
    detach: () => new Promise(() => {}),
  });
  const started = Date.now();
  await assert.rejects(() => installOffscreenWindows(context, offscreen, { timeoutMs: 25 }),
    { failureCode: "offscreen_window_management_timeout" });
  assert.ok(Date.now() - started < 1000);
});

test("a CDP session that attaches after the deadline still gets detached", async () => {
  const { context } = fixture();
  let resolveAttach, detached = false;
  context.newCDPSession = () => new Promise((resolve) => { resolveAttach = resolve; });
  await assert.rejects(() => installOffscreenWindows(context, offscreen, { timeoutMs: 25 }),
    { failureCode: "offscreen_window_management_timeout" });
  resolveAttach({ detach: async () => { detached = true; } });
  await Promise.resolve();
  assert.equal(detached, true);
});

async function ownedWindows(profile) {
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class OffscreenTestWindows {
  public struct Rect { public int Left,Top,Right,Bottom; }
  public delegate bool Callback(IntPtr h,IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder n,int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  public static IntPtr[] Find(int[] pids) {
    var ids=new HashSet<int>(pids);var found=new List<IntPtr>();
    EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(!ids.Contains((int)id))return true;
      var n=new StringBuilder(128);GetClassName(h,n,n.Capacity);if(n.ToString()=="Chrome_WidgetWin_1")found.Add(h);return true;},IntPtr.Zero);
    return found.ToArray();
  }
}
'@
$profile=[Environment]::GetEnvironmentVariable('CHECKIN_WINDOW_TEST_PROFILE')
$ids=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profile) } | Select-Object -ExpandProperty ProcessId)
$left=[OffscreenTestWindows]::GetSystemMetrics(76);$top=[OffscreenTestWindows]::GetSystemMetrics(77)
$right=$left+[OffscreenTestWindows]::GetSystemMetrics(78);$bottom=$top+[OffscreenTestWindows]::GetSystemMetrics(79)
$windows=@([OffscreenTestWindows]::Find([int[]]$ids) | ForEach-Object {
  $rect=New-Object OffscreenTestWindows+Rect;[void][OffscreenTestWindows]::GetWindowRect($_,[ref]$rect)
  [pscustomobject]@{visible=[OffscreenTestWindows]::IsWindowVisible($_);minimized=[OffscreenTestWindows]::IsIconic($_);
    intersectsDesktop=($rect.Left -lt $right -and $rect.Right -gt $left -and $rect.Top -lt $bottom -and $rect.Bottom -gt $top)}
})
ConvertTo-Json -InputObject $windows -Compress
`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
    windowsHide: true, encoding: "utf8", timeout: 15000,
    env: { ...process.env, CHECKIN_WINDOW_TEST_PROFILE: profile },
  });
  return JSON.parse(stdout);
}

test("real Chrome popups stay offscreen and retain opener messages, callbacks and self closure", {
  skip: process.platform !== "win32", timeout: 30000,
}, async (t) => {
  const chromeExecutable = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  try { await fs.access(chromeExecutable); } catch { t.skip("Chrome is not installed at the test location"); return; }
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const profile = await fs.mkdtemp(path.join(root, "tmp", "offscreen-window-test-"));
  let context;
  try {
    context = await launchAutomationContext({ ...offscreen, chromeExecutable, automationUserDataDir: profile });
    const localOrigin = "http://127.0.0.1:43125";
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== localOrigin) { await route.abort(); return; }
      const body = url.pathname === "/opener"
        ? '<button id="open" onclick="window.open(\'/landing\',\'synthetic-popup\',\'popup=yes,width=500,height=350,left=100,top=100\')">Open</button><button id="callback" onclick="window.open(\'/callback\',\'synthetic-callback\',\'popup=yes,width=500,height=350\')">Callback</button><script>window.messages=[];addEventListener("message",event=>window.messages.push(event.data));</script>'
        : url.pathname === "/callback"
          ? '<script>window.opener.postMessage("synthetic-automatic-callback",location.origin);window.close();</script>'
          : "<p>Local synthetic popup</p>";
      await route.fulfill({ status: 200, contentType: "text/html", body });
    });
    const page = context.pages()[0];
    await page.goto(localOrigin + "/opener");
    const event = page.waitForEvent("popup");
    await page.locator("#open").click();
    const popup = await event;
    await awaitOffscreenWindow(popup);
    assert.equal(await popup.opener(), page);
    const session = await context.newCDPSession(popup);
    const { bounds } = await session.send("Browser.getWindowForTarget");
    await session.detach();
    // Chrome may scale or clamp negative coordinates. The owned native
    // window rectangles below must still prove no desktop intersection.
    assert.ok(Number.isFinite(bounds.left) && bounds.left < 0);
    assert.ok(Number.isFinite(bounds.top) && bounds.top < 0);
    const windows = await ownedWindows(profile);
    assert.equal(windows.length, 2);
    assert.ok(windows.every((window) => window.visible && !window.minimized && !window.intersectsDesktop));
    await popup.evaluate(() => { window.opener.postMessage("synthetic-manual-callback", location.origin); window.close(); });
    await page.waitForFunction(() => window.messages.includes("synthetic-manual-callback"));
    assert.equal(popup.isClosed(), true);
    const callbackEvent = page.waitForEvent("popup");
    await page.locator("#callback").click();
    const callback = await callbackEvent;
    await awaitOffscreenWindow(callback);
    await page.waitForFunction(() => window.messages.includes("synthetic-automatic-callback"));
    assert.equal(callback.isClosed(), true);
    assert.equal(page.url(), localOrigin + "/opener");
  } finally {
    await context?.close();
  }
  assert.deepEqual(await ownedWindows(profile), []);
});
