import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { publicBookmarkReport, readBookmarkPlanWithBackup } from "./bookmarks.mjs";
import { configuredTargetSkip, launchAutomationContext, processTarget } from "./browser.mjs";
import { cleanupOldLogs, createRunLog, writeRunResult } from "./logger.mjs";
import {
  authoritativeNativeOAuthDailyCheckin,
  loginHelperOutcome,
  resolveLoginRecoveryUrl,
} from "./login-recovery.mjs";
import { applyLogicalCompletionReuse, collectLogicalCompletions, logicalCompletionKey } from "./logical-checkin.mjs";
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
import { accountMetadataForOrigin, compatiblePriorResult, resultIdentity } from "./result-identity.mjs";
import { configuredSupplementalOAuthAccounts, runSupplementalOAuthAccount } from "./supplemental-oauth-accounts.mjs";
import {
  TERMINAL_STATUSES,
  advanceAttemptedDeferredRetries,
  applyManualConfirmations,
  deferUnresolvedLogin,
  isCurrentLocalRunId,
  isRetryEligible,
  nextDeferredRetryAt,
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
const accountKeysIndex = process.argv.indexOf("--account-keys");
const resumeIndex = process.argv.indexOf("--resume-report");
const manualConfirmedIndex = process.argv.indexOf("--manual-confirmed-origins");
const limit = limitIndex >= 0 ? Math.max(1, Number.parseInt(process.argv[limitIndex + 1], 10) || 1) : null;
const offset = offsetIndex >= 0 ? Math.max(0, Number.parseInt(process.argv[offsetIndex + 1], 10) || 0) : 0;
let selectedOrigins = originsIndex >= 0
  ? new Set(String(process.argv[originsIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const selectedAccountKeys = accountKeysIndex >= 0
  ? new Set(String(process.argv[accountKeysIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const requestedResumePath = resumeIndex >= 0 ? String(process.argv[resumeIndex + 1] ?? "").trim() : null;
const manualConfirmedOrigins = new Set(manualConfirmedIndex >= 0
  ? String(process.argv[manualConfirmedIndex + 1] ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  : []);
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
  const plan = await readBookmarkPlanWithBackup(config.bookmarksPath, config);
  await validateBookmarkPlan(plan);
  return plan;
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
  const supplementalAccounts = configuredSupplementalOAuthAccounts(config, rootDirectory);
  const baseReport = publicBookmarkReport(plan);
  const reportTargets = [
    ...baseReport.targets.map((target) => ({ ...target, ...accountMetadataForOrigin(target.origin, config) })),
    ...supplementalAccounts.map((account) => ({
      origin: account.origin,
      title: account.title,
      candidateCount: 1,
      folderNames: ["supplemental-oauth"],
      accountKey: account.accountKey,
      accountId: account.accountId,
      accountLabel: account.accountLabel,
      supplementalAccount: true,
    })),
  ];
  const reportIdentities = reportTargets.map(resultIdentity);
  if (new Set(reportIdentities).size !== reportIdentities.length) {
    throw new Error("OAuth 多账号配置与书签主账号身份重复");
  }
  const report = {
    ...baseReport,
    targetCount: baseReport.targetCount + supplementalAccounts.length,
    targets: reportTargets,
  };
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
    let manualConfirmedResults = [];
    if (manualConfirmedOrigins.size > 0 && !requestedResumePath) {
      throw new Error("人工完成确认必须配合今天的续跑报告使用");
    }
    if (requestedResumePath) {
      const resolvedResume = path.resolve(requestedResumePath);
      const resolvedLogs = path.resolve(logsRoot);
      if (!resolvedResume.startsWith(`${resolvedLogs}${path.sep}`)) throw new Error("续跑报告必须位于本任务 logs 目录内");
      resumeBase = JSON.parse(await fs.readFile(resolvedResume, "utf8"));
      if (!Array.isArray(resumeBase?.results)) throw new Error("续跑报告缺少站点结果");
      if (!isCurrentLocalRunId(resumeBase.runId)) throw new Error("续跑报告不是今天生成的，拒绝复用旧签到结果");
      const currentTargetOrigins = new Set(plan.targets.map((target) => target.origin));
      const previousOrigins = new Set(resumeBase.results.map((result) => result.origin));
      for (const origin of manualConfirmedOrigins) {
        if (!currentTargetOrigins.has(origin) || !previousOrigins.has(origin)) {
          throw new Error(`人工完成确认不属于当前续跑范围：${origin}`);
        }
        if (resumeBase.results.filter((result) => result.origin === origin).length !== 1) {
          throw new Error(`人工完成确认对应多个账号，必须保留各账号的权威签到证据：${origin}`);
        }
      }
      resumeBase = {
        ...resumeBase,
        results: applyManualConfirmations(resumeBase.results, manualConfirmedOrigins),
      };
      manualConfirmedResults = resumeBase.results.filter((result) => manualConfirmedOrigins.has(result.origin)
        && result.manualConfirmation === true);
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
    const preferredTargets = applyPreferredCandidates(plan.targets, siteState)
      .map((target) => ({ ...target, ...accountMetadataForOrigin(target.origin, config) }));
    const plannedTargets = [...preferredTargets, ...supplementalAccounts];
    if (selectedAccountKeys) {
      const configuredAccountKeys = new Set(plannedTargets.map((target) => String(target.accountKey || "").trim()).filter(Boolean));
      for (const accountKey of selectedAccountKeys) {
        if (!configuredAccountKeys.has(accountKey)) throw new Error(`定向续跑账号不存在：${accountKey}`);
      }
    }
    const explicitSelection = Boolean(selectedOrigins || selectedAccountKeys);
    const resumeTargets = resumeBase && !explicitSelection
      ? plannedTargets.filter((target) => {
        const prior = compatiblePriorResult(target, resumeBase.results);
        return !prior
          || isRetryEligible(prior)
          || (config.disabledCheckinOrigins ?? []).includes(target.origin);
      })
      : plannedTargets;
    const originFilteredTargets = selectedOrigins
      ? resumeTargets.filter((target) => selectedOrigins.has(target.origin))
      : resumeTargets;
    const accountFilteredTargets = selectedAccountKeys
      ? originFilteredTargets.filter((target) => selectedAccountKeys.has(String(target.accountKey || "").trim()))
      : originFilteredTargets;
    const selectedPlanTargets = limit
      ? accountFilteredTargets.slice(offset, offset + limit)
      : accountFilteredTargets.slice(offset);
    const selectedIdentities = new Set(selectedPlanTargets.map(resultIdentity));
    const selectedTargets = preferredTargets.filter((target) => selectedIdentities.has(resultIdentity(target)));
    const selectedSupplementalAccounts = supplementalAccounts
      .filter((account) => selectedIdentities.has(resultIdentity(account)));
    const plannedTotal = plannedTargets.length;
    const priorLogicalResults = resumeBase
      ? preferredTargets.map((target) => compatiblePriorResult(target, resumeBase.results)).filter(Boolean)
      : [];
    const logicalCompletions = collectLogicalCompletions(priorLogicalResults, config.logicalCheckinGroups);

    const mergedProgressResults = () => {
      if (!resumeBase) return [...results];
      const currentByIdentity = new Map(results.map((result) => [resultIdentity(result), result]));
      return plannedTargets
        .map((target) => currentByIdentity.get(resultIdentity(target))
          ?? compatiblePriorResult(target, resumeBase.results))
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
      const key = logicalCompletionKey({ ...target, ...result }, config.logicalCheckinGroups);
      if (key && ["signed", "already_signed"].includes(result.status)) {
        logicalCompletions.set(key, { origin: target.origin, result });
      }
    };

    const runOneTarget = async (activeContext, target, allowReuse = true) => {
      const started = Date.now();
      const key = logicalCompletionKey(target, config.logicalCheckinGroups);
      const reused = allowReuse && key ? logicalCompletions.get(key) : null;
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
        const prior = compatiblePriorResult(target, resumeBase?.results ?? []);
        const targetResult = explicitSelection && prior && TERMINAL_STATUSES.has(prior.status)
          ? prior
          : await runOneTarget(context, target);
        results.push({
          origin: target.origin,
          title: target.title,
          folderNames: target.folderNames,
          ...accountMetadataForOrigin(target.origin, config),
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
        const nativeOAuth = provider && config.oauthReloginCheckinRules?.[current.origin]?.nativeBrowser === true;
        const savedLoginUrl = resolveLoginRecoveryUrl(
          current.origin,
          config.savedLoginUrls?.[current.origin],
          current.url,
        );
        const methods = [];
        if ((config.protectedCredentialOrigins ?? []).includes(current.origin)) {
          methods.push({
            method: "protected_credential",
            executable: config.powershellExecutable || "pwsh.exe",
            args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-ProtectedLogin.ps1"), "-Origin", current.origin, "-LoginUrl", savedLoginUrl],
          });
        }
        if (nativeOAuth) {
          const accountIdentity = config.oauthAccountIdentities?.[current.origin] ?? {};
          const expectedAccountId = String(
            accountIdentity.accountId ?? config.oauthExpectedAccountIds?.[current.origin] ?? "",
          ).trim();
          const accountKey = String(accountIdentity.accountKey ?? current.accountKey ?? "").trim();
          const accountLabel = String(accountIdentity.accountLabel ?? current.accountLabel ?? expectedAccountId).trim();
          const upstreamProvider = String(config.oauthUpstreamProviders?.[current.origin] ?? "").trim();
          methods.push({
            method: "native_oauth",
            executable: config.powershellExecutable || "pwsh.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
              path.join(rootDirectory, "scripts", "Recover-NativeOAuthLogin.ps1"),
              "-Origin", current.origin,
              "-Provider", provider,
              "-LoginUrl", config.oauthLoginUrls?.[current.origin] ?? `${current.origin}/login`,
              ...(expectedAccountId ? ["-ExpectedAccountId", expectedAccountId] : []),
              ...(accountKey ? ["-AccountKey", accountKey] : []),
              ...(accountLabel ? ["-AccountLabel", accountLabel] : []),
              ...(upstreamProvider ? ["-UpstreamProvider", upstreamProvider] : []),
            ],
          });
        } else if (provider) {
          methods.push({ method: "oauth", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, provider] });
        }
        else if (config.autoDetectLinuxDoOAuth !== false
          && (config.autoDetectOAuthOrigins ?? []).includes(current.origin)) {
          methods.push({ method: "oauth_autodetect", executable: process.execPath, args: [path.join(sourceDirectory, "oauth-login.mjs"), current.origin, "LinuxDO"] });
        }
        methods.push({
          method: "saved_password",
          executable: process.execPath,
          args: [path.join(sourceDirectory, "saved-password-login.mjs"), current.origin, savedLoginUrl],
        });
        methods.push({
          method: "native_saved_password",
          executable: config.powershellExecutable || "pwsh.exe",
          args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDirectory, "scripts", "Recover-NativeLogin.ps1"), "-Origin", current.origin, "-LoginUrl", savedLoginUrl],
        });

        const attempts = [];
        let succeeded = false;
        let authoritativeDailyCheckin = null;
        for (const method of methods) {
          try {
            const helperOutput = await execFileAsync(method.executable, method.args, {
              cwd: rootDirectory,
              windowsHide: true,
              timeout: 180000,
              maxBuffer: 1024 * 1024,
            });
            const outcome = loginHelperOutcome(helperOutput.stdout);
            attempts.push({ method: method.method, ...outcome });
            if (outcome.succeeded) {
              authoritativeDailyCheckin = authoritativeNativeOAuthDailyCheckin(method.method, outcome);
              succeeded = true;
              break;
            }
          } catch (error) {
            const fallback = error?.code === "ETIMEDOUT" ? "timeout" : "failed";
            const outcome = loginHelperOutcome(`${error?.stdout ?? ""}\n${error?.stderr ?? ""}`, fallback);
            const failedOutcome = outcome.status === "logged_in" ? loginHelperOutcome("", fallback) : outcome;
            attempts.push({
              method: method.method,
              ...failedOutcome,
              succeeded: false,
            });
          }
        }
        loginOutcomes.set(current.origin, {
          attempted: true,
          succeeded,
          attempts,
          ...(authoritativeDailyCheckin ? { authoritativeDailyCheckin } : {}),
        });
      }

      const delayMs = Math.max(0, Number(recoveryDelays[Math.min(round, recoveryDelays.length - 1)]) || 0);
      if (delayMs > 0) await wait(delayMs);
      let recoveryContext = null;
      try {
        for (let recoveryIndex = 0; recoveryIndex < recoveryIndexes.length; recoveryIndex += 1) {
          const resultIndex = recoveryIndexes[recoveryIndex];
          const target = selectedTargets[resultIndex];
          const initialResult = results[resultIndex];
          console.log(`[recovery ${round + 1}.${recoveryIndex + 1}/${recoveryIndexes.length}] ${target.origin}`);
          const loginRecovery = loginOutcomes.get(target.origin);
          const helperDailyCheckin = initialResult.status === "login_required"
            ? loginRecovery?.authoritativeDailyCheckin
            : null;
          let recoveredResult;
          if (["signed", "already_signed"].includes(helperDailyCheckin?.status)) {
            recoveredResult = helperDailyCheckin;
          } else {
            recoveryContext ??= await launchAutomationContext(config);
            recoveredResult = await runOneTarget(recoveryContext, target);
          }
          const priorHistory = initialResult.recovery?.history ?? [];
          results[resultIndex] = {
            origin: target.origin,
            title: target.title,
            folderNames: target.folderNames,
            ...accountMetadataForOrigin(target.origin, config),
            ...recoveredResult,
            recovery: {
              attempted: true,
              initialStatus: initialResult.recovery?.initialStatus ?? initialResult.status,
              history: [...priorHistory, {
                round: round + 1,
                status: recoveredResult.status,
                login: loginRecovery ?? { attempted: false },
              }],
            },
          };
          await writeProgress(`recovery_${round + 1}`, {
            recoveryCompleted: recoveryIndex + 1,
            recoveryTotal: recoveryIndexes.length,
          });
        }
      } finally {
        await recoveryContext?.close();
      }
    }

    for (let accountIndex = 0; accountIndex < selectedSupplementalAccounts.length; accountIndex += 1) {
      const account = selectedSupplementalAccounts[accountIndex];
      const prior = compatiblePriorResult(account, resumeBase?.results ?? []);
      // An explicit origin selection is a deliberate operator retry. Do not
      // let a previous deferred cooldown hide that account from the run, but
      // never replace authoritative same-day success with a flaky browser
      // startup result from another account on the same origin.
      const shouldReuse = prior && (TERMINAL_STATUSES.has(prior.status)
        || (!explicitSelection && !isRetryEligible(prior)));
      if (!shouldReuse) {
        results.push(await runSupplementalOAuthAccount(account, config, rootDirectory));
      }
      await writeProgress("supplemental_oauth", {
        supplementalCompleted: accountIndex + 1,
        supplementalTotal: selectedSupplementalAccounts.length,
      });
    }

    const finishedAt = new Date();
    const currentByIdentity = new Map(results.map((result) => [resultIdentity(result), result]));
    const assembledResults = resumeBase
      ? plannedTargets.map((target) => currentByIdentity.get(resultIdentity(target))
        ?? compatiblePriorResult(target, resumeBase.results)
        ?? { ...target, status: "error", reason: "续跑未生成站点结果" })
      : results;
    const currentOrigins = new Set([...results, ...manualConfirmedResults].map(resultIdentity));
    const logicallyResolvedResults = applyLogicalCompletionReuse(assembledResults, config.logicalCheckinGroups);
    const finalResults = advanceAttemptedDeferredRetries(
      logicallyResolvedResults.map((result) => currentOrigins.has(resultIdentity(result)) ? deferUnresolvedLogin(result, config, finishedAt) : result),
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
    const primaryResults = [...results, ...manualConfirmedResults]
      .filter((result) => result.supplementalAccount !== true);
    await writeSiteState(siteStatePath, updateSiteState(siteState, primaryResults, finishedAt));
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
