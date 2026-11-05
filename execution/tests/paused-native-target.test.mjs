import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture} from './helpers/piggo-spa-fixture.mjs';
import {runOfflinePiggoIndex} from './helpers/piggo-index-fixture.mjs';

const origin='https://tracker.example';

// The main-run preflight skips paused origins, so a paused native-WAF target
// reaches the real index with no preflight result of its own. It must settle
// as paused there, not as a deferred native readback that a resume run fixes.
for(const paused of [true,false])test(`real index settles a ${paused?'paused':'active'} native target that has no preflight result`,async t=>{
  const f=fixture(t);
  if(paused)f.config.disabledCheckinOrigins=[origin];
  const out=await runOfflinePiggoIndex(f,{status:'logged_in'},{otherOrigin:origin,
    preflightChange:{origin:'https://unrelated.example',url:'https://unrelated.example/calendar'}});
  assert.equal(out.calls.length,0);assert.equal(out.report.results.length,1);
  const row=out.report.results[0];
  assert.equal(row.origin,origin);
  if(paused){
    assert.equal(row.status,'not_available',JSON.stringify(row));
    assert.equal(row.availabilityKind,'task_disabled');assert.equal(row.disabledByConfig,true);
    assert.equal(row.evidence.source,'configuration');assert.equal(row.attempt,0);
    assert.equal(row.retryCause,undefined);assert.equal(row.nextEligibleAt,undefined);
    assert.equal(out.report.nextRetryAt??null,null);assert.equal(out.code,0,out.stderr);
  }else{
    // Control: the same run without the pause still reaches the native branch.
    assert.equal(row.status,'deferred',JSON.stringify(row));
    assert.equal(row.retryCause,'native_readback_unavailable');
  }
});
