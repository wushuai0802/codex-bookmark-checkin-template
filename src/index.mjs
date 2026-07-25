import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readBookmarkPlan, publicBookmarkReport } from "./bookmarks.mjs";
import { configuredTargetSkip, launchAutomationContext, processTarget } from "./browser.mjs";
import { cleanupOldLogs, createRunLog, writeRunResult } from "./logger.mjs";
import { atomicWriteJson, ensurePrivateDirectory } from "./security.mjs";
import { acquireRunLock, releaseRunLock } from "./run-lock.mjs";
import {
  applyPreferredCandidates,
  loadSiteState,
  runWithRecentNotAvailableCache,
  updateSiteState,
  writeSiteState,
} from "./site-state.mjs";
import { loadQaCache, updateQaCache, writeQaCache } from "./qa-solver.mjs";
import { selectPreflightOrigins } from "./preflight-policy.mjs";
import {
  TERMINAL_STATUSES,
  advanceAttemptedDeferredRetries,
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  isRetryEligible,
  nextDeferredRetryAt,
  resumeSelectedOrigins,
} from "./retry-policy.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.dirname(sourceDirectory);
const execFileAsync = promisify(execFile);
const config = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "config.json"), "utf8"));
const qaConfig = JSON.parse(await fs.readFile(path.join(rootDirectory, "config", "qa-rules.json"), "utf8"));
const localQaConfig = await fs.readFile(path.join(rootDirectory, "config", "qa-rules.local.json"), "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return { rules: [] };
    throw error;
  });
const dryRun = process.argv.includes("--dry-run");
const printPreflightOrigins = process.argv.includes("--preflight-origins");
const ignoreNativePreflight = process.argv.includes("--ignore-native-preflight");
const limitIndex = process.argv.indexOf("--limit");
const offsetIndex = process.argv.indexOf("--offset");
const originsIndex = process.argv.indexOf("--origins");
const resumeIndex = process.argv.indexOf("--resume-report");
const limit = limitIndex >= 0 ? Math.max(1, Number.parseInt(process.argv[limitIndex + 1], 10) || 1) : null;
const offset = offsetIndex >= 0 ? Math.max(0, Number.parseInt(process.argv[offsetIndex + 1], 10) || 0) : 0;
let selectedOrigins = originsIndex >= 0
  ? new Set(String(process.argv[originsIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const requestedResumePath = resumeIndex >= 0 ? String(process.argv[resumeIndex + 1] ?? "").trim() : null;
const lockPath = path.join(rootDirectory, "tmp", "run.lock");
const nativeWafPreflightPath = path.join(rootDirectory, "tmp", "native-waf-preflight.json");
const lastValidBookmarkPlanPath = path.join(rootDirectory, "data", "last-valid-bookmark-plan.json");
function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function validateBookmarkPlan(plan) {
  const minimumTargets = Math.max(1, Number(config.minimumBookmarkTargetCount) || 1);
  let lastValid = null;
  try { lastValid = JSON.parse(await fs.readFile(lastValidBookmarkPlanPath, "utf8")); } catch { /* first run */ }
  const previousCount = Number(lastValid?.targetCount) || 0;
  const suddenDrop = previousCount >= minimumTargets && plan.targetCount < Math.ceil(previousCount * 0.5);
  if (plan.targetCount < minimumTargets || suddenDrop) {
    throw new Error(`书签目标异常：当前 ${plan.targetCount} 个，上次 ${previousCount || "无记录"} 个；拒绝生成空签到结果`);
  }
  await atomicWriteJson(lastValidBookmarkPlanPath, publicBookmarkReport(plan));
}

async function readValidatedBookmarkPlan() {
  const candidates = [config.bookmarksPath, `${config.bookmarksPath}.bak`];
  const failures = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidatePath = candidates[index];
    try {
      const plan = await readBookmarkPlan(candidatePath, config);
      await validateBookmarkPlan(plan);
      return { ...plan, recoveredFromBackup: index > 0 };
    } catch (error) {
      failures.push(`${path.basename(candidatePath)}：${error.message}`);
    }
  }
  throw new Error(`无法读取有效签到书签：${failures.join("；")}`);
}

async function readFreshNativeWafPreflight() {
  if (ignoreNativePreflight) return new Map();
  const configuredUrls = [
    ...(config.nativeWafPreflightUrls ?? []).map((value) => typeof value === "string" ? value : value?.url),
    ...(config.nativeChallengePreflight ?? []).map((value) => value?.url),
  ].filter(Boolean);
  const allowedOrigins = new Set(configuredUrls.map((value) => new URL(value).origin));
  const report = await fs.readFile(nativeWafPreflightPath, "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const generatedAt = Date.parse(report?.generatedAt ?? "");
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > 10 * 60 * 1000) return new Map();
  return new Map((report?.results ?? [])
    .filter((result) => allowedOrigins.has(result?.origin) && result?.status === "signed")
    .map((result) => [result.origin, result]));
}

const lockLease = await acquireRunLock(lockPath);
try {
  const plan = await readValidatedBookmarkPlan();
  const report = publicBookmarkReport(plan);
  const reportPath = path.join(rootDirectory, "outputs", "bookmark-comparison.json");
  await atomicWriteJson(reportPath, report);

  if (printPreflightOrigins) {
    console.log(JSON.stringify(selectPreflightOrigins(plan, config)));
  } else if (dryRun) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const profileMarker = path.join(config.automationUserDataDir, "Local State");
    await fs.access(profileMarker).catch(() => {
      throw new Error("独立登录会话尚未初始化，请先运行 scripts/Initialize-BrowserProfile.ps1");
    });

    const logsRoot = path.join(rootDirectory, "logs");
    const siteStatePath = path.join(rootDirectory, "data", "site-state.json");
    const qaCachePath = path.join(rootDirectory, "data", "qa-cache.json");
    await ensurePrivateDirectory(logsRoot);
    let resumeBase = null;
    if (requestedResumePath) {
      const resolvedResume = path.resolve(requestedResumePath);
      const resolvedLogs = path.resolve(logsRoot);
      if (!resolvedResume.startsWith(`${resolvedLogs}${path.sep}`)) throw new Error("续跑报告必须位于本任务 logs 目录内");
      resumeBase = JSON.parse(await fs.readFile(resolvedResume, "utf8"));
      if (!Array.isArray(resumeBase?.results)) throw new Error("续跑报告缺少站点结果");
      if (!isCurrentLocalRunId(resumeBase.runId)) throw new Error("续跑报告不是今天生成的，拒绝复用旧签到结果");
      if (!selectedOrigins) {
        selectedOrigins = resumeSelectedOrigins(plan.targets, resumeBase.results, config);
      }
    }
    await cleanupOldLogs(logsRoot, config.logRetentionDays);
    const runLog = await createRunLog(logsRoot);
    const startedAt = new Date();
    const siteState = await loadSiteState(siteStatePath);
    const qaCache = await loadQaCache(qaCachePath);
    const qaRules = [
      ...(qaConfig.rules ?? []),
      ...(localQaConfig.rules ?? []),
      ...qaCache.entries.map((entry) => ({ ...entry, source: "verified_cache" })),
    ];
    const results = [];
    const nativeWafPreflight = await readFreshNativeWafPreflight();
    const preferredTargets = applyPreferredCandidates(plan.targets, siteState);
    const originFilteredTargets = selectedOrigins
      ? preferredTargets.filter((target) => selectedOrigins.has(target.origin))
      : preferredTargets;
    const selectedTargets = limit
      ? originFilteredTargets.slice(offset, offset + limit)
      : originFilteredTargets.slice(offset);
    const plannedTotal = preferredTargets.length;
    const logicalCompletions = new Map();

    const mergedProgressResults = () => {
      if (!resumeBase) return [...results];
      const currentByOrigin = new Map(results.map((result) => [result.origin, result]));
      const previousByOrigin = new Map(resumeBase.results.map((result) => [result.origin, result]));
      return preferredTargets
        .map((target) => currentByOrigin.get(target.origin) ?? previousByOrigin.get(target.origin))
        .filter(Boolean);
    };

    const writeProgress = async (phase, details = {}) => {
      const progressResults = mergedProgressResults();
      await atomicWriteJson(path.join(runLog.directory, "progress.json"), {
        runId: runLog.runId,
        runState: "in_progress",
        isComplete: false,
        phase,
        plannedTotal,
        processedTotal: progressResults.length,
        completed: progressResults.length,
        total: plannedTotal,
        updatedAt: new Date().toISOString(),
        ...details,
        results: progressResults,
      });
    };

    await writeProgress("initial");
    const context = selectedTargets.some((target) => !configuredTargetSkip(target, config))
      ? await launchAutomationContext(config)
      : null;

    const rememberLogicalCompletion = (target, result) => {
      const group = config.logicalCheckinGroups?.[target.origin];
      if (group && ["signed", "already_signed"].includes(result.status)) {
        logicalCompletions.set(group, { origin: target.origin, result });
      }
    };

    const runOneTarget = async (activeContext, target, allowReuse = true) => {
      const started = Date.now();
      const group = config.logicalCheckinGroups?.[target.origin];
      const reused = allowReuse && group ? logicalCompletions.get(group) : null;
      if (reused && reused.origin !== target.origin) {
        return {
          status: "already_signed",
          reason: `共用签到入口已由 ${new URL(reused.origin).hostname} 完成`,
          url: reused.result.url,
          attempt: 0,
          reusedFrom: reused.origin,
          durationMs: Date.now() - started,
        };
      }
      const result = await runWithRecentNotAvailableCache(target, siteState, config, async () => {
        const preflight = nativeWafPreflight.get(target.origin);
        return preflight
          ? { status: "signed", reason: preflight.reason, url: preflight.url, attempt: 1, nativePreflight: true }
          : processTarget(activeContext, target, config, qaRules, runLog.directory);
      });
      const timed = { ...result, durationMs: Date.now() - started };
      rememberLogicalCompletion(target, timed);
      return timed;
    };

    try {
      for (let index = 0; index < selectedTargets.length; index += 1) {
        const target = selectedTargets[index];
        console.log(`[${index + 1}/${selectedTargets.length}] ${target.origin}`);
        const targetResult = await runOneTarget(context, target);
        results.push({
          origin: target.origin,
          title: target.title,
          folderNames: target.folderNames,
          ...targetResult,
        });
        await writeProgress("checkin");
      }
    } finally {
      await context?.close();
    }

    // Only unresolved sites enter recovery.  Login repair is attempted before
    // each isolated round, and reporting remains deferred until all rounds end.
    const recoveryRounds = Math.max(1, Math.min(3, Number(config.recoveryRounds) || 2));
    const recoveryDelays = Array.isArray(config.recoveryDelaysMs) ? config.recoveryDelaysMs : [5000, 30000];
    for (let round = 0; round < recoveryRounds; round += 1) {
      const recoveryIndexes = results
        .map((result, index) => isRetryEligible(result) ? index : -1)
        .filter((index) => index >= 0);
      if (recoveryIndexes.length === 0) break;
      console.log(`[recovery ${round + 1}/${recoveryRounds}] 将复查 ${recoveryIndexes.length} 个异常站点`);
      const loginOutcomes = new Map();
      for (const resultIndex of recoveryIndexes) {
        const current = results[resultIndex];
        if (current.status !== "login_required") continue;
        const target = selectedTargets[resultIndex];
        const provider = config.automaticOAuthProviders?.[current.origin];
        const methods = [];
        if ((config.protectedCredentialOrigins ?? []).includes(current.origin)) {
          methods.push({
            method: "protected_credential",
            executable: config.powershellExecutable || "pwsh.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-ProtectedLogin.ps1"), "-Origin", current.origin, "-LoginUrl", current.url ?? `${current.origin}/login`],
          });
        }
        if (provider) methods.push({ method: "oauth", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, provider] });
        else if (config.autoDetectLinuxDoOAuth !== false
          && (config.autoDetectOAuthOrigins ?? []).includes(current.origin)) {
          methods.push({ method: "oauth_autodetect", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, "LinuxDO"] });
        }
        methods.push({
          method: "saved_password",
          executable: process.execPath,
          args: [path.join(sourceDirectory, "saved-password-login.mjs"), current.origin, current.url ?? ""],
        });
        methods.push({
          method: "native_saved_password",
          executable: config.powershellExecutable || "pwsh.exe",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-NativeLogin.ps1"), "-Origin", current.origin, "-LoginUrl", current.url ?? `${current.origin}/login`],
        });

        const attempts = [];
        let succeeded = false;
        for (const method of methods) {
          try {
            await execFileAsync(method.executable, method.args, {
              cwd: rootDirectory,
              windowsHide: true,
              timeout: 180000,
              maxBuffer: 1024 * 1024,
            });
            attempts.push({ method: method.method, succeeded: true });
            succeeded = true;
            break;
          } catch {
            attempts.push({ method: method.method, succeeded: false });
          }
        }
        loginOutcomes.set(current.origin, { attempted: true, succeeded, attempts });
      }

      const delayMs = Math.max(0, Number(recoveryDelays[Math.min(round, recoveryDelays.length - 1)]) || 0);
      if (delayMs > 0) await wait(delayMs);
      const recoveryContext = await launchAutomationContext(config);
      try {
        for (let recoveryIndex = 0; recoveryIndex < recoveryIndexes.length; recoveryIndex += 1) {
          const resultIndex = recoveryIndexes[recoveryIndex];
          const target = selectedTargets[resultIndex];
          const initialResult = results[resultIndex];
          console.log(`[recovery ${round + 1}.${recoveryIndex + 1}/${recoveryIndexes.length}] ${target.origin}`);
          const recoveredResult = await runOneTarget(recoveryContext, target);
          const priorHistory = initialResult.recovery?.history ?? [];
          results[resultIndex] = {
            origin: target.origin,
            title: target.title,
            folderNames: target.folderNames,
            ...recoveredResult,
            recovery: {
              attempted: true,
              initialStatus: initialResult.recovery?.initialStatus ?? initialResult.status,
              history: [...priorHistory, {
                round: round + 1,
                status: recoveredResult.status,
                login: loginOutcomes.get(target.origin) ?? { attempted: false },
              }],
            },
          };
          await writeProgress(`recovery_${round + 1}`, {
            recoveryCompleted: recoveryIndex + 1,
            recoveryTotal: recoveryIndexes.length,
          });
        }
      } finally {
        await recoveryContext.close();
      }
    }

    const finishedAt = new Date();
    const assembledResults = resumeBase
      ? preferredTargets.map((target) => results.find((result) => result.origin === target.origin)
        ?? resumeBase.results.find((result) => result.origin === target.origin)
        ?? { origin: target.origin, title: target.title, folderNames: target.folderNames, status: "error", reason: "续跑未生成站点结果" })
      : results;
    const currentOrigins = new Set(results.map((result) => result.origin));
    const finalResults = advanceAttemptedDeferredRetries(
      assembledResults.map((result) => currentOrigins.has(result.origin) ? deferUnresolvedLogin(result, config, finishedAt) : result),
      currentOrigins,
      resumeBase?.results,
      config,
      finishedAt,
    );
    const summary = Object.fromEntries(
      [...new Set(finalResults.map((result) => result.status))].map((status) => [status, finalResults.filter((result) => result.status === status).length])
    );
    const processedTotal = finalResults.length;
    const isComplete = processedTotal === plannedTotal;
    const output = {
      runId: runLog.runId,
      runState: "final",
      plannedTotal,
      processedTotal,
      isComplete,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      bookmarkSummary: report,
      summary,
      nextRetryAt: nextDeferredRetryAt(finalResults, finishedAt),
      results: finalResults,
    };
    const minimumTargets = Math.max(1, Number(config.minimumBookmarkTargetCount) || 1);
    const resultPath = await writeRunResult(logsRoot, runLog, output, {
      updateLatest: isComplete && finalResults.length >= minimumTargets,
    });
    await writeSiteState(siteStatePath, updateSiteState(siteState, results, finishedAt));
    await writeQaCache(qaCachePath, updateQaCache(qaCache, results, finishedAt));
    await fs.rm(nativeWafPreflightPath, { force: true }).catch(() => {});
    console.log(JSON.stringify({ resultPath, summary }, null, 2));
    if (!isComplete || finalResults.some((result) => !TERMINAL_STATUSES.has(result.status))) {
      process.exitCode = 2;
    }
  }
} finally {
  await releaseRunLock(lockLease).catch(() => {});
}
