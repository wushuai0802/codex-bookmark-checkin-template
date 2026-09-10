// Presentation-only acknowledgement. Never changes task status or execution.
const STORAGE_KEY = 'fabricReadNotices.v1';
export const noticeKey = task => `${task.businessDate ?? ''}:${task.taskId}:${task.observedStatus}`;
export const pendingNotices = tasks => tasks.filter(task => !['signed', 'already_signed', 'not_available'].includes(task.observedStatus));

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
