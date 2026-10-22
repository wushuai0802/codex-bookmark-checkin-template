import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPtStatus} from '../src/pt-status.mjs';
import {publicPtStatus} from '../src/dashboard-server.mjs';

const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(value);

test('public PT projection preserves classification, pending diagnostics and null-time inventory audits',()=>{
  const now=new Date(),businessDate=day(now),generatedAt=now.toISOString(),origin='https://pt.example';
  const report=buildPtStatus({businessDate,generatedAt,monitorCatalog:{sites:[{origin},{origin:'https://monitor.example'}]},
    planTargets:[{origin,folderNames:['PT白名单']}],tasks:[{taskId:'task',origin,observedStatus:'needs_attention',submissionAttempted:true,failureCode:'submission_outcome_unknown'}]});
  const projected=publicPtStatus(report);
  assert.equal(projected.counts.monitorOnlyUnconfirmed,1);assert.equal(projected.counts.verificationPending,1);
  const pending=projected.sites.find(site=>site.origin===origin);assert.equal(pending.evidenceState,'verification_pending');
  assert.equal(pending.observations[0].submissionAttempted,true);assert.equal(pending.observations[0].failureCode,'submission_outcome_unknown');
  const inventory=projected.sites.find(site=>site.origin==='https://monitor.example');
  assert.equal(inventory.observations[0].observedAt,null);assert.equal(inventory.evidenceState,'monitor_only_unconfirmed');
  assert.equal(JSON.stringify(projected).includes('profilePath'),false);
});

test('old PT snapshots are classified from sanitized facts, not stale or caller-provided categories',()=>{
  const now=new Date(),today=day(now),yesterday=new Date(now.getTime()-24*3600_000).toISOString();
  const report={businessDate:today,generatedAt:now.toISOString(),sources:['legacy-checkin'],counts:{monitorOnlyUnconfirmed:100,verificationPending:100},sites:[{
    siteRef:'pt_0123456789abcdef',origin:'https://pt.example',accountRef:null,inLegacyPlan:true,managedBy:'legacy-checkin',evidenceState:'confirmed',reconciledFromUnknown:true,
    effective:{source:'legacy-checkin',status:'signed',observedAt:yesterday,fresh:true,authoritative:true,evidence:{source:'page_text',authoritative:true}},
    sourceStatuses:[{source:'legacy-checkin',status:'signed',observedAt:yesterday,fresh:true,authoritative:true}],
    observations:[{source:'legacy-checkin',status:'signed',observedAt:yesterday,fresh:true,authoritative:true,evidence:{source:'page_text',authoritative:true}}]}]};
  const projected=publicPtStatus(report),site=projected.sites[0];
  assert.equal(site.effective.fresh,false);assert.equal(site.sourceStatuses[0].fresh,false);assert.equal(site.observations[0].fresh,false);
  assert.equal(site.evidenceState,'guarded_read_needed');assert.equal(site.reconciledFromUnknown,undefined);
  assert.equal(projected.counts.monitorOnlyUnconfirmed,0);assert.equal(projected.counts.verificationPending,0);assert.equal(projected.counts.guardedReadNeeded,1);
});

test('public reconciliation cannot accept an unbound success merely because the old snapshot sets a flag',()=>{
  const now=new Date(),businessDate=day(now),origin='https://pt.example',accountRef='acct_0123456789abcdef',profileBinding='a'.repeat(64);
  const args={businessDate,generatedAt:now.toISOString(),planTargets:[{origin,folderNames:['PT白名单']}],
    tasks:[{taskId:'task',origin,accountRef,profileBinding,observedStatus:'needs_attention',submissionAttempted:true,failureCode:'submission_outcome_unknown'}],
    receipts:[{taskId:'task',observedAt:new Date(now.getTime()-1000).toISOString(),evidence:{source:'none',authoritative:false}}],
    fallbackReport:{source:'execution-supplement',businessDate,sites:[{origin,accountRef,status:'already_signed',observedAt:now.toISOString(),submissionAttempted:false,readSafety:'reviewed_passive',
      evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:now.toISOString(),profileBinding,evidenceScope:'site_account_day'}}]}};
  const confirmed=publicPtStatus(buildPtStatus(args)).sites[0];
  assert.equal(confirmed.reconciledFromUnknown,true);assert.equal(confirmed.evidenceState,'confirmed');
  const invalid=buildPtStatus({...args,fallbackReport:{...args.fallbackReport,sites:[{...args.fallbackReport.sites[0],readSafety:'unknown'}]}});
  invalid.sites[0].reconciledFromUnknown=true;
  const projected=publicPtStatus(invalid).sites[0];assert.equal(projected.reconciledFromUnknown,undefined);assert.equal(projected.evidenceState,'verification_pending');
});
