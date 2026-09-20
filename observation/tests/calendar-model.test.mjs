import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyRecords, monthCells, moveMonth, dayTotals,monthTotals,calendarTasks,calendarTaskGroup} from '../public/calendar-model.mjs';

test('calendar uses latest daily execution summary and live snapshot, not historical canary receipts',()=>{
  const counts={executionUnits:3,status:{signed:2,not_available:1}};
  const days=dailyRecords({
    ledger:[{businessDate:'2026-09-19',recordedAt:'2026-09-19T01:00:00Z',counts},
      {businessDate:'2026-09-19',recordedAt:'2026-09-19T02:00:00Z',counts,taskSummaries:[{observedStatus:'signed'}]}],
    snapshot:{businessDate:'2026-09-20',generatedAt:'2026-09-20T02:00:00Z',counts},tasks:[{observedStatus:'signed'}]
  });
  assert.equal(days.size,2);
  assert.equal(days.get('2026-09-19').tasks.length,1);
  assert.equal(days.get('2026-09-20').source,'current');
  assert.deepEqual(dayTotals(days.get('2026-09-20')),{total:3,completed:2,unavailable:1,pending:0});
  assert.deepEqual(monthTotals(days,'2026-09'),{recordDays:2,total:6,completed:4,unavailable:2,pending:0});
});

test('calendar details put unresolved work first and keep filters disjoint',()=>{
  const tasks=[{displayName:'A',observedStatus:'signed'},{displayName:'B',observedStatus:'not_available'},
    {displayName:'C',observedStatus:'deferred'},{displayName:'D',observedStatus:'needs_attention'}];
  assert.deepEqual(calendarTasks({tasks}).map(task=>task.displayName),['C','D','A','B']);
  assert.deepEqual(calendarTasks({tasks},'pending').map(task=>task.displayName),['C','D']);
  assert.equal(calendarTasks({tasks},'completed').length,1);
  assert.equal(calendarTasks({tasks},'unavailable').length,1);
  assert.equal(calendarTaskGroup('unknown'),'pending');
});

test('calendar month navigation handles leap year and Monday offset',()=>{
  assert.deepEqual(monthCells('2024-02'),{offset:3,days:29});
  assert.equal(moveMonth('2026-01',-1),'2025-12');
  assert.equal(moveMonth('2026-12',1),'2027-01');
  assert.throws(()=>monthCells('2026-13'),/invalid month/);
});
