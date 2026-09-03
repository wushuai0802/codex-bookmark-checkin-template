import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { launchAutomationContext } from "./browser.mjs";
import { isTerminalResult } from "./result-contract.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const plan = await readBookmarkPlanWithBackup(config.bookmarksPath, config);
const latest = await fs.readFile(path.join(rootDirectory, "logs", "latest.json"), "utf8")
  .then(JSON.parse)
  .catch(() => ({ results: plan?.targets?.map((target) => ({ origin: target.origin, status: "login_required" })) ?? [] }));
const signalPath = path.join(rootDirectory, "tmp", "close-manual-session.signal");
const statePath = path.join(rootDirectory, "tmp", "manual-session.json");

await fs.rm(signalPath, { force: true });
const visibleConfig = { ...config, headless: false, backgroundWindowMode: "visible" };
const context = await launchAutomationContext(visibleConfig);

const attentionOrigins = [...new Set(
  latest.results
    .filter((result) => !isTerminalResult(result))
    .map((result) => result.origin)
)];
const preferredFirst = config.attentionPreferredOrigins ?? [];
const orderedOrigins = [
  ...preferredFirst.filter((origin) => attentionOrigins.includes(origin)),
  ...attentionOrigins.filter((origin) => !preferredFirst.includes(origin)),
];
const targets = orderedOrigins.map((origin) => plan.targets.find((target) => target.origin === origin)).filter(Boolean);

const pages = context.pages();
for (let index = 0; index < targets.length; index += 1) {
  const target = targets[index];
  const page = index === 0 && pages[0] ? pages[0] : await context.newPage();
  await page.goto(target.candidates[0], { waitUntil: "commit", timeout: 15000 }).catch(() => {});
}
if (context.pages()[0]) await context.pages()[0].bringToFront();

await fs.writeFile(statePath, JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  profile: config.automationUserDataDir,
  origins: orderedOrigins,
}, null, 2), { encoding: "utf8", mode: 0o600 });

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await context.close().catch(() => {});
  await fs.rm(statePath, { force: true }).catch(() => {});
};
process.on("SIGINT", close);
process.on("SIGTERM", close);

while (!closing) {
  try {
    await fs.access(signalPath);
    await close();
    await fs.rm(signalPath, { force: true }).catch(() => {});
    break;
  } catch {
    if (context.pages().length === 0) {
      await close();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
