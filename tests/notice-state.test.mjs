import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeState, pendingNotices } from '../public/notice-state.mjs';

test('read notices persist without changing task results; next day and changed status are unread', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) };
  const task = { taskId: 'task-1', businessDate: '2026-09-10', observedStatus: 'failed' };
  const before = structuredClone(task);
  const notices = createNoticeState(() => storage);
  notices.markRead([task]);
  assert.equal(createNoticeState(() => storage).isRead(task), true);
  assert.equal(notices.isRead({ ...task, businessDate: '2026-09-11' }), false);
  assert.equal(notices.isRead({ ...task, observedStatus: 'login_required' }), false);
  assert.deepEqual(task, before);
  assert.deepEqual(pendingNotices([task, { observedStatus: 'signed' }]), [task]);
});

test('unavailable or corrupt storage never breaks startup or reading', () => {
  for (const getStorage of [() => { throw Error('blocked'); }, () => ({ getItem: () => '{' })]) {
    const state = createNoticeState(getStorage);
    const task = { taskId: 'task-1' };
    state.markRead([task]);
    assert.equal(state.isRead(task), true);
  }
});
