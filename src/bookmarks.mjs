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

export async function listBookmarkFolderCandidatesWithBackup(bookmarksPath) {
  const failures = [];
  for (let index = 0; index < 2; index += 1) {
    const candidatePath = index === 0 ? bookmarksPath : `${bookmarksPath}.bak`;
    try {
      const candidates = await listBookmarkFolderCandidates(candidatePath);
      if (candidates.length > 0) {
        return { candidates, bookmarkPath: candidatePath, recoveredFromBackup: index > 0 };
      }
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"} 中没有可选目录`);
    } catch (error) {
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"}：${error.message}`);
    }
  }
  throw new Error(`无法列出有效书签目录（${failures.join("；")}）`);
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
  const mobileNames = new Set(options.mobileFolderNames ?? []);
  const targetNames = new Set(options.targetFolderNames ?? []);
  if (mobileNames.size === 0 || targetNames.size === 0) {
    throw new Error("必须先明确配置上级书签文件夹和目标子文件夹名称");
  }
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

  const configuredSections = {};
  for (const configured of options.configuredTargets ?? []) {
    const folderName = String(configured?.folderName ?? "").trim();
    const rawUrl = String(configured?.url ?? "").trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch { parsed = null; }
    if (!targetNames.has(folderName)) throw new Error(`显式站点目录无效：${folderName || "<empty>"}`);
    if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`显式站点地址必须使用无凭据 HTTPS：${rawUrl}`);
    }
    const normalizedUrl = normalizeHttpUrl(rawUrl);
    const entry = {
      title: String(configured?.title ?? "").trim() || parsed.hostname,
      url: normalizedUrl,
      normalizedUrl,
      folderName,
      sourceId: "configured",
      sourcePath: "显式站点配置",
    };
    configuredSections[folderName] ??= [];
    configuredSections[folderName].push(entry);
    allEntries.push(entry);
  }
  if (Object.keys(configuredSections).length > 0) {
    sources.push({ id: "configured", path: "显式站点配置", sections: configuredSections });
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

export async function findBookmarkTarget(bookmarksPath, requestedOrigin, options = {}) {
  const origin = new URL(requestedOrigin).origin;
  const candidates = [bookmarksPath, `${bookmarksPath}.bak`];
  const failures = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const candidatePath = candidates[index];
    try {
      const plan = await readBookmarkPlan(candidatePath, options);
      const target = plan.targets.find((item) => item.origin === origin);
      if (target) {
        return {
          plan: { ...plan, recoveredFromBackup: index > 0 },
          target,
          bookmarkPath: candidatePath,
          recoveredFromBackup: index > 0,
        };
      }
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"} 中没有目标站点`);
    } catch (error) {
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"}：${error.message}`);
    }
  }

  throw new Error(`目标不在签到书签范围内（${failures.join("；")}）`);
}

export async function readBookmarkPlanWithBackup(bookmarksPath, options = {}) {
  const candidates = [bookmarksPath, `${bookmarksPath}.bak`];
  const failures = [];
  const minimumTargets = Math.max(1, Number(options.minimumBookmarkTargetCount) || 1);
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const plan = await readBookmarkPlan(candidates[index], options);
      if (plan.targetCount >= minimumTargets) {
        return { ...plan, bookmarkPath: candidates[index], recoveredFromBackup: index > 0 };
      }
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"} 中只有 ${plan.targetCount} 个签到目标，低于最低 ${minimumTargets} 个`);
    } catch (error) {
      failures.push(`${index > 0 ? "Bookmarks.bak" : "Bookmarks"}：${error.message}`);
    }
  }
  throw new Error(`无法读取有效签到书签（${failures.join("；")}）`);
}

export function publicBookmarkReport(plan) {
  return {
    generatedAt: plan.generatedAt,
    recoveredFromBackup: Boolean(plan.recoveredFromBackup),
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
