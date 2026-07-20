import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listBookmarkFolderCandidates, readBookmarkPlan } from "./bookmarks.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(await fs.readFile(path.join(root, "config", "defaults.json"), "utf8"));
const scopeIndex = process.argv.indexOf("--scope-json");
const requestedScope = scopeIndex >= 0 ? JSON.parse(String(process.argv[scopeIndex + 1] ?? "{}")) : null;
const scopeProvided = Array.isArray(requestedScope?.mobileFolderNames)
  && requestedScope.mobileFolderNames.length > 0
  && Array.isArray(requestedScope?.targetFolderNames)
  && requestedScope.targetFolderNames.length > 0;

async function exists(value) {
  return Boolean(value) && fs.access(value).then(() => true).catch(() => false);
}

function chromeCandidates() {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  return [...new Set(roots.flatMap((base) => [
    path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(base, "Chromium", "Application", "chrome.exe"),
  ]))];
}

async function findChrome() {
  for (const candidate of chromeCandidates()) if (await exists(candidate)) return candidate;
  return null;
}

async function inspectProfiles(userDataDir) {
  if (!(await exists(userDataDir))) return [];
  const entries = await fs.readdir(userDataDir, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bookmarksPath = path.join(userDataDir, entry.name, "Bookmarks");
    if (!(await exists(bookmarksPath))) continue;
    try {
      const folderCandidates = await listBookmarkFolderCandidates(bookmarksPath);
      const plan = scopeProvided
        ? await readBookmarkPlan(bookmarksPath, {
          ...defaults,
          mobileFolderNames: requestedScope.mobileFolderNames,
          targetFolderNames: requestedScope.targetFolderNames,
        })
        : null;
      profiles.push({
        name: entry.name,
        bookmarksPath,
        folderCandidates,
        scopeMatch: plan ? {
          sourceCount: plan.sources.length,
          exactUrlCount: plan.exactUrlCount,
          targetCount: plan.targetCount,
        } : null,
      });
    } catch (error) {
      profiles.push({ name: entry.name, bookmarksPath, error: String(error?.message ?? error) });
    }
  }
  return profiles.sort((left, right) => {
    const targetDifference = (right.scopeMatch?.targetCount ?? -1) - (left.scopeMatch?.targetCount ?? -1);
    if (targetDifference !== 0) return targetDifference;
    return (right.folderCandidates?.length ?? 0) - (left.folderCandidates?.length ?? 0);
  });
}

const userDataDir = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
const chromeExecutable = await findChrome();
const profiles = await inspectProfiles(userDataDir);
const matchingProfiles = scopeProvided
  ? profiles.filter((value) => (value.scopeMatch?.targetCount ?? 0) > 0)
  : [];
const majorNodeVersion = Number(process.versions.node.split(".")[0]);
const checks = {
  supportedWindows: process.platform === "win32",
  supportedArchitecture: process.arch === "x64" || process.arch === "arm64",
  nodeSupported: majorNodeVersion >= 20,
  writableProject: await fs.access(root, fs.constants.W_OK).then(() => true).catch(() => false),
  chromePresent: Boolean(chromeExecutable),
  chromeUserDataPresent: await exists(userDataDir),
  readableBookmarkProfile: profiles.some((value) => !value.error),
  bookmarkScopeProvided: scopeProvided,
  matchingBookmarkFolders: scopeProvided ? matchingProfiles.length > 0 : null,
};
const blockingKeys = ["supportedWindows", "nodeSupported", "writableProject", "chromePresent", "readableBookmarkProfile"];
const environmentReady = blockingKeys.every((key) => checks[key]);
const ready = environmentReady && scopeProvided && checks.matchingBookmarkFolders;

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  environmentReady,
  ready,
  platform: { os: os.release(), platform: process.platform, arch: process.arch, node: process.versions.node },
  paths: { root, chromeExecutable, chromeUserDataDir: userDataDir },
  requestedScope: scopeProvided ? requestedScope : null,
  checks,
  profiles,
  guidance: {
    blocking: blockingKeys.filter((key) => !checks[key]),
    needsUserInput: !scopeProvided
      ? ["bookmarkScope"]
      : checks.matchingBookmarkFolders ? [] : ["bookmarkScopeMismatch"],
  },
}, null, 2));
