const COMPLETED = new Set(["signed", "already_signed"]);

export function logicalCompletionKey(result, logicalGroups = {}) {
  const group = logicalGroups?.[result?.origin];
  if (!group) return null;
  const accountKey = String(result?.accountKey ?? "").trim();
  return accountKey ? `${group}#account=${accountKey}` : String(group);
}

export function collectLogicalCompletions(results, logicalGroups = {}) {
  const completions = new Map();
  for (const result of results ?? []) {
    const key = logicalCompletionKey(result, logicalGroups);
    if (key && COMPLETED.has(result?.status) && !completions.has(key)) {
      completions.set(key, { origin: result.origin, result });
    }
  }
  return completions;
}

export function applyLogicalCompletionReuse(results, logicalGroups = {}) {
  const completions = collectLogicalCompletions(results, logicalGroups);
  return (results ?? []).map((result) => {
    if (COMPLETED.has(result?.status)) return result;
    const reused = completions.get(logicalCompletionKey(result, logicalGroups));
    if (!reused || reused.origin === result?.origin) return result;
    const {
      retryCause: _retryCause,
      nextEligibleAt: _nextEligibleAt,
      retrySequence: _retrySequence,
      retrySequenceDate: _retrySequenceDate,
      retryExhaustedForDay: _retryExhaustedForDay,
      ...preserved
    } = result;
    return {
      ...preserved,
      status: "already_signed",
      reason: `共用签到入口已由 ${new URL(reused.origin).hostname} 完成`,
      url: reused.result.url ?? result.url,
      reusedFrom: reused.origin,
    };
  });
}
