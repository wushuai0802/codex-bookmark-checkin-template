import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesPt,ptStatusCategory} from '../public/dashboard-model.mjs';

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
