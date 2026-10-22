import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {matchesPt,ptEvidenceState,PT_EVIDENCE_LABELS} from '../public/dashboard-model.mjs';
import {normalizeRoute,routeHash,routeFromHash} from '../public/navigation.mjs';
import {overviewMetrics} from '../public/overview-model.mjs';

test('PT review separates pure observation and external state without retiring authorized supplements',()=>{
  const base={effective:{status:'unknown',fresh:false,authoritative:false}};
  const passive={...base,inLegacyPlan:false,fallbackEnabled:false,evidenceState:'monitor_only_unconfirmed'};
  const opted={...base,inLegacyPlan:false,fallbackEnabled:true,evidenceState:'guarded_read_needed'};
  const pending={...base,inLegacyPlan:true,evidenceState:'verification_pending'};
  const external={...base,inLegacyPlan:true,evidenceState:'external_blocked'};
  assert.equal(matchesPt(passive,'review'),false);
  assert.equal(matchesPt(passive,'monitor_unconfirmed'),true);
  assert.equal(matchesPt(opted,'review'),true);
  assert.equal(matchesPt(pending,'verification'),true);
  assert.equal(matchesPt(pending,'review'),true);
  assert.equal(matchesPt(external,'review'),false);
  assert.equal(matchesPt(external,'external'),true);
  assert.equal(ptEvidenceState({...base,inLegacyPlan:false,fallbackEnabled:true}),'guarded_read_needed');
  assert.equal(ptEvidenceState({...base,inLegacyPlan:false,fallbackEnabled:false}),'monitor_only_unconfirmed');
  assert.equal(PT_EVIDENCE_LABELS.verification_pending,'提交待核验');
});

test('new PT classification filters survive reload and route normalization',()=>{
  for(const scope of ['monitor_unconfirmed','verification','external']){
    const route=normalizeRoute({view:'pt-status',ptScope:scope});
    assert.equal(route.ptScope,scope);
    assert.equal(routeFromHash(routeHash(route)).ptScope,scope);
  }
});

test('monitor inventory never enters executable task success-rate denominator',()=>{
  const data={counts:{executionUnits:3},tasks:[{observedStatus:'signed'},
    {observedStatus:'deferred',condition:'upstream_unavailable',failureCode:'tls_certificate_invalid'},
    {observedStatus:'needs_attention',condition:'submission_outcome_unknown'}],
    evidenceQuality:{verifiedSuccess:1},ptStatus:{counts:{sites:30,monitorOnlyUnconfirmed:25}}};
  const m=overviewMetrics(data);
  assert.equal(m.eligible,2);
  assert.equal(m.rate,50);
  assert.equal(m.pending,2);
  assert.equal(m.verifiedSuccess,1);
});

test('PT interface keeps guarded supplement and audit labels rather than indefinite Harvest waiting',()=>{
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  assert.ok(source.includes('已授权补签，先核验今日状态'));
  assert.ok(source.includes('当日只读证据已闭环，原记录保留'));
  assert.ok(source.includes('只读复核提交结果'));
  assert.ok(!source.includes('Harvest 未完成后复核'));
});
