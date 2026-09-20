const definitions = [
  { id:'readonly.new-api.v1', family:'标准 New API', sourceFamilies:['new-api-calendar.v1'], mode:'observe_only', mutations:[], statusEvidence:['当日签到日历','用户身份'], phase:'M3a', readyForCanary:false },
  { id:'readonly.reward-log.v1', family:'奖励日志', sourceFamilies:['oauth-reward-log.v1'], mode:'observe_only', mutations:[], statusEvidence:['当日奖励日志','用户身份'], phase:'M3a', readyForCanary:false },
  { id:'readonly.linuxdo-wheel.v1', family:'LinuxDO 轮盘', sourceFamilies:['oauth-status.v1'], mode:'observe_only', mutations:[], statusEvidence:['spin_date','LinuxDO ID'], phase:'M3a', readyForCanary:false },
  { id:'readonly.vibe-entitlement.v1', family:'权益领取站', sourceFamilies:['generic-discovery.v1'], mode:'observe_only', mutations:[], statusEvidence:['getme','有效权益'], phase:'M3a', readyForCanary:false },
  { id:'pt-native-readonly.v1', family:'PT 原生浏览器只读', sourceFamilies:['native-pt.v1'], mode:'observe_only', mutations:[], statusEvidence:['站点页面/API','当日账号'], phase:'M3b', readyForCanary:false },
  { id:'anyrouter-route.v1', family:'AnyRouter 动态线路', sourceFamilies:[], mode:'observe_only', mutations:[], statusEvidence:['TLS/SNI','self','奖励日志'], phase:'M3b', readyForCanary:false }
];
export function adapterDefinitions() { return definitions.map(definition => ({ ...definition, sourceFamilies:[...(definition.sourceFamilies??[])], mutations:[...definition.mutations], statusEvidence:[...definition.statusEvidence] })); }
export function evaluateAdapterCoverage(observations = {}, tasks = []) {
  const observed = new Set((observations?.results ?? []).map(result => result.adapter).filter(Boolean));
  const families = adapterDefinitions().map(definition => ({ ...definition, observed:observed.has(definition.id) }));
  const blocked = families.filter(definition => !definition.observed || !definition.readyForCanary).map(definition => ({ id:definition.id, reason:definition.observed ? 'canary_disabled' : 'not_observed' }));
  return { totalTasks:tasks.length, observedTasks:observations?.counts?.total ?? 0, confirmedTasks:observations?.counts?.confirmed ?? 0, families, blocked };
}
export function migrationReadiness({snapshot, acceptance, adapterObservations} = {}) {
  const reconciliation = snapshot?.reconciliation ?? {}, quality = snapshot?.evidenceQuality ?? {}, blockers = [];
  if (snapshot?.mode !== 'shadow_read_only') blockers.push('snapshot_not_shadow');
  if (reconciliation.missingCount > 0) blockers.push('planned_results_missing');
  if (reconciliation.conflictCount > 0) blockers.push('identity_conflict');
  if (!acceptance?.accepted) blockers.push('shadow_acceptance_incomplete');
  if ((quality.unverifiedSuccess ?? 0) > 0) blockers.push('unverified_success_evidence');
  const coverage=evaluateAdapterCoverage(adapterObservations,snapshot?.tasks);
  if (coverage.blocked.length) blockers.push('adapter_coverage_incomplete');
  return { phase:blockers.length?'shadow_preparation':'canary_review', executionEnabled:false, blockers, coverage,
    gates:{shadowDays:acceptance?.eligibleRecentDays??0,requiredShadowDays:acceptance?.requiredConsecutiveDays??7,
      reconciliationClear:!reconciliation.missingCount&&!reconciliation.conflictCount, evidenceClear:!quality.unverifiedSuccess,
      adapterCoverageClear:coverage.blocked.length===0} };
}
