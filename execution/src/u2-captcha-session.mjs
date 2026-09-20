import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchAutomationContext } from "./browser.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const screenshotPath = path.join(rootDirectory, "tmp", "u2-challenge.png");
const fullScreenshotPath = path.join(rootDirectory, "tmp", "u2-full.png");
const sourceImagePath = path.join(rootDirectory, "tmp", "u2-captcha-source.png");
const challengePath = path.join(rootDirectory, "tmp", "u2-challenge.json");
const answerPath = path.join(rootDirectory, "tmp", "u2-answer.json");

await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
await fs.rm(answerPath, { force: true });

const context = await launchAutomationContext(config);
try {
  const page = await context.newPage();
  const challengeStartedAt = Date.now();
  await page.goto("https://u2.dmhy.org/showup.php", {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });
  const buttons = page.locator('input[type="submit"][name^="captcha_"]');
  const count = await buttons.count();
  if (count < 2) throw new Error("U2 当前没有返回可选验证码题目");

  const options = await buttons.evaluateAll((elements) => elements.map((element) => ({
    name: element.name,
    text: element.value,
  })));
  const captchaImage = page.locator('img[alt="captcha"]');
  const captchaImageUrl = await captchaImage.getAttribute("src");
  let imageLoaded = false;
  try {
    await page.waitForFunction(() => {
      const image = document.querySelector('img[alt="captcha"]');
      return Boolean(image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0);
    }, null, { timeout: 50000 });
    imageLoaded = true;
  } catch {
    imageLoaded = false;
  }
  const geometry = await page.evaluate(() => {
    const buttonElements = [...document.querySelectorAll('input[type="submit"][name^="captcha_"]')];
    const message = document.querySelector('textarea[name="message"]');
    if (!buttonElements.length || !message) throw new Error("无法定位 U2 验证题区域");
    const rects = [message, ...buttonElements].map((element) => element.getBoundingClientRect());
    const minTop = Math.min(...rects.map((rect) => rect.top));
    const maxBottom = Math.max(...rects.map((rect) => rect.bottom));
    const nearbyImages = [...document.images]
      .map((image) => image.getBoundingClientRect())
      .filter((rect) => rect.width > 20 && rect.height > 20 && rect.bottom >= minTop - 300 && rect.top <= maxBottom + 100);
    const backgrounds = [...document.querySelectorAll("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const before = getComputedStyle(element, "::before");
        const after = getComputedStyle(element, "::after");
        return {
          tag: element.tagName,
          id: element.id || null,
          className: String(element.className || "").slice(0, 200),
          backgroundImage: style.backgroundImage,
          beforeBackgroundImage: before.backgroundImage,
          afterBackgroundImage: after.backgroundImage,
          rect: rect.toJSON(),
        };
      })
      .filter((item) => item.rect.width > 20 && item.rect.height > 20
        && item.rect.bottom >= minTop - 300 && item.rect.top <= maxBottom + 100
        && [item.backgroundImage, item.beforeBackgroundImage, item.afterBackgroundImage].some((value) => value && value !== "none"))
      .slice(0, 50);
    const captchaRoot = buttonElements[0].closest("form")
      || buttonElements[0].closest("table")
      || buttonElements[0].parentElement;
    const visualElements = [...(captchaRoot || document).querySelectorAll("img, picture, source, canvas, svg, object, embed, iframe, [style]")]
      .slice(0, 200)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          id: element.id || null,
          className: String(element.className || "").slice(0, 200),
          name: element.getAttribute("name"),
          type: element.getAttribute("type"),
          src: element.getAttribute("src"),
          currentSrc: element.currentSrc || null,
          data: element.getAttribute("data"),
          alt: element.getAttribute("alt"),
          title: element.getAttribute("title"),
          inlineStyle: element.getAttribute("style"),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          color: style.color,
          background: style.background,
          backgroundImage: style.backgroundImage,
          rect: rect.toJSON(),
        };
      });
    const resourceUrls = performance.getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((url) => /(?:captcha|showup|\.png|\.jpe?g|\.gif|\.webp|\.svg)(?:[?#]|$)/i.test(url))
      .slice(-200);
    rects.push(...nearbyImages);
    const padding = 50;
    const left = Math.min(...rects.map((rect) => rect.left));
    const top = Math.min(...rects.map((rect) => rect.top));
    const right = Math.max(...rects.map((rect) => rect.right));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const clip = {
      x: Math.max(0, left + window.scrollX - padding),
      y: Math.max(0, top + window.scrollY - padding),
      width: Math.min(document.documentElement.scrollWidth, Math.max(700, right - left + padding * 2)),
      height: Math.min(
        document.documentElement.scrollHeight - Math.max(0, top + window.scrollY - padding),
        Math.max(1200, bottom - top + padding * 2),
      ),
    };
    return {
      clip,
      scrollHeight: document.documentElement.scrollHeight,
      scrollWidth: document.documentElement.scrollWidth,
      messageRect: rects[0].toJSON(),
      buttonRects: rects.slice(1, 1 + buttonElements.length).map((rect) => rect.toJSON()),
      nearbyImageRects: nearbyImages.map((rect) => rect.toJSON()),
      backgrounds,
      captchaOuterHtml: String(captchaRoot?.outerHTML || "").slice(0, 100000),
      visualElements,
      resourceUrls,
    };
  });
  await buttons.first().scrollIntoViewIfNeeded();
  let sourceImage = null;
  if (imageLoaded) {
    try {
      await captchaImage.screenshot({ path: sourceImagePath });
      const dimensions = await captchaImage.evaluate((image) => ({
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }));
      sourceImage = {
        url: new URL(captchaImageUrl, page.url()).href,
        ...dimensions,
        path: sourceImagePath,
      };
    } catch (error) {
      sourceImage = { error: String(error?.message || error).split("Call log:")[0].trim() };
    }
  } else {
    sourceImage = { error: "验证码图片在50秒内未完成加载" };
  }
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.screenshot({ path: fullScreenshotPath, fullPage: true });
  await fs.writeFile(challengePath, JSON.stringify({ createdAt: new Date().toISOString(), screenshotPath, fullScreenshotPath, sourceImage, options, geometry }, null, 2));
  console.log(JSON.stringify({ status: "waiting_for_answer", screenshotPath, options }));

  const deadline = challengeStartedAt + 110000;
  let answer = null;
  while (Date.now() < deadline) {
    try {
      answer = JSON.parse(await fs.readFile(answerPath, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!answer?.name) throw new Error("等待 U2 验证码答案超时");
  const chosen = options.find((option) => option.name === answer.name);
  if (!chosen) throw new Error("U2 验证码答案不属于当前题目");

  await page.locator('textarea[name="message"]').fill("今日天气不错");
  await page.locator(`input[type="submit"][name="${chosen.name}"]`).click();
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  const bodyText = String(await page.locator("body").innerText()).replace(/\s+/g, " ").trim();
  const success = /(回答正確|回答正确|簽到成功|签到成功|獎勵UCoin|奖励UCoin|今日已簽到|今天已签到)/i.test(bodyText);
  console.log(JSON.stringify({ status: success ? "signed" : "unknown", chosen: chosen.text, url: page.url(), excerpt: bodyText.slice(0, 1500) }));
  if (!success) process.exitCode = 2;
} finally {
  await fs.rm(answerPath, { force: true }).catch(() => {});
  await fs.rm(challengePath, { force: true }).catch(() => {});
  await fs.rm(screenshotPath, { force: true }).catch(() => {});
  await fs.rm(fullScreenshotPath, { force: true }).catch(() => {});
  await fs.rm(sourceImagePath, { force: true }).catch(() => {});
  await context.close();
}
