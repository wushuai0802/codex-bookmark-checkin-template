import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { listBookmarkFolderCandidates, listBookmarkFolderCandidatesWithBackup, readBookmarkPlanWithBackup } from "./bookmarks.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const defaults = JSON.parse(await fs.readFile(path.join(root, "config", "defaults.json"), "utf8"));
const scopeIndex = process.argv.indexOf("--scope-json");
const scopeBase64Index = process.argv.indexOf("--scope-json-base64");
const requestedScope = scopeBase64Index >= 0
  ? JSON.parse(Buffer.from(String(process.argv[scopeBase64Index + 1] ?? ""), "base64").toString("utf8"))
  : scopeIndex >= 0
    ? JSON.parse(String(process.argv[scopeIndex + 1] ?? "{}"))
    : null;
const scopeProvided = Array.isArray(requestedScope?.mobileFolderNames)
  && requestedScope.mobileFolderNames.length > 0
  && Array.isArray(requestedScope?.targetFolderNames)
  && requestedScope.targetFolderNames.length > 0;
const edgeScopeProvided = Array.isArray(requestedScope?.edgeMobileFolderNames)
  && requestedScope.edgeMobileFolderNames.length > 0
  && Array.isArray(requestedScope?.edgeTargetFolderNames)
  && requestedScope.edgeTargetFolderNames.length > 0;

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

function edgeCandidates() {
  const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
  return [...new Set(roots.map((base) => path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")))];
}

async function findChrome() {
  for (const candidate of chromeCandidates()) if (await exists(candidate)) return candidate;
  return null;
}

async function findEdge() {
  for (const candidate of edgeCandidates()) if (await exists(candidate)) return candidate;
  return null;
}

function profileBookmarkCandidates(userDataDir, profileName) {
  const profileRoot = path.join(userDataDir, profileName);
  return ["AccountBookmarks", "Bookmarks"].map((fileName) => path.join(profileRoot, fileName));
}

async function inspectProfiles(userDataDir, browserName, requestedBrowserScope = null) {
  if (!(await exists(userDataDir))) return [];
  const entries = await fs.readdir(userDataDir, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bookmarkFiles = [];
    for (const bookmarksPath of profileBookmarkCandidates(userDataDir, entry.name)) {
      if (!(await exists(bookmarksPath)) && !(await exists(`${bookmarksPath}.bak`))) continue;
      try {
        const plan = requestedBrowserScope
          ? await readBookmarkPlanWithBackup(bookmarksPath, {
            ...defaults,
            bookmarkSourceName: browserName,
            mobileFolderNames: requestedBrowserScope.mobileFolderNames,
            targetFolderNames: requestedBrowserScope.targetFolderNames,
          })
          : null;
        const folderReport = plan
          ? {
            candidates: await listBookmarkFolderCandidates(plan.bookmarkPath),
            recoveredFromBackup: plan.recoveredFromBackup,
          }
          : await listBookmarkFolderCandidatesWithBackup(bookmarksPath);
        bookmarkFiles.push({
          bookmarksPath,
          bookmarkFileName: path.basename(bookmarksPath),
          recoveredFromBackup: Boolean(folderReport.recoveredFromBackup || plan?.recoveredFromBackup),
          folderCandidates: folderReport.candidates,
          scopeMatch: plan ? {
            sourceCount: plan.sources.length,
            exactUrlCount: plan.exactUrlCount,
            targetCount: plan.targetCount,
          } : null,
        });
      } catch (error) {
        bookmarkFiles.push({
          bookmarksPath,
          bookmarkFileName: path.basename(bookmarksPath),
          error: String(error?.message ?? error),
        });
      }
    }
    if (bookmarkFiles.length === 0) continue;
    bookmarkFiles.sort((left, right) => {
      const targetDifference = (right.scopeMatch?.targetCount ?? -1) - (left.scopeMatch?.targetCount ?? -1);
      if (targetDifference !== 0) return targetDifference;
      return (right.folderCandidates?.length ?? 0) - (left.folderCandidates?.length ?? 0);
    });
    const selected = bookmarkFiles.find((value) => !value.error) ?? bookmarkFiles[0];
    profiles.push({
      browser: browserName,
      name: entry.name,
      ...selected,
      bookmarkFiles: bookmarkFiles.map((value) => ({
        bookmarkFileName: value.bookmarkFileName,
        bookmarksPath: value.bookmarksPath,
        error: value.error,
        targetCount: value.scopeMatch?.targetCount,
      })),
    });
  }
  return profiles.sort((left, right) => {
    const targetDifference = (right.scopeMatch?.targetCount ?? -1) - (left.scopeMatch?.targetCount ?? -1);
    if (targetDifference !== 0) return targetDifference;
    return (right.folderCandidates?.length ?? 0) - (left.folderCandidates?.length ?? 0);
  });
}

const userDataDir = path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "User Data");
const edgeUserDataDir = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "User Data");
const chromeExecutable = await findChrome();
const edgeExecutable = await findEdge();
const profiles = await inspectProfiles(userDataDir, "Chrome", scopeProvided ? {
  mobileFolderNames: requestedScope.mobileFolderNames,
  targetFolderNames: requestedScope.targetFolderNames,
} : null);
const edgeProfiles = await inspectProfiles(edgeUserDataDir, "Edge", edgeScopeProvided ? {
  mobileFolderNames: requestedScope.edgeMobileFolderNames,
  targetFolderNames: requestedScope.edgeTargetFolderNames,
} : null);
const matchingProfiles = scopeProvided
  ? profiles.filter((value) => (value.scopeMatch?.targetCount ?? 0) > 0)
  : [];
const matchingEdgeProfiles = edgeScopeProvided
  ? edgeProfiles.filter((value) => (value.scopeMatch?.targetCount ?? 0) > 0)
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
  edgePresent: Boolean(edgeExecutable),
  edgeUserDataPresent: await exists(edgeUserDataDir),
  readableEdgeBookmarkProfile: edgeProfiles.some((value) => !value.error),
  bookmarkScopeProvided: scopeProvided,
  edgeBookmarkScopeProvided: edgeScopeProvided,
  matchingBookmarkFolders: scopeProvided ? matchingProfiles.length > 0 : null,
  matchingEdgeBookmarkFolders: edgeScopeProvided ? matchingEdgeProfiles.length > 0 : null,
};
const blockingKeys = ["supportedWindows", "nodeSupported", "writableProject", "chromePresent", "readableBookmarkProfile"];
const environmentReady = blockingKeys.every((key) => checks[key]);
const ready = environmentReady
  && scopeProvided
  && checks.matchingBookmarkFolders
  && (!edgeScopeProvided || checks.matchingEdgeBookmarkFolders);

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  environmentReady,
  ready,
  platform: { os: os.release(), platform: process.platform, arch: process.arch, node: process.versions.node },
  paths: {
    root,
    chromeExecutable,
    chromeUserDataDir: userDataDir,
    edgeExecutable,
    edgeUserDataDir,
  },
  requestedScope: scopeProvided ? requestedScope : null,
  checks,
  profiles,
  edgeProfiles,
  guidance: {
    blocking: blockingKeys.filter((key) => !checks[key]),
    needsUserInput: [
      ...(!scopeProvided ? ["bookmarkScope"] : checks.matchingBookmarkFolders ? [] : ["bookmarkScopeMismatch"]),
      ...(edgeScopeProvided && !checks.matchingEdgeBookmarkFolders ? ["edgeBookmarkScopeMismatch"] : []),
    ],
  },
}, null, 2));
