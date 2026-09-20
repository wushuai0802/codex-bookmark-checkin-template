import test from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeState, pendingNotices, pausedNotices, attentionPreview } from '../public/notice-state.mjs';

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

test('attention preview is bounded while the full pending task set stays reachable', () => {
  const tasks = Array.from({ length: 8 }, (_, i) => ({ taskId: String(i), origin:`https://site${i}.example`, observedStatus: i === 7 ? 'signed' : i === 0 ? 'deferred' : 'needs_attention' }));
  const before = structuredClone(tasks);
  const preview = attentionPreview(tasks, 4);
  assert.equal(preview.all.length, 7);
  assert.equal(preview.visible.length, 4);
  assert.equal(preview.remaining, 3);
  assert.equal(preview.visible[0].task.observedStatus, 'needs_attention');
  assert.deepEqual(tasks, before);
});

test('identical attention causes are grouped without merging distinct accounts or dates', () => {
  const shared = {businessDate:'2026-09-20',origin:'https://same.example',observedStatus:'needs_attention',evidence:{summary:'browser blocked'}};
  const tasks=[{...shared,taskId:'a',accountRef:'one'},{...shared,taskId:'b',accountRef:'two'},
    {...shared,taskId:'c',businessDate:'2026-09-19'}, {...shared,taskId:'d',evidence:{summary:'login required'}}];
  const result=attentionPreview(tasks,2);
  assert.equal(result.all.length,4);
  assert.equal(result.visible.length,2);
  assert.equal(result.visible[0].tasks.length,2);
  assert.equal(result.remaining,1);
});

test('temporary attention pause expires without changing the task result',()=>{
  const now=Date.parse('2026-09-20T05:00:00Z');
  const task={taskId:'pending',origin:'https://example.com',observedStatus:'deferred',attention:{pausedUntil:'2026-09-21T05:00:00Z'}};
  const before=structuredClone(task);
  assert.equal(pendingNotices([task],now).length,0);
  assert.equal(pausedNotices([task],now).length,1);
  assert.equal(attentionPreview([task],4,now).pausedCount,1);
  assert.equal(pendingNotices([task],now+24*60*60*1000).length,1);
  assert.deepEqual(task,before);
});
