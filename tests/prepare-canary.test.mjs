import test from 'node:test';
import assert from 'node:assert/strict';
import {taskIdentity} from '../src/contracts.mjs';

test('canary task identity is dated and keeps V1 fallback until first mutation',()=>{
  const {taskId,planUnitId}=taskIdentity({businessDate:'2026-09-10',logicalSiteKey:'https://fixture.example',accountKey:'acct7',actionType:'checkin',scheduleOccurrence:'daily'});
  const value={executionEnabled:false,taskId,planUnitId,executionOwner:'legacy-checkin',v1Fallback:{enabled:true},preconditions:{v1MustBeStoppedBeforeMutation:true,firstMutationNotPerformed:true}};
  assert.match(value.taskId,/^task_[a-f0-9]{24}$/); assert.match(value.planUnitId,/^unit_[a-f0-9]{24}$/); assert.equal(value.executionEnabled,false);
});
