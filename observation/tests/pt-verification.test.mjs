import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {currentPassivePtResult,recordPtVerification} from '../src/pt-verification.mjs';
import {loadPtRecoveryDiagnostics} from '../src/pt-reconciliation.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {publicPtStatus} from '../src/dashboard-server.mjs';
const now=new Date('2026-09-30T05:00:00Z'),origin='https://pt.example';
const receipt=(status='not_signed')=>({origin,status,observedAt:now.toISOString(),businessDate:'2026-09-30',
  profileBinding:'a'.repeat(64),accountKey:'site-default',operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
  evidence:{source:'pt_page',authoritative:true,confirmedAt:now.toISOString(),businessDate:'2026-09-30',evidenceScope:'site_account_day',
    pagePath:'/index.php',statusSignal:'nexus_daily_header_unsigned',summary:'今日尚未签到'}});
function workspace(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-verify-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'outputs'));return root;}

test('passive verification requires current account-day evidence and keeps completion when a later read fails',t=>{
  const root=workspace(t);
  assert.equal(currentPassivePtResult(receipt(),now).status,'not_signed');
  for(const change of [{submissionAttempted:true},{profileBinding:null},{businessDate:'2026-09-29'},
    {observedAt:'2026-09-30T04:00:00Z'},{readSafety:'unknown'},{evidence:{source:'none',authoritative:false}}])
    assert.throws(()=>currentPassivePtResult({...receipt(),...change},now));
  recordPtVerification(root,receipt('already_signed'),{now});
  recordPtVerification(root,{...receipt(),status:'unknown',evidence:{source:'none',authoritative:false}},{now});
  const report=JSON.parse(fs.readFileSync(path.join(root,'outputs/pt-fallback-results-2026-09-30.json')));
  assert.equal(report.sites[0].status,'already_signed');
  assert.equal(fs.readFileSync(path.join(root,'outputs/pt-verifications-2026-09-30.jsonl'),'utf8').trim().split('\n').length,2);
});

test('old unresolved attempts expose their actual blocking day without changing signup evidence',t=>{
  const root=workspace(t),file=path.join(root,'outputs/harvest-fallback-attempts-2026-09-21.json');
  fs.writeFileSync(file,JSON.stringify({businessDate:'2026-09-21',attempts:[{origin,state:'outcome_unknown',startedAt:'2026-09-21T01:00:00Z'}]}));
  const before=fs.readFileSync(file,'utf8'),recoveryReport=loadPtRecoveryDiagnostics(root,'2026-09-30');
  const args={generatedAt:now.toISOString(),businessDate:'2026-09-30',monitorCatalog:{sites:[{origin}]},recoveryReport};
  const unknown=buildPtStatus(args).sites[0];
  assert.equal(unknown.recovery.code,'prior_outcome_unknown');assert.match(unknown.recovery.summary,/2026-09-21/);
  assert.equal(unknown.recovery.blockedSince,'2026-09-21');
  assert.equal(unknown.effective.evidence.summary,'尚无今日确认回执');
  assert.equal(unknown.effective.authoritative,false);assert.equal(fs.readFileSync(file,'utf8'),before);
  const confirmed=buildPtStatus({...args,fallbackReport:{source:'execution-supplement',businessDate:'2026-09-30',sites:[receipt('already_signed')]}}).sites[0];
  assert.equal(confirmed.effective.status,'already_signed');assert.equal(confirmed.effective.authoritative,true);
});

test('a newer generic failure cannot hide maintenance diagnostics in the actual dashboard API',()=>{
  const current=new Date(),day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(current);
  const earlier=new Date(current.getTime()-1000).toISOString();
  const report=buildPtStatus({businessDate:day,generatedAt:current.toISOString(),monitorCatalog:{sites:[{origin}]},
    planTargets:[{origin}],tasks:[{taskId:'task',origin,observedStatus:'needs_attention'}],
    receipts:[{taskId:'task',observedAt:current.toISOString(),evidence:{source:'none',authoritative:false,summary:'提交结果不明'}}],
    fallbackReport:{source:'execution-supplement',businessDate:day,sites:[{origin,observedAt:earlier,status:'needs_attention',
      failureCode:'site_maintenance',siteCondition:'site_maintenance',evidence:{source:'page_text',authoritative:false,summary:'站点维护'}}]},
    recoveryReport:{businessDate:day,sites:[{origin,code:'prior_outcome_unknown',blockedSince:'2026-09-21',summary:'旧记录待核验'}]}});
  assert.equal(report.sites[0].observations[0].evidence.summary,'提交结果不明');
  const published=publicPtStatus(report).sites[0];
  assert.equal(published.effective.siteCondition,'site_maintenance');
  assert.match(published.effective.evidence.summary,/维护/);
  assert.equal(published.recovery.blockedSince,'2026-09-21');
  assert.equal(published.effective.authoritative,false);
  assert.equal(published.observations.find(o=>o.source==='execution-supplement').failureCode,'site_maintenance');
});
