import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAutomationContext } from "./browser.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const screenshotPath = path.join(rootDirectory, "tmp", "open-captcha.png");
const challengePath = path.join(rootDirectory, "tmp", "open-captcha.json");
const answerPath = path.join(rootDirectory, "tmp", "open-answer.json");

await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
await fs.rm(answerPath, { force: true });

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  await page.goto("https://open.cd/plugin_sign-in.php", {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  const input = page.locator('input[name="imagestring"]');
  const submit = page.locator("button#ok");
  const images = page.locator("img");
  if (await input.count() !== 1 || await submit.count() !== 1 || await images.count() !== 1) {
    throw new Error("OpenCD 签到验证码页面结构与预期不符");
  }
  const image = images.first();
  await image.screenshot({ path: screenshotPath });
  await fs.writeFile(challengePath, JSON.stringify({
    createdAt: new Date().toISOString(),
    screenshotPath,
  }, null, 2));
  console.log(JSON.stringify({ status: "waiting_for_answer", screenshotPath }));

  const deadline = Date.now() + 90000;
  let answer = null;
  while (Date.now() < deadline) {
    try {
      answer = JSON.parse(await fs.readFile(answerPath, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  const code = String(answer?.code || "").trim();
  if (!/^[A-Z0-9]{6}$/i.test(code)) throw new Error("等待 OpenCD 六位验证码答案超时或格式无效");

  await input.fill(code);
  await submit.click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const success = /(?:签到成功|簽到成功|已签到|已簽到|获得|獲得|奖励|獎勵|"state"\s*:\s*"success")/i.test(bodyText);
  console.log(JSON.stringify({
    status: success ? "signed" : "unknown",
    url: page.url(),
    excerpt: bodyText.slice(0, 1500),
  }));
  if (!success) process.exitCode = 2;
} finally {
  await fs.rm(answerPath, { force: true }).catch(() => {});
  await fs.rm(challengePath, { force: true }).catch(() => {});
  await fs.rm(screenshotPath, { force: true }).catch(() => {});
  await context.close();
}
