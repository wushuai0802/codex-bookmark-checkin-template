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

test('scheduler excludes paused origins and accounts from dispatch while preserving blocked audit entries',()=>{
  const plan=buildDailyDispatchPlan({businessDate:'2026-09-10',now:'2026-09-10T00:10:00Z',tasks:[
    {origin:'https://agentrouter.org',accountKey:'agentrouter-245770',executionOwner:'v2-worker'},
    {origin:'https://agentrouter.org',accountKey:'agentrouter-343000',executionOwner:'v2-worker'},
    {origin:'https://fixture.example',accountKey:'paused-account',executionOwner:'v2-worker'},
    {origin:'https://fixture.example',accountKey:'active-account',executionOwner:'v2-worker'},
  ],disabledOrigins:['https://agentrouter.org'],disabledAccountKeys:['paused-account']});
  assert.deepEqual(plan.dispatch.map(item=>item.accountKey),['active-account']);
  assert.deepEqual(plan.blocked.filter(item=>item.reason==='task_disabled').map(item=>[item.origin,item.accountKey,item.disabledBy]),[
    ['https://agentrouter.org','agentrouter-245770','origin'],
    ['https://agentrouter.org','agentrouter-343000','origin'],
    ['https://fixture.example','paused-account','account'],
  ]);
});

test('scheduler pause filters are optional and do not change existing callers',()=>{
  const plan=buildDailyDispatchPlan({businessDate:'2026-09-10',now:'2026-09-10T00:10:00Z',tasks:[
    {origin:'https://fixture.example',accountKey:'acct7',executionOwner:'v2-worker'},
  ]});
  assert.equal(plan.dispatch.length,1);
  assert.equal(plan.blocked.length,0);
});

test('scheduler accepts the effective execution configuration directly',()=>{
  const plan=buildDailyDispatchPlan({businessDate:'2026-09-10',now:'2026-09-10T00:10:00Z',config:{
    disabledCheckinOrigins:['https://agentrouter.org'],
    disabledAccountKeys:['paused-account'],
  },tasks:[
    {origin:'https://agentrouter.org',accountKey:'agentrouter-245770',executionOwner:'v2-worker'},
    {origin:'https://fixture.example',accountKey:'paused-account',executionOwner:'v2-worker'},
  ]});
  assert.equal(plan.dispatch.length,0);
  assert.equal(plan.blocked.filter(item=>item.reason==='task_disabled').length,2);
});
