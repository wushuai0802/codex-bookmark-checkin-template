import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterDefinitions,evaluateAdapterCoverage,migrationReadiness} from '../src/adapter-registry.mjs';
test('adapter registry declares read-only capabilities and no mutation verbs',()=>{
 const defs=adapterDefinitions();assert.ok(defs.length>=6);assert.ok(defs.every(d=>d.mode==='observe_only'&&d.mutations.length===0&&d.readyForCanary===false));
});
test('coverage keeps unobserved families as blockers',()=>{
 const r=evaluateAdapterCoverage({counts:{total:2,confirmed:1},results:[{adapter:'readonly.new-api.v1'}]},[{taskId:'a'},{taskId:'b'}]);
 assert.equal(r.totalTasks,2);assert.equal(r.observedTasks,2);assert.ok(r.blocked.some(x=>x.id==='pt-native.v1'));
});
test('readiness never enables execution and identifies current blockers',()=>{
 const r=migrationReadiness({snapshot:{mode:'shadow_read_only',tasks:[{}],reconciliation:{missingCount:0,conflictCount:0},evidenceQuality:{unverifiedSuccess:1}},acceptance:{accepted:false,eligibleRecentDays:3,requiredConsecutiveDays:7},adapterObservations:{counts:{total:0,confirmed:0},results:[]}});
 assert.equal(r.executionEnabled,false);assert.equal(r.phase,'shadow_preparation');assert.ok(r.blockers.includes('shadow_acceptance_incomplete'));assert.ok(r.blockers.includes('unverified_success_evidence'));
});
