import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { atomicWriteJson, ensurePrivateDirectory } from "./security.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function deepMerge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return override === undefined ? base : override;
  const output = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) output[key] = deepMerge(output[key], value);
  return output;
}

async function readJson(filePath, fallback = null) {
  return fs.readFile(filePath, "utf8").then(JSON.parse).catch((error) => {
    if (error.code === "ENOENT") return fallback;
    throw error;
  });
}

async function exists(filePath) {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function findOnPath(executableName) {
  const pathValue = process.env.Path ?? process.env.PATH ?? "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, executableName);
    if (await exists(candidate)) return path.resolve(candidate);
  }
  return null;
}

async function findChrome() {
  const configured = process.env.CHROME_EXECUTABLE;
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = [configured, ...roots.flatMap((base) => [
    path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(base, "Chromium", "Application", "chrome.exe"),
  ])].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return path.resolve(candidate);
  throw new Error("未找到 Chrome，可先运行环境预检并由用户决定是否安装");
}

async function discoverProfiles(userDataDir, options) {
  const entries = await fs.readdir(userDataDir, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bookmarksPath = path.join(userDataDir, entry.name, "Bookmarks");
    if (!(await exists(bookmarksPath))) continue;
    const plan = await readBookmarkPlanWithBackup(bookmarksPath, options).catch(() => null);
    if (plan) profiles.push({ name: entry.name, bookmarksPath, targetCount: plan.targetCount, sourceCount: plan.sources.length });
  }
  return profiles.sort((a, b) => b.targetCount - a.targetCount);
}

const answersIndex = process.argv.indexOf("--answers");
const answersPath = answersIndex >= 0 ? path.resolve(process.argv[answersIndex + 1]) : path.join(root, "setup", "answers.json");
const defaults = await readJson(path.join(root, "config", "defaults.json"));
const answers = await readJson(answersPath);
if (!answers) throw new Error(`未找到问卷答案：${answersPath}`);
if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(answers.schedule ?? defaults.schedule))) throw new Error("schedule 必须为 HH:mm");
for (const [field, value] of [["mobileFolderNames", answers.mobileFolderNames], ["targetFolderNames", answers.targetFolderNames]]) {
  if (!Array.isArray(value) || value.length === 0 || value.some((name) => !String(name).trim())) {
    throw new Error(`${field} 必须由用户提前确认，并至少包含一个非空文件夹名称`);
  }
}

const publicRules = answers.useBuiltInSiteRules === false
  ? {}
  : await readJson(path.join(root, "config", "site-rules.public.json"), {});
const localRules = await readJson(path.join(root, "config", "config.local.json"), {});
let config = deepMerge(deepMerge(deepMerge(defaults, publicRules), {
  mobileFolderNames: answers.mobileFolderNames,
  targetFolderNames: answers.targetFolderNames,
  schedule: answers.schedule,
  autoDetectLinuxDoOAuth: answers.autoDetectLinuxDoOAuth,
  syncBookmarkSavedLogins: answers.syncChromeSavedLogins,
  qaWebSearchEnabled: answers.qaWebSearchEnabled,
  checkinMessage: answers.checkinMessage,
  u2Message: answers.checkinMessage,
  notification: answers.notification,
}), localRules);

const sourceUserDataDir = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
// Explicit local targets are independent of the Chrome profile and must not
// make an otherwise empty profile win automatic profile selection.
const profiles = await discoverProfiles(sourceUserDataDir, { ...config, configuredTargets: [] });
if (profiles.length === 0) throw new Error("没有找到可读取的 Chrome 书签配置文件");
let selected;
if (answers.chromeProfile && answers.chromeProfile !== "Auto") {
  selected = profiles.find((profile) => profile.name.toLowerCase() === String(answers.chromeProfile).toLowerCase());
  if (!selected) throw new Error(`Chrome 配置文件不存在：${answers.chromeProfile}`);
} else {
  const bestCount = profiles[0].targetCount;
  const tied = profiles.filter((profile) => profile.targetCount === bestCount);
  if (tied.length > 1) throw new Error(`Auto 找到多个同优先级配置：${tied.map((value) => value.name).join(", ")}，请明确选择`);
  selected = profiles[0];
}
if (selected.targetCount === 0) throw new Error("所选 Chrome 配置中没有找到目标书签目录，请检查目录名称后重试");

const windowsPowerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const preferredPowerShell = await findOnPath("pwsh.exe")
  ?? (await exists(windowsPowerShell) ? windowsPowerShell : "pwsh.exe");
config = deepMerge(config, {
  bookmarksPath: selected.bookmarksPath,
  sourceUserDataDir,
  sourceProfileDirectory: selected.name,
  automationUserDataDir: path.join(root, "data", "chrome-user-data"),
  chromeExecutable: await findChrome(),
  nodeExecutable: process.execPath,
  pythonExecutable: answers.pythonExecutable ?? "",
  powershellExecutable: answers.powershellExecutable || preferredPowerShell,
  schedulerTaskName: "CodexBookmarkDailyCheckin",
  schedulerRunKeyName: "CodexBookmarkDailyCheckin",
});

for (const directory of ["data", "logs", "tmp", "outputs"]) await ensurePrivateDirectory(path.join(root, directory));
await atomicWriteJson(path.join(root, "config", "config.json"), config);
console.log(JSON.stringify({
  configured: true,
  profile: selected.name,
  bookmarkSources: selected.sourceCount,
  targets: selected.targetCount,
  schedule: config.schedule,
  builtInRules: answers.useBuiltInSiteRules !== false,
  notificationMode: config.notification?.mode ?? "none",
}, null, 2));
