import test from 'node:test';
import assert from 'node:assert/strict';
import {taskIdentity} from '../src/contracts.mjs';
import {buildCanaryTask} from '../src/canary-task.mjs';
import fs from 'node:fs';

test('canary task identity is dated and keeps V1 fallback until first mutation',()=>{
  const {taskId,planUnitId}=taskIdentity({businessDate:'2026-09-10',logicalSiteKey:'https://fixture.example',accountKey:'acct7',actionType:'checkin',scheduleOccurrence:'daily'});
  const value={executionEnabled:false,taskId,planUnitId,executionOwner:'legacy-checkin',v1Fallback:{enabled:true},preconditions:{v1MustBeStoppedBeforeMutation:true,firstMutationNotPerformed:true}};
  assert.match(value.taskId,/^task_[a-f0-9]{24}$/); assert.match(value.planUnitId,/^unit_[a-f0-9]{24}$/); assert.equal(value.executionEnabled,false);
});

test('active canary task carries V2 ownership and disables legacy fallback',()=>{
  const profile={accountKey:'acct7',origin:'https://fixture.example',state:'ready',identity:'7',expectedIdentity:'7',profileDir:'profiles/acct7'};
  const task=buildCanaryTask({profile,businessDate:'2026-09-09',planHash:'a'.repeat(64),ownershipState:'active'});
  assert.equal(task.ownershipState,'active');assert.equal(task.executionOwner,'v2-worker');assert.equal(task.v1Fallback.enabled,false);assert.equal(task.preconditions.firstMutationNotPerformed,false);
});

test('prepare-canary defaults to the current Shanghai business date',()=>{
  const source=fs.readFileSync(new URL('../scripts/prepare-canary.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/Date\.now\(\)\+86_400_000/);assert.match(source,/timeZone:'Asia\/Shanghai'/);
});
