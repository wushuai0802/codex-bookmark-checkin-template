import fs from "node:fs/promises";

function nodeName(node) {
  return String(node?.name ?? node?.title ?? "").trim();
}

function isFolder(node) {
  return node?.type === "folder" || Array.isArray(node?.children);
}

function walkFolders(node, path, visitor) {
  if (!node || !isFolder(node)) return;
  const name = nodeName(node);
  const currentPath = name ? [...path, name] : path;
  visitor(node, currentPath);
  for (const child of node.children ?? []) {
    walkFolders(child, currentPath, visitor);
  }
}

function collectUrls(node, result = []) {
  for (const child of node?.children ?? []) {
    if (child?.type === "url" && typeof child.url === "string") {
      result.push({ title: nodeName(child), url: child.url });
    } else if (isFolder(child)) {
      collectUrls(child, result);
    }
  }
  return result;
}

export async function listBookmarkFolderCandidates(bookmarksPath) {
  const raw = JSON.parse(await fs.readFile(bookmarksPath, "utf8"));
  const candidates = [];
  for (const root of Object.values(raw.roots ?? {})) {
    walkFolders(root, [], (folder, folderPath) => {
      const childFolders = (folder.children ?? [])
        .filter(isFolder)
        .map((child) => ({
          name: nodeName(child),
          urlCount: collectUrls(child, []).length,
        }))
        .filter((child) => child.name);
      const descendantUrlCount = collectUrls(folder, []).length;
      if (descendantUrlCount === 0 && childFolders.length === 0) return;
      candidates.push({
        name: nodeName(folder),
        path: folderPath.join(" / "),
        descendantUrlCount,
        childFolders,
      });
    });
  }
  return candidates
    .sort((left, right) => right.descendantUrlCount - left.descendantUrlCount || left.path.localeCompare(right.path))
    .slice(0, 100);
}

export function normalizeHttpUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return null;
  }
}

function candidateScore(rawUrl) {
  const value = rawUrl.toLowerCase();
  if (/(attendance|check[-_]?in|showup|bakatest|daily[-_]?sign)/.test(value)) return 500;
  if (/dashboard\/overview/.test(value)) return 180;
  if (/console\/token/.test(value)) return 160;
  if (/\/console/.test(value)) return 140;
  if (/\/profile/.test(value)) return 120;
  return 0;
}

export async function readBookmarkPlan(bookmarksPath, options = {}) {
  const mobileNames = new Set(options.mobileFolderNames ?? ["移动设备书签"]);
  const targetNames = new Set(options.targetFolderNames ?? ["签到", "公益站"]);
  const raw = JSON.parse(await fs.readFile(bookmarksPath, "utf8"));
  const roots = Object.values(raw.roots ?? {});
  const mobileFolders = [];

  for (const root of roots) {
    walkFolders(root, [], (folder, path) => {
      if (mobileNames.has(nodeName(folder))) {
        mobileFolders.push({ folder, path: path.join(" / "), id: String(folder.id ?? "") });
      }
    });
  }

  const sources = [];
  const allEntries = [];
  for (const mobile of mobileFolders) {
    const sections = {};
    for (const child of mobile.folder.children ?? []) {
      const sectionName = nodeName(child);
      if (!targetNames.has(sectionName) || !isFolder(child)) continue;
      const entries = collectUrls(child)
        .map((entry) => ({ ...entry, normalizedUrl: normalizeHttpUrl(entry.url) }))
        .filter((entry) => entry.normalizedUrl)
        .map((entry) => ({
          ...entry,
          folderName: sectionName,
          sourceId: mobile.id,
          sourcePath: mobile.path,
        }));
      sections[sectionName] = entries;
      allEntries.push(...entries);
    }
    sources.push({ id: mobile.id, path: mobile.path, sections });
  }

  const exactMap = new Map();
  for (const entry of allEntries) {
    const existing = exactMap.get(entry.normalizedUrl);
    if (existing) {
      existing.sourcePaths.add(entry.sourcePath);
      existing.folderNames.add(entry.folderName);
      if (!existing.title && entry.title) existing.title = entry.title;
    } else {
      exactMap.set(entry.normalizedUrl, {
        title: entry.title,
        url: entry.normalizedUrl,
        sourcePaths: new Set([entry.sourcePath]),
        folderNames: new Set([entry.folderName]),
      });
    }
  }

  const targetMap = new Map();
  for (const entry of exactMap.values()) {
    const parsed = new URL(entry.url);
    const key = parsed.origin;
    const target = targetMap.get(key) ?? {
      key,
      origin: parsed.origin,
      title: entry.title,
      candidates: [],
      folderNames: new Set(),
      sourcePaths: new Set(),
    };
    target.candidates.push(entry.url);
    for (const name of entry.folderNames) target.folderNames.add(name);
    for (const path of entry.sourcePaths) target.sourcePaths.add(path);
    targetMap.set(key, target);
  }

  const targets = [...targetMap.values()].map((target) => ({
    ...target,
    candidates: [...new Set([
      ...target.candidates,
      ...((options.relatedCandidateUrls ?? {})[target.origin] ?? [])
        .map(normalizeHttpUrl)
        .filter(Boolean),
    ])].sort((a, b) => candidateScore(b) - candidateScore(a)),
    allowedOrigins: [...new Set([
      target.origin,
      ...((options.relatedCandidateUrls ?? {})[target.origin] ?? [])
        .map(normalizeHttpUrl)
        .filter(Boolean)
        .map((url) => new URL(url).origin),
    ])],
    folderNames: [...target.folderNames].sort(),
    sourcePaths: [...target.sourcePaths].sort(),
  })).sort((a, b) => a.origin.localeCompare(b.origin));

  const comparison = {};
  for (const targetName of targetNames) {
    const rows = sources.map((source) => ({
      sourcePath: source.path,
      count: source.sections[targetName]?.length ?? 0,
    }));
    comparison[targetName] = {
      sources: rows,
      unionUrlCount: [...exactMap.values()].filter((entry) => entry.folderNames.has(targetName)).length,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    sources,
    comparison,
    exactUrlCount: exactMap.size,
    targetCount: targets.length,
    targets,
  };
}

export function publicBookmarkReport(plan) {
  return {
    generatedAt: plan.generatedAt,
    sourceCount: plan.sources.length,
    sources: plan.sources.map((source) => ({
      path: source.path,
      counts: Object.fromEntries(Object.entries(source.sections).map(([name, entries]) => [name, entries.length])),
    })),
    comparison: plan.comparison,
    exactUrlCount: plan.exactUrlCount,
    targetCount: plan.targetCount,
    targets: plan.targets.map((target) => ({
      origin: target.origin,
      title: target.title,
      candidateCount: target.candidates.length,
      folderNames: target.folderNames,
    })),
  };
}
