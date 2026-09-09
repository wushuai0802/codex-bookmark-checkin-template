import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyDispatchPlan} from '../src/scheduler.mjs';

test('scheduler keeps monitor-only separate and assigns stable owner-aware task IDs',()=>{
  const plan=buildDailyDispatchPlan({businessDate:'2026-09-10',now:'2026-09-10T00:10:00Z',tasks:[
    {origin:'https://fixture.example',accountKey:'acct7',executionOwner:'v2-worker'},
    {origin:'https://monitor.example',accountKey:'site-default',monitorOnly:true}
  ],owners:{'https://fixture.example|acct7':'v2-worker'}});
  assert.equal(plan.due,true); assert.equal(plan.dispatch[0].eligible,true); assert.match(plan.dispatch[0].taskId,/^task_/); assert.equal(plan.blocked[0].reason,'monitor_only');
});

test('scheduler refuses duplicate and unknown owners',()=>{
  const plan=buildDailyDispatchPlan({businessDate:'2026-09-10',now:'2026-09-10T00:10:00Z',tasks:[
    {origin:'https://fixture.example',accountKey:'acct7'},
    {origin:'https://fixture.example/path',accountKey:'acct7'},
    {origin:'https://other.example',accountKey:'acct8',executionOwner:'other'}
  ]});
  assert.equal(plan.dispatch.length,1); assert.ok(plan.blocked.some(x=>x.reason==='duplicate_task')); assert.ok(plan.blocked.some(x=>x.reason==='unknown_owner'));
});
