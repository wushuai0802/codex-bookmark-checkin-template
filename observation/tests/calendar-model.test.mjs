import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyRecords, monthCells, moveMonth,moveCalendarDay,selectCalendarMonth, dayTotals,monthTotals,calendarTasks,calendarTaskGroup} from '../public/calendar-model.mjs';

test('calendar uses latest daily execution summary and live snapshot, not historical canary receipts',()=>{
  const counts={executionUnits:3,status:{signed:2,not_available:1}};
  const days=dailyRecords({
    ledger:[{businessDate:'2026-09-19',recordedAt:'2026-09-19T01:00:00Z',counts},
      {businessDate:'2026-09-19',recordedAt:'2026-09-19T02:00:00Z',counts,taskSummaries:[{observedStatus:'signed'}]}],
    snapshot:{businessDate:'2026-09-20',generatedAt:'2026-09-20T02:00:00Z',counts},tasks:[{observedStatus:'signed'}],now:Date.parse('2026-09-20T03:00:00Z')
  });
  assert.equal(days.size,2);
  assert.equal(days.get('2026-09-19').tasks.length,1);
  assert.equal(days.get('2026-09-20').source,'current');
  assert.deepEqual(dayTotals(days.get('2026-09-20')),{total:3,completed:2,unavailable:1,cancelled:0,pending:0});
  assert.deepEqual(monthTotals(days,'2026-09'),{recordDays:2,total:6,completed:4,unavailable:2,cancelled:0,pending:0});
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

test('daily navigation crosses months and years and respects real calendar bounds',()=>{
  assert.equal(moveCalendarDay('2026-01-01',-1),'2025-12-31');
  assert.equal(moveCalendarDay('2025-12-31',1),'2026-01-01');
  assert.equal(moveCalendarDay('2024-02-28',1),'2024-02-29');
  assert.equal(moveCalendarDay('2024-02-29',1),'2024-03-01');
  assert.equal(moveCalendarDay('2100-02-28',1),'2100-03-01');
  assert.equal(moveCalendarDay('2026-09-30',1,{maximum:'2026-09-30'}),'2026-09-30');
  assert.equal(moveCalendarDay('2023-09-01',-1,{minimum:'2023-09-01'}),'2023-09-01');
  assert.equal(moveCalendarDay('9999-12-31',1),'9999-12-31');
  assert.throws(()=>moveCalendarDay('2026-02-30',1),/invalid calendar date/);
});

test('year and month selection retain the selected day or clamp it to the month end and today',()=>{
  assert.equal(selectCalendarMonth('2026-01-31','2026-02'),'2026-02-28');
  assert.equal(selectCalendarMonth('2024-01-31','2024-02'),'2024-02-29');
  assert.equal(selectCalendarMonth('2024-02-29','2025-02'),'2025-02-28');
  assert.equal(selectCalendarMonth('2026-03-31','2026-04'),'2026-04-30');
  assert.equal(selectCalendarMonth('2025-12-31','2026-12',{maximum:'2026-09-15'}),'2026-09-15');
  assert.equal(selectCalendarMonth('2026-03-12','2025-08'),'2025-08-12');
});

test('calendar combines all PT receipts without counting a regular PT account twice',()=>{
  const at='2026-09-30T06:00:00Z',day='2026-09-30';
  const tasks=[{taskId:'regular-a',origin:'https://pt.example',accountRef:'acct_a',observedStatus:'unknown'},
    {taskId:'regular-b',origin:'https://api.example',observedStatus:'signed'}];
  const ptSummaries=[{origin:'https://pt.example',accountRef:'acct_a',inLegacyPlan:true,observedStatus:'signed'},
    {origin:'https://fallback.example',inLegacyPlan:false,observedStatus:'already_signed'}];
  const ledger=[{businessDate:day,recordedAt:at,counts:{executionUnits:2,status:{signed:1,unknown:1}},taskSummaries:tasks,ptSummaries}];
  const all=dailyRecords({ledger}).get(day),regular=dailyRecords({ledger,scope:'regular'}).get(day),pt=dailyRecords({ledger,scope:'pt'}).get(day);
  assert.deepEqual(dayTotals(all),{total:3,completed:3,unavailable:0,cancelled:0,pending:0});
  assert.equal(dayTotals(regular).total,2);assert.equal(dayTotals(regular).pending,1);
  assert.equal(dayTotals(pt).total,2);assert.equal(all.tasks[0].taskId,'regular-a');assert.equal(all.ptRecorded,true);
  assert.equal(ledger[0].taskSummaries[0].observedStatus,'unknown');
});

test('missing historical PT detail is explicit and multiple regular accounts stay distinct',()=>{
  const day='2026-09-29',counts={executionUnits:2,status:{signed:2}},tasks=[
    {origin:'https://pt.example',accountRef:'a',observedStatus:'signed'},
    {origin:'https://pt.example',accountRef:'b',observedStatus:'signed'}];
  const record={businessDate:day,recordedAt:day+'T06:00:00Z',counts,taskSummaries:tasks};
  assert.equal(dailyRecords({ledger:[record]}).get(day).ptRecorded,false);
  assert.equal(dailyRecords({ledger:[record],scope:'pt'}).get(day).tasks.length,0);
  const merged=dailyRecords({ledger:[{...record,ptSummaries:[{origin:'https://pt.example',inLegacyPlan:true,observedStatus:'unknown'}]}]}).get(day);
  assert.equal(merged.tasks.length,2);assert.equal(dayTotals(merged).completed,2);
});

test('midnight freshness does not rewrite a prior-day PT calendar receipt',()=>{
  const businessDate='2026-10-01',at='2026-10-01T15:59:00Z',origin='https://pt.example';
  const task={taskId:'one',origin,observedStatus:'signed',evidence:{authoritative:true}};
  const counts={executionUnits:1,status:{signed:1}};
  const ledger=[{businessDate,recordedAt:at,counts,taskSummaries:[task],ptSummaries:[{...task,inLegacyPlan:true}]}];
  const input={ledger,snapshot:{businessDate,generatedAt:at,counts},tasks:[task],
    ptStatus:{businessDate,sites:[{origin,inLegacyPlan:true,effective:{status:'signed',fresh:false,authoritative:true,observedAt:at}}]},
    now:Date.parse('2026-10-01T16:01:00Z')};
  const original=JSON.stringify(input),entry=dailyRecords(input).get(businessDate);
  assert.equal(entry.source,'ledger');assert.equal(entry.tasks[0].observedStatus,'signed');
  assert.equal(dayTotals(entry).completed,1);assert.equal(dayTotals(entry).pending,0);
  assert.equal(JSON.stringify(input),original);
  const today='2026-10-02';
  input.snapshot={businessDate:today,generatedAt:'2026-10-01T16:00:00Z',counts:{executionUnits:1,status:{not_started:1}}};
  input.tasks=[{...task,observedStatus:'not_started'}];input.ptStatus=null;
  const days=dailyRecords(input);assert.equal(days.get(businessDate).tasks[0].observedStatus,'signed');
  assert.equal(days.get(today).source,'current');assert.equal(dayTotals(days.get(today)).pending,1);
});

test('cancelled tasks have a separate calendar count and never count as unfinished or completed',()=>{
  const task={observedStatus:'not_available',condition:'task_disabled',evidence:{verification:'task_disabled',rawSource:'configuration',authoritative:true}};
  const entry={counts:{executionUnits:3,status:{signed:1,not_available:2}},tasks:[task,{observedStatus:'not_available'},{observedStatus:'signed'}]};
  assert.deepEqual(dayTotals(entry),{total:3,completed:1,unavailable:1,cancelled:1,pending:0});
  assert.equal(calendarTasks(entry,'cancelled').length,1);assert.equal(calendarTasks(entry,'unavailable').length,1);
  assert.equal(calendarTasks(entry,'completed').length,1);assert.equal(calendarTasks(entry,'pending').length,0);
  assert.equal(monthTotals(new Map([['2026-10-02',entry]]),'2026-10').cancelled,1);
});
