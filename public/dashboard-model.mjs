export function identityTitle(item) {
  const identity = item.identity ?? {};
  return identity.username || identity.label || (identity.userId ? `ID ${identity.userId}` : '默认账号（身份待采集）');
}

export function identityCaption(item) {
  const identity = item.identity ?? {};
  if (!identity.userId) return '用户 ID 尚未采集';
  const label = identity.idKind === 'linuxdo' ? 'LinuxDO ID' : '用户 ID';
  const note = identity.source === 'browser-cache' ? '（登录缓存，待在线核验）' : identity.source === 'configuration' ? '（配置值）' : '';
  return `${label}：${identity.userId}${note}`;
}

export function siteTitle(item) {
  try { return item.displayName || new URL(item.origin).hostname; }
  catch { return item.displayName || item.origin || '未知站点'; }
}

export function matchesTask(task, { status = '', query = '' } = {}) {
  const value = task.observedStatus;
  const statusMatch = status === 'success' ? ['signed', 'already_signed'].includes(value)
    : status === 'pending' ? !['signed', 'already_signed', 'not_available'].includes(value)
    : !status || value === status;
  const haystack = [task.origin, task.displayName, task.logicalSiteKey, task.accountRef, task.taskId,
    task.identity?.username, task.identity?.userId, task.identity?.label].join(' ').toLowerCase();
  return statusMatch && haystack.includes(query.trim().toLowerCase());
}

export function matchesPt(site, scope = '') {
  return !scope || (scope === 'monitor' && !site.inLegacyPlan) || (scope === 'plan' && site.inLegacyPlan)
    || (scope === 'fresh' && site.effective?.fresh) || (scope === 'review' && site.supplementCandidate);
}
