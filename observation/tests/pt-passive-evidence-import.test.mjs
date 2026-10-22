import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEvidence} from '../src/evidence-contract.mjs';

test('an executor-validated single-account PT readback retains authority after numeric identity is redacted',()=>{
  const businessDate='2026-10-11',referenceAt='2026-10-11T05:00:01Z';
  const result={origin:'https://ptsbao.club',status:'already_signed',submissionAttempted:false,
    profileBinding:'a'.repeat(64),operationMode:'safe_history_page',readSafety:'reviewed_passive',
    reconciliation:{kind:'confirmed_external',accountKey:'site-default'},
    evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:'2026-10-11T05:00:00Z',
      pagePath:'/index.php',statusSignal:'nexus_daily_header_signed',evidenceScope:'site_account_day'}};
  assert.equal(normalizeEvidence(result,{businessDate,referenceAt}).verification,'verified');
  for(const changed of [{profileBinding:undefined},{operationMode:'legacy_checkin'},
    {readSafety:'attendance_page_risk'},{submissionAttempted:true},{reconciliation:undefined},
    {reconciliation:{kind:'confirmed_external',accountKey:'other'}},{origin:'https://unreviewed.example'},
    {evidence:{...result.evidence,evidenceScope:undefined}},{evidence:{...result.evidence,pagePath:'/forums.php'}},
    {evidence:{...result.evidence,statusSignal:'cumulative_reward'}}])
    assert.notEqual(normalizeEvidence({...result,...changed},{businessDate,referenceAt}).verification,'verified');
  assert.notEqual(normalizeEvidence(result,{businessDate,referenceAt,expectedId:'1'}).verification,'verified');
});
