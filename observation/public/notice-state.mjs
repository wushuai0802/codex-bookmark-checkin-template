// Presentation-only acknowledgement. Never changes task status or execution.
const STORAGE_KEY = 'fabricReadNotices.v1';
export const noticeKey = task => `${task.businessDate ?? ''}:${task.taskId}:${task.observedStatus}`;
const unresolved = task => !['signed', 'already_signed', 'not_available'].includes(task.observedStatus);
export const pausedNotices = (tasks, now = Date.now()) => tasks.filter(task => unresolved(task)
  && Number.isFinite(Date.parse(task.attention?.pausedUntil)) && Date.parse(task.attention.pausedUntil) > now);
export const pendingNotices = (tasks, now = Date.now()) => tasks.filter(task => unresolved(task)
  && !(Number.isFinite(Date.parse(task.attention?.pausedUntil)) && Date.parse(task.attention.pausedUntil) > now));
export function attentionPreview(tasks, limit = 4, now = Date.now()) {
  const priority = { needs_attention: 0, login_required: 1, failed: 2, deferred: 3 };
  const all = pendingNotices(tasks, now).sort((a, b) => (priority[a.observedStatus] ?? 4) - (priority[b.observedStatus] ?? 4));
  const grouped = new Map();
  for (const task of all) {
    const key = JSON.stringify([task.businessDate, task.origin, task.observedStatus, task.evidence?.summary]);
    const group = grouped.get(key) ?? { task, tasks: [], origin: task.origin };
    group.tasks.push(task);
    grouped.set(key, group);
  }
  const groups = [...grouped.values()];
  return { all, pausedCount: pausedNotices(tasks, now).length, visible: groups.slice(0, limit), remaining: groups.slice(limit).reduce((count, group) => count + group.tasks.length, 0) };
}

export function createNoticeState(getStorage = () => globalThis.localStorage) {
  let keys = new Set();
  try {
    const saved = JSON.parse(getStorage()?.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(saved)) keys = new Set(saved.filter(key => typeof key === 'string').slice(-2000));
  } catch { /* Blocked storage must not prevent the dashboard from starting. */ }
  return {
    isRead: task => keys.has(noticeKey(task)),
    markRead(tasks) {
      for (const task of tasks) keys.add(noticeKey(task));
      keys = new Set([...keys].slice(-2000));
      try { getStorage()?.setItem(STORAGE_KEY, JSON.stringify([...keys])); } catch { /* Session-only fallback. */ }
    }
  };
}
