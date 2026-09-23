import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPt,ptStatusCategory,matchesTask} from '../public/dashboard-model.mjs';

test('task filters use non-overlapping business groups',()=>{
  const task=status=>({observedStatus:status,origin:'https://example.test'});
  for(const status of ['signed','already_signed'])assert.equal(matchesTask(task(status),{status:'completed'}),true);
  assert.equal(matchesTask(task('deferred'),{status:'pending'}),true);
  assert.equal(matchesTask(task('needs_attention'),{status:'attention'}),true);
  assert.equal(matchesTask(task('failed'),{status:'attention'}),true);
  assert.equal(matchesTask(task('unknown'),{status:'attention'}),true);
  assert.equal(matchesTask(task('not_started'),{status:'attention'}),true);
  assert.equal(matchesTask(task('login_required'),{status:'login_required'}),true);
  assert.equal(matchesTask(task('not_available'),{status:'unavailable'}),true);
  assert.equal(matchesTask(task('deferred'),{status:'completed'}),false);
});

test('PT review filter includes registered unknown status but not unregistered observations',()=>{
  assert.equal(matchesPt({inLegacyPlan:true,effective:{status:'unknown'}},'review'),true);
  assert.equal(matchesPt({inLegacyPlan:true,effective:{status:'signed'}},'review'),false);
  assert.equal(matchesPt({inLegacyPlan:false,effective:{status:'unknown'}},'review'),false);
  assert.equal(matchesPt({inLegacyPlan:false,fallbackEnabled:true,effective:{status:'unknown'}},'review'),true);
});

test('PT completion, reported success and unknown are disjoint, including stale evidence',()=>{
 const site={inLegacyPlan:true,effective:{status:'signed',fresh:true,authoritative:false}};
 assert.equal(ptStatusCategory(site),'reported');
 assert.equal(matchesPt(site,'reported'),true);
 assert.equal(matchesPt(site,'review'),false);
 site.effective.authoritative=true;
 assert.equal(ptStatusCategory(site),'confirmed');
 assert.equal(matchesPt(site,'confirmed'),true);
 site.effective.fresh=false;
 assert.equal(ptStatusCategory(site),'unknown');
 assert.equal(matchesPt(site,'review'),true);
});
