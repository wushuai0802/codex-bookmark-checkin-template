const TERMINAL_STATUSES = new Set(['signed', 'already_signed']);

/**
 * Shadow schedule gate. It answers whether a task would be eligible, but alpha
 * never grants a lease or returns an executable decision.
 */
export function evaluateShadowGate({ snapshot, taskId, now = new Date().toISOString(), requestedMode = 'shadow_read_only', minHealthFresh = true } = {}) {
  const task = (snapshot?.tasks ?? []).find((candidate) => candidate.taskId === taskId);
  const reasons = [];
  if (!task) reasons.push('task_not_in_snapshot');
  if (requestedMode !== 'shadow_read_only') reasons.push('alpha_execution_disabled');
  if (snapshot?.mode !== 'shadow_read_only') reasons.push('snapshot_mode_not_shadow');
  if (minHealthFresh && snapshot?.health?.freshness?.fresh !== true) reasons.push('health_stale');
  if (task && TERMINAL_STATUSES.has(task.observedStatus)) reasons.push('legacy_result_terminal');
  return {
    schemaVersion: 1,
    taskId: taskId ?? null,
    evaluatedAt: new Date(now).toISOString(),
    decision: reasons.length === 0 ? 'observe' : 'deny',
    executable: false,
    leaseGranted: false,
    reasons,
    executionOwner: task?.executionOwner ?? null
  };
}
