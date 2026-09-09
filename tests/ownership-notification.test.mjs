import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateOwnershipTransition,rollbackOwnership} from '../src/ownership-transition.mjs';
import {createDelivery,deliverNotification} from '../src/notification-delivery.mjs';

const now='2026-09-10T00:00:00Z';
test('ownership changes only after V1 drain and authoritative V2 success',()=>{
  const blocked=evaluateOwnershipTransition({v1:{runLockActive:true,owner:'legacy-checkin'},v2:{owner:'v2-worker',phase:'succeeded'},receipt:{authoritative:true},now});
  assert.equal(blocked.changed,false);
  const switched=evaluateOwnershipTransition({v1:{runLockActive:false,owner:'legacy-checkin'},v2:{owner:'v2-worker',phase:'succeeded'},receipt:{authoritative:true},now});
  assert.equal(switched.state,'v2-worker'); assert.equal(switched.changed,true);
  assert.equal(rollbackOwnership({v2:{owner:'v2-worker'},reason:'verification_failed',now}).state,'legacy-checkin');
});

test('notification delivery retries only delivery and never changes receipt',async()=>{
  const receipt={taskId:'task_aaaaaaaaaaaaaaaaaaaaaaaa',businessDate:'2026-09-10',status:'signed',observedAt:now,evidence:{source:'api',authoritative:true,summary:'verified',redacted:true}};
  const item=createDelivery(receipt,{now}); const failed=await deliverNotification(item,{send:async()=>{throw Error('offline')},now});
  assert.equal(failed.state,'pending'); assert.equal(failed.attempts,1); assert.equal(receipt.status,'signed');
  const sent=await deliverNotification(failed,{send:async()=>{},now}); assert.equal(sent.state,'delivered');
});
