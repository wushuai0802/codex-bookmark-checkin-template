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

function resolveBookmarkSources(bookmarksPath, options = {}) {
  const configured = Array.isArray(bookmarksPath)
    ? bookmarksPath
    : [
      {
        name: String(options.bookmarkSourceName ?? "").trim(),
        path: bookmarksPath,
        optional: false,
      },
      ...(options.additionalBookmarkSources ?? []),
    ];
  const sources = [];
  const seen = new Set();

  for (let index = 0; index < configured.length; index += 1) {
    const value = configured[index];
    const source = typeof value === "string" ? { path: value } : value;
    const sourcePath = String(source?.path ?? "").trim();
    if (!sourcePath) throw new Error(`第 ${index + 1} 个书签来源缺少 path`);
    const key = sourcePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      name: String(source?.name ?? "").trim(),
      path: sourcePath,
      optional: source?.optional === true,
      mobileFolderNames: Array.isArray(source?.mobileFolderNames)
        ? source.mobileFolderNames.map((name) => String(name).trim()).filter(Boolean)
        : null,
      targetFolderNames: Array.isArray(source?.targetFolderNames)
        ? source.targetFolderNames.map((name) => String(name).trim()).filter(Boolean)
        : null,
      recoveredFromBackup: source?.recoveredFromBackup === true,
      originalPath: String(source?.originalPath ?? sourcePath),
    });
  }

  if (sources.length === 0) throw new Error("至少需要一个书签来源");
  return sources;
}

function sourceLabel(source) {
  return source.name || "默认浏览器";
}

async function readBookmarkDocuments(bookmarksPath, options) {
  const sources = resolveBookmarkSources(bookmarksPath, options);
  const documents = [];
  const warnings = [];

  for (const source of sources) {
    try {
      documents.push({ source, raw: JSON.parse(await fs.readFile(source.path, "utf8")) });
    } catch (error) {
      const diagnostic = `${sourceLabel(source)}：${error.message}`;
      if (!source.optional) throw new Error(`无法读取书签来源（${diagnostic}）`);
      warnings.push(diagnostic);
    }
  }

  if (documents.length === 0) throw new Error("没有可读取的书签来源");
  return { documents, warnings };
}

async function bookmarkSourceCandidateGroups(bookmarksPath, options) {
  const sources = resolveBookmarkSources(bookmarksPath, options);
  const groups = [];
  const warnings = [];

  for (const source of sources) {
    const candidates = [
      { ...source, recoveredFromBackup: false, originalPath: source.originalPath },
      { ...source, path: `${source.originalPath}.bak`, recoveredFromBackup: true, originalPath: source.originalPath },
    ];
    const available = [];
    const failures = [];
    for (const candidate of candidates) {
      try {
        JSON.parse(await fs.readFile(candidate.path, "utf8"));
        available.push(candidate);
      } catch (error) {
        failures.push(`${candidate.recoveredFromBackup ? "备份" : "主文件"}：${error.message}`);
      }
    }
    if (available.length > 0) {
      groups.push(available);
    } else {
      const diagnostic = `${sourceLabel(source)}（${failures.join("；")}）`;
      if (!source.optional) throw new Error(`无法读取必要书签来源：${diagnostic}`);
      warnings.push(diagnostic);
    }
  }

  if (groups.length === 0) throw new Error("没有可读取的书签来源或备份");
  return { groups, warnings };
}

function sourceCombinations(groups) {
  let combinations = [[]];
  for (const group of groups) {
    combinations = combinations.flatMap((existing) => group.map((source) => [...existing, source]));
  }
  return combinations.sort((left, right) => {
    const leftBackups = left.filter((source) => source.recoveredFromBackup).length;
    const rightBackups = right.filter((source) => source.recoveredFromBackup).length;
    return leftBackups - rightBackups;
  });
}

export async function readBookmarkPlan(bookmarksPath, options = {}) {
  const mobileNames = new Set(options.mobileFolderNames ?? []);
  const targetNames = new Set(options.targetFolderNames ?? []);
  if (mobileNames.size === 0 || targetNames.size === 0) {
    throw new Error("必须先明确配置上级书签文件夹和目标子文件夹名称");
  }
  const { documents, warnings: sourceWarnings } = await readBookmarkDocuments(bookmarksPath, options);
  const allTargetNames = new Set(targetNames);
  const mobileFolders = [];

  for (const document of documents) {
    const documentMobileNames = new Set(document.source.mobileFolderNames?.length
      ? document.source.mobileFolderNames
      : mobileNames);
    const documentTargetNames = new Set(document.source.targetFolderNames?.length
      ? document.source.targetFolderNames
      : targetNames);
    for (const targetName of documentTargetNames) allTargetNames.add(targetName);
    for (const root of Object.values(document.raw.roots ?? {})) {
      walkFolders(root, [], (folder, folderPath) => {
        if (documentMobileNames.has(nodeName(folder))) {
          mobileFolders.push({
            folder,
            path: folderPath.join(" / "),
            id: String(folder.id ?? ""),
            bookmarkSource: document.source,
            targetNames: documentTargetNames,
          });
        }
      });
    }
  }

  const sources = [];
  const allEntries = [];
  for (const mobile of mobileFolders) {
    const bookmarkSourceName = mobile.bookmarkSource.name;
    const sourceId = bookmarkSourceName ? `${bookmarkSourceName}:${mobile.id}` : mobile.id;
    const sourcePath = bookmarkSourceName ? `${bookmarkSourceName}: ${mobile.path}` : mobile.path;
    const sections = {};
    for (const child of mobile.folder.children ?? []) {
      const sectionName = nodeName(child);
      if (!mobile.targetNames.has(sectionName) || !isFolder(child)) continue;
      const entries = collectUrls(child)
        .map((entry) => ({ ...entry, normalizedUrl: normalizeHttpUrl(entry.url) }))
        .filter((entry) => entry.normalizedUrl)
        .map((entry) => ({
          ...entry,
          folderName: sectionName,
          sourceId,
          sourcePath,
        }));
      sections[sectionName] = entries;
      allEntries.push(...entries);
    }
    sources.push({
      id: sourceId,
      path: sourcePath,
      bookmarkSourceName,
      bookmarkPath: mobile.bookmarkSource.path,
      sections,
    });
  }

  const configuredSections = {};
  for (const configured of options.configuredTargets ?? []) {
    const folderName = String(configured?.folderName ?? "").trim();
    const rawUrl = String(configured?.url ?? "").trim();
    let parsed;
    try { parsed = new URL(rawUrl); } catch { parsed = null; }
    if (!allTargetNames.has(folderName)) throw new Error(`显式站点目录无效：${folderName || "<empty>"}`);
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
    sources.push({
      id: "configured",
      path: "显式站点配置",
      bookmarkSourceName: "显式配置",
      sections: configuredSections,
    });
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
  for (const targetName of allTargetNames) {
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
    bookmarkFiles: documents.map(({ source }) => ({
      name: source.name,
      path: source.path,
      recoveredFromBackup: source.recoveredFromBackup,
    })),
    sourceWarnings,
    sources,
    comparison,
    exactUrlCount: exactMap.size,
    targetCount: targets.length,
    targets,
  };
}

export async function findBookmarkTarget(bookmarksPath, requestedOrigin, options = {}) {
  const origin = new URL(requestedOrigin).origin;
  const { groups, warnings } = await bookmarkSourceCandidateGroups(bookmarksPath, options);
  const combinations = sourceCombinations(groups);
  const failures = [];

  for (const combination of combinations) {
    try {
      const plan = await readBookmarkPlan(combination, options);
      const target = plan.targets.find((item) => item.origin === origin);
      if (target) {
        const recoveredSources = combination.filter((source) => source.recoveredFromBackup).map(sourceLabel);
        return {
          plan: {
            ...plan,
            recoveredFromBackup: recoveredSources.length > 0,
            recoveredSources,
            sourceWarnings: [...warnings, ...(plan.sourceWarnings ?? [])],
          },
          target,
          bookmarkPath: combination[0].path,
          bookmarkPaths: combination.map((source) => source.path),
          recoveredFromBackup: recoveredSources.length > 0,
        };
      }
      failures.push(`${combination.map((source) => source.recoveredFromBackup ? `${sourceLabel(source)} 备份` : sourceLabel(source)).join(" + ")} 中没有目标站点`);
    } catch (error) {
      failures.push(error.message);
    }
  }

  throw new Error(`目标不在签到书签范围内（${failures.join("；")}）`);
}

export async function readBookmarkPlanWithBackup(bookmarksPath, options = {}) {
  const { groups, warnings } = await bookmarkSourceCandidateGroups(bookmarksPath, options);
  const combinations = sourceCombinations(groups);
  const failures = [];
  const minimumTargets = Math.max(1, Number(options.minimumBookmarkTargetCount) || 1);
  for (const combination of combinations) {
    try {
      const plan = await readBookmarkPlan(combination, options);
      const recoveredSources = combination.filter((source) => source.recoveredFromBackup).map(sourceLabel);
      if (plan.targetCount >= minimumTargets) {
        return {
          ...plan,
          bookmarkPath: combination[0].path,
          bookmarkPaths: combination.map((source) => source.path),
          recoveredFromBackup: recoveredSources.length > 0,
          recoveredSources,
          sourceWarnings: [...warnings, ...(plan.sourceWarnings ?? [])],
        };
      }
      failures.push(`${combination.map(sourceLabel).join(" + ")} 中只有 ${plan.targetCount} 个签到目标，低于最低 ${minimumTargets} 个`);
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`无法读取有效签到书签（${failures.join("；")}）`);
}

export function publicBookmarkReport(plan) {
  return {
    generatedAt: plan.generatedAt,
    recoveredFromBackup: Boolean(plan.recoveredFromBackup),
    recoveredSources: plan.recoveredSources ?? [],
    bookmarkSourceCount: plan.bookmarkFiles?.length ?? 1,
    bookmarkSources: (plan.bookmarkFiles ?? []).map((source) => ({
      name: source.name || "默认浏览器",
      recoveredFromBackup: Boolean(source.recoveredFromBackup),
    })),
    sourceWarnings: plan.sourceWarnings ?? [],
    sourceCount: plan.sources.length,
    sources: plan.sources.map((source) => ({
      bookmarkSourceName: source.bookmarkSourceName || "默认浏览器",
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
