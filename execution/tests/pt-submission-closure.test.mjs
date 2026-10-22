import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireRunLock,releaseRunLock} from '../src/run-lock.mjs';
import {ptObservationBinding,boundPtObservation,freshPtUnsignedObservation,verifiedPtObservation} from '../src/pt-observation-receipt.mjs';
import {reconcilePendingPtObservations,claimPtUnsignedRecovery} from '../src/pt-submission-closure.mjs';
import {pendingOpenCdSubmission} from '../src/quota-claim-guard.mjs';
import {updateSiteState} from '../src/site-state.mjs';

const origin='https://open.cd',pendingAt='2026-10-06T02:07:17.918Z';
const businessDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date(at));
async function fixture(t,{legacy=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pt-submission-closure-'));
  const observation=path.join(root,'observation');
  for(const directory of ['data','tmp','observation/config','observation/outputs'])fs.mkdirSync(path.join(root,directory),{recursive:true});
  fs.writeFileSync(path.join(root,'data/v2-integration.json'),JSON.stringify({executionEngine:'v1',v2ProjectRoot:observation}));
  fs.writeFileSync(path.join(observation,'config/runtime.local.json'),JSON.stringify({executionEngine:'v1',legacyRoot:root}));
  const target={origin,accountKey:'site-default'},config={automationUserDataDir:path.join(root,'data/automation')};
  const binding=ptObservationBinding(root,target,config),now=new Date('2026-10-07T00:10:00Z');
  const state={version:1,updatedAt:pendingAt,sites:{[origin]:{pendingOpenCdAt:pendingAt,
    lastSuccessAt:'2026-10-05T02:00:31.224Z',lastConfirmedAt:'2026-10-05T02:00:31.224Z',runCount:10,confirmedCount:8,
    ...(!legacy?{pendingOpenCdProfileBinding:binding.profileBinding,pendingOpenCdAccountKey:'site-default'}:{})}}};
  const file=path.join(root,'data/site-state.json');fs.writeFileSync(file,JSON.stringify(state));
  const lockLease=await acquireRunLock(path.join(root,'tmp/run.lock'),{inspectProcess:async()=>({alive:true,startedAt:pendingAt})});
  t.after(async()=>{await releaseRunLock(lockLease);fs.rmSync(root,{recursive:true,force:true});});
  const previousReport={finishedAt:pendingAt,results:[{origin,status:'needs_attention',failureCode:'submission_outcome_unknown',
    submissionAttempted:true,observedAt:pendingAt}]};
  const save=value=>fs.writeFileSync(path.join(observation,'outputs',`pt-fallback-results-${value.businessDate}.json`),
    JSON.stringify({source:'execution-supplement',businessDate:value.businessDate,sites:[value]}));
  return {root,observation,target,targets:[target],config,binding,now,state,file,lockLease,previousReport,save};
}
function receipt(args,at='2026-10-06T05:30:40.854Z',status='already_signed'){
  const businessDate=businessDay(at);
  return {origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,status,businessDate,observedAt:at,
    operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    evidence:{source:'pt_page',authoritative:true,businessDate,confirmedAt:at,pagePath:'/index.php',evidenceScope:'site_account_day',
      statusSignal:status==='not_signed'?'open_cd_daily_unsigned':'open_cd_daily_record_entry'}};
}
const readState=args=>JSON.parse(fs.readFileSync(args.file));

test('bound yesterday completion closes only its pending audit and never credits today',async t=>{
  const args=await fixture(t);args.save(receipt(args));
  const saved=await reconcilePendingPtObservations(args);
  assert.equal(saved.changed,true);assert.equal(saved.state.sites[origin].pendingOpenCdAt,null);
  const site=saved.state.sites[origin],audit=site.openCdSubmissionResolutions[0];
  assert.equal(audit.kind,'historical_confirmed');assert.equal(audit.businessDate,'2026-10-06');
  assert.equal(site.lastSuccessAt,args.state.sites[origin].lastSuccessAt);assert.equal(site.lastConfirmedAt,args.state.sites[origin].lastConfirmedAt);
  assert.equal(site.runCount,10);assert.equal(site.confirmedCount,8);
  assert.equal(verifiedPtObservation(args.root,args.target,args.config,args.now),null);
  assert.equal(pendingOpenCdSubmission(args.target,saved.state,args.previousReport,{now:args.now}),null);
  const repeated=await reconcilePendingPtObservations({...args,state:saved.state});
  assert.equal(repeated.changed,false);assert.equal(readState(args).sites[origin].openCdSubmissionResolutions.length,1);
  assert.equal((await reconcilePendingPtObservations({...args,state:{sites:{}}})).changed,false);
});

test('legacy unbound pending cannot be manufactured into yesterday profile confirmation',async t=>{
  const args=await fixture(t,{legacy:true});args.save(receipt(args));
  const saved=await reconcilePendingPtObservations(args);
  assert.equal(saved.changed,false);assert.equal(readState(args).sites[origin].pendingOpenCdAt,pendingAt);
  assert.equal(readState(args).sites[origin].openCdSubmissionResolutions,undefined);
});

test('historical receipts fail closed for wrong bindings, date, ambiguity and non-newer proof',async t=>{
  const args=await fixture(t),base=receipt(args);
  for(const invalid of [{...base,origin:'https://other.example'},{...base,accountKey:'secondary'},
    {...base,profileBinding:'b'.repeat(64)},{...base,evidence:{...base.evidence,businessDate:'2026-10-05'}},
    {...base,observedAt:'invalid'},{...base,submissionAttempted:true},{...base,submissionOutcomeUnknown:true},
    {...base,evidence:{...base.evidence,evidenceScope:'site_day'}},
    {...base,evidence:{...base.evidence,pagePath:'/attendance.php'}},
    receipt(args,pendingAt),receipt(args,'2026-10-06T02:07:16Z')]){
    args.save(invalid);assert.equal((await reconcilePendingPtObservations(args)).changed,false);
  }
  args.save(base);
  fs.writeFileSync(path.join(args.observation,'outputs/pt-fallback-results-2026-10-06.json'),
    JSON.stringify({source:'execution-supplement',businessDate:'2026-10-06',sites:[base,base]}));
  assert.equal((await reconcilePendingPtObservations(args)).changed,false);
  args.save(base);fs.writeFileSync(path.join(args.observation,'config/runtime.local.json'),
    JSON.stringify({executionEngine:'v1',legacyRoot:path.join(args.root,'other')}));
  assert.equal((await reconcilePendingPtObservations(args)).changed,false);
  assert.equal(readState(args).sites[origin].pendingOpenCdAt,pendingAt);
});

test('receipt consumption requires the real current V1 lock and is serialized and atomic',async t=>{
  const args=await fixture(t);args.save(receipt(args));
  await assert.rejects(()=>reconcilePendingPtObservations({...args,lockLease:null}),/run lock/);
  await assert.rejects(()=>reconcilePendingPtObservations({...args,lockLease:{...args.lockLease,
    owner:{...args.lockLease.owner,nonce:'not-the-owner'}}}),/ownership/);
  await assert.rejects(()=>acquireRunLock(args.lockLease.lockPath,{inspectProcess:async()=>({alive:true,startedAt:pendingAt})}),/正在运行/);
  await assert.rejects(()=>reconcilePendingPtObservations({...args,persist:()=>{throw Error('disk write failed');}}),/disk write failed/);
  assert.equal(readState(args).sites[origin].pendingOpenCdAt,pendingAt);
  const concurrent=await Promise.all([reconcilePendingPtObservations(args),reconcilePendingPtObservations(args)]);
  assert.equal(concurrent.filter(result=>result.changed).length,1);
  assert.equal(readState(args).sites[origin].openCdSubmissionResolutions.length,1);
});

test('fresh current negative permits one durable recovery while the legacy outcome remains unknown',async t=>{
  const args=await fixture(t,{legacy:true});args.save(receipt(args,args.now.toISOString(),'not_signed'));
  const claimed=await claimPtUnsignedRecovery(args);
  assert.equal(claimed.allowed,true);assert.equal(claimed.state.sites[origin].pendingOpenCdAt,pendingAt);
  assert.equal(claimed.recovery.originalOutcome,'unknown');assert.equal(claimed.recovery.recoveryProofType,'current_day_not_signed');
  assert.equal((await claimPtUnsignedRecovery({...args,state:claimed.state})).allowed,false);
  assert.equal(pendingOpenCdSubmission(args.target,readState(args),args.previousReport,{now:args.now}).failureCode,'submission_outcome_unknown');
  const failedAt=new Date(args.now.getTime()+1000),failure={origin,profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:claimed.recovery};
  const failed=updateSiteState(claimed.state,[failure],failedAt,args.config);fs.writeFileSync(args.file,JSON.stringify(failed));
  assert.equal(failed.sites[origin].pendingOpenCdAt,failedAt.toISOString());
  assert.equal(failed.sites[origin].openCdRecoveryAttempts[0].originalPendingAt,pendingAt);
  assert.equal(failed.sites[origin].openCdRecoveryAttempts[0].state,'outcome_unknown');
  assert.equal((await claimPtUnsignedRecovery({...args,now:failedAt,state:failed})).allowed,false);
  const successAt=new Date(args.now.getTime()+2000),completed=receipt(args,successAt.toISOString());
  const final=updateSiteState(failed,[{...completed,ptRecovery:claimed.recovery}],successAt,args.config);
  const site=final.sites[origin];assert.equal(site.pendingOpenCdAt,null);
  assert.equal(site.openCdRecoveryAttempts[0].state,'confirmed_current_day');
  assert.equal(site.openCdRecoveryAttempts[0].originalOutcome,'unknown');
  assert.equal(site.openCdSubmissionResolutions[0].kind,'current_day_confirmed');
  assert.equal(site.openCdSubmissionResolutions[0].originalOutcome,'unknown');
  const oldLatest={finishedAt:failedAt.toISOString(),results:[{...failure,observedAt:failedAt.toISOString()}]};
  assert.equal(pendingOpenCdSubmission(args.target,final,oldLatest,{now:new Date('2026-10-08T00:10:00Z')}),null);
});

test('invalid, old, future, wrong-profile and pre-intent negatives cannot authorize recovery',async t=>{
  const args=await fixture(t,{legacy:true}),base=receipt(args,args.now.toISOString(),'not_signed');
  for(const invalid of [{...base,accountKey:'secondary'},{...base,profileBinding:'b'.repeat(64)},
    receipt(args,new Date(args.now.getTime()-300001).toISOString(),'not_signed'),
    receipt(args,new Date(args.now.getTime()+1).toISOString(),'not_signed'),
    {...base,evidence:{...base.evidence,statusSignal:'generic_page_text'}},
    {...base,submissionOutcomeUnknown:true},{...base,observedAt:'invalid'}]){
    args.save(invalid);assert.equal((await claimPtUnsignedRecovery(args)).allowed,false);
  }
  args.save(base);
  const state={...args.state,sites:{[origin]:{...args.state.sites[origin],pendingOpenCdAt:args.now.toISOString()}}};
  fs.writeFileSync(args.file,JSON.stringify(state));
  assert.equal((await claimPtUnsignedRecovery({...args,state})).allowed,false);
  const tooEarly=boundPtObservation(args.root,args.target,args.config,{now:args.now,businessDate:'2026-10-07',
    statuses:['not_signed'],after:args.now.getTime()});assert.equal(tooEarly,null);
});

test('a later current passive completion closes the crashed current claim, not the old legacy history',async t=>{
  const args=await fixture(t,{legacy:true});args.save(receipt(args,args.now.toISOString(),'not_signed'));
  const claimed=await claimPtUnsignedRecovery(args),successAt=new Date(args.now.getTime()+1000);
  const final=updateSiteState(claimed.state,[{...receipt(args,successAt.toISOString()),ptRecovery:claimed.recovery}],successAt,args.config);
  assert.equal(final.sites[origin].openCdRecoveryAttempts[0].state,'confirmed_current_day');
  assert.equal(final.sites[origin].openCdRecoveryAttempts[0].originalPendingAt,pendingAt);
  assert.equal(final.sites[origin].openCdSubmissionResolutions[0].kind,'current_day_confirmed');
  assert.equal(pendingOpenCdSubmission(args.target,final,args.previousReport,{now:new Date('2026-10-08T00:10:00Z')}),null);
});

test('an interposed unknown submission forces a newer negative proof for the next recovery',async t=>{
  const args=await fixture(t,{legacy:true}),first=receipt(args,args.now.toISOString(),'not_signed');args.save(first);
  const claimed=await claimPtUnsignedRecovery(args);assert.equal(claimed.allowed,true);
  const unknownAt=new Date(args.now.getTime()+1000),unknown={origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:claimed.recovery};
  const afterUnknown=updateSiteState(claimed.state,[unknown],unknownAt,args.config);fs.writeFileSync(args.file,JSON.stringify(afterUnknown));
  const staleNegative={...first,observedAt:new Date(args.now.getTime()+500).toISOString(),evidence:{...first.evidence,
    confirmedAt:new Date(args.now.getTime()+500).toISOString()}};args.save(staleNegative);
  assert.equal((await claimPtUnsignedRecovery({...args,state:afterUnknown,now:new Date(args.now.getTime()+1500)})).allowed,false);
  const fresh={...first,observedAt:new Date(args.now.getTime()+1501).toISOString(),evidence:{...first.evidence,
    confirmedAt:new Date(args.now.getTime()+1501).toISOString()}};args.save(fresh);
  const next=await claimPtUnsignedRecovery({...args,state:afterUnknown,now:new Date(args.now.getTime()+2000)});
  assert.equal(next.allowed,true);assert.notEqual(next.recovery.claimId,claimed.recovery.claimId);
});

test('current recovery retains a bound original pending event for later historical receipt closure',async t=>{
  const args=await fixture(t),oldReceipt=receipt(args,'2026-10-06T05:30:40.854Z');
  // The current-day negative is only used to create a durable recovery claim.
  args.save(receipt(args,args.now.toISOString(),'not_signed'));
  const claimed=await claimPtUnsignedRecovery(args);assert.equal(claimed.allowed,true);
  const unknownAt=new Date(args.now.getTime()+1000),unknown={origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:claimed.recovery};
  const afterUnknown=updateSiteState(claimed.state,[unknown],unknownAt,args.config);fs.writeFileSync(args.file,JSON.stringify(afterUnknown));
  assert.equal(afterUnknown.sites[origin].openCdPendingHistory[0].pendingAt,pendingAt);
  args.save(oldReceipt);
  const reconciled=await reconcilePendingPtObservations({...args,state:afterUnknown,now:new Date('2026-10-07T01:00:00Z')});
  assert.equal(reconciled.changed,true);
  assert.equal(reconciled.state.sites[origin].openCdPendingHistory[0].status,'historical_confirmed');
  assert.equal(reconciled.state.sites[origin].pendingOpenCdAt,unknownAt.toISOString());
  assert.equal(reconciled.resolutions[0].businessDate,'2026-10-06');
});

test('secondary account completion and uncertainty never change the default OpenCD quarantine',async t=>{
  const args=await fixture(t);
  for(const result of [{...receipt(args,args.now.toISOString()),accountKey:'secondary'},
    {origin,accountKey:'secondary',profileBinding:'b'.repeat(64),status:'needs_attention',submissionAttempted:true,
      failureCode:'submission_outcome_unknown'}]){
    const state=updateSiteState(args.state,[result],args.now,args.config);
    assert.equal(state.sites[origin].pendingOpenCdAt,pendingAt);
    assert.equal(state.sites[origin].pendingOpenCdProfileBinding,args.binding.profileBinding);
    assert.equal(state.sites[origin].openCdSubmissionResolutions,undefined);
  }
});

test('same-day stale completion and malformed recovery timestamps cannot clear the guard',async t=>{
  const args=await fixture(t),sameDay='2026-10-07T01:00:00Z';
  const state={...args.state,sites:{[origin]:{...args.state.sites[origin],pendingOpenCdAt:sameDay,
    pendingOpenCdProfileBinding:args.binding.profileBinding,pendingOpenCdAccountKey:'site-default'}}};
  const stale=receipt(args,'2026-10-07T00:59:59Z');
  const afterStale=updateSiteState(state,[stale],new Date('2026-10-07T01:01:00Z'),args.config);
  assert.equal(afterStale.sites[origin].pendingOpenCdAt,sameDay);
  const malformed={...state,sites:{[origin]:{...state.sites[origin],openCdRecoveryAttempts:[{
    claimId:'bad',accountKey:'site-default',profileBinding:args.binding.profileBinding,businessDate:'2026-10-07',
    claimedAt:'invalid',proofConfirmedAt:'2026-10-07T01:00:00Z',state:'claimed'}]}}};
  const result={...receipt(args,'2026-10-07T01:02:00Z'),ptRecovery:{claimId:'bad'}};
  const afterMalformed=updateSiteState(malformed,[result],new Date('2026-10-07T01:03:00Z'),args.config);
  assert.equal(afterMalformed.sites[origin].pendingOpenCdAt,sameDay);
});

test('legacy same-day success records manual binding review and keeps the pending guard',async t=>{
  const args=await fixture(t,{legacy:true}),sameDay='2026-10-07T01:00:00Z';
  const state={...args.state,sites:{[origin]:{...args.state.sites[origin],pendingOpenCdAt:sameDay}}};
  const result=receipt(args,'2026-10-07T01:02:00Z');
  const next=updateSiteState(state,[result],new Date('2026-10-07T01:03:00Z'),args.config);
  assert.equal(next.sites[origin].pendingOpenCdAt,sameDay);
  assert.equal(next.sites[origin].openCdSubmissionResolutions[0].kind,'pending_manual_binding');
});

test('a rotated profile or secondary pending marker cannot be implicitly closed',async t=>{
  const args=await fixture(t),sameDay='2026-10-07T01:00:00Z';
  const rotated={...args.state,sites:{[origin]:{...args.state.sites[origin],pendingOpenCdAt:sameDay,
    pendingOpenCdProfileBinding:'a'.repeat(64),pendingOpenCdAccountKey:'site-default'}}};
  const rotatedResult={...receipt(args,'2026-10-07T01:02:00Z'),profileBinding:args.binding.profileBinding};
  const afterRotated=updateSiteState(rotated,[rotatedResult],new Date('2026-10-07T01:03:00Z'),args.config);
  assert.equal(afterRotated.sites[origin].pendingOpenCdAt,sameDay);
  const secondary={...rotated,sites:{[origin]:{...rotated.sites[origin],pendingOpenCdAccountKey:'secondary'}}};
  const afterSecondary=updateSiteState(secondary,[rotatedResult],new Date('2026-10-07T01:03:00Z'),args.config);
  assert.equal(afterSecondary.sites[origin].pendingOpenCdAt,sameDay);
});

test('one positive receipt closes at most one same-day pending event',async t=>{
  const args=await fixture(t),currentAt='2026-10-07T01:00:00Z',historyAt='2026-10-07T00:30:00Z';
  const state={...args.state,sites:{[origin]:{...args.state.sites[origin],pendingOpenCdAt:currentAt,
     pendingOpenCdProfileBinding:args.binding.profileBinding,pendingOpenCdAccountKey:'site-default',
     openCdPendingHistory:[{pendingAt:historyAt,profileBinding:args.binding.profileBinding,accountKey:'site-default',status:'superseded_by_new_attempt'}]}}};
  fs.writeFileSync(args.file,JSON.stringify(state));
  args.save(receipt(args,'2026-10-07T01:02:00Z'));
  const next=await reconcilePendingPtObservations({...args,state,now:new Date('2026-10-07T01:03:00Z')});
  assert.equal(next.changed,true);assert.equal(next.resolutions.length,1);
  assert.equal(next.state.sites[origin].openCdPendingHistory[0].status,'superseded_by_new_attempt');
});

test('positive reconcile closes the active current claim and does not leave a guard behind',async t=>{
  const args=await fixture(t,{legacy:true});
  args.save(receipt(args,args.now.toISOString(),'not_signed'));
  const claimed=await claimPtUnsignedRecovery(args);assert.equal(claimed.allowed,true);
  const unknownAt=new Date(args.now.getTime()+1000),unknown={origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:claimed.recovery};
  const afterUnknown=updateSiteState(claimed.state,[unknown],unknownAt,args.config);fs.writeFileSync(args.file,JSON.stringify(afterUnknown));
  const successAt=new Date(args.now.getTime()+2000);args.save(receipt(args,successAt.toISOString()));
  const reconciled=await reconcilePendingPtObservations({...args,state:afterUnknown,now:new Date(args.now.getTime()+3000)});
  assert.equal(reconciled.state.sites[origin].pendingOpenCdAt,null);
  assert.equal(reconciled.state.sites[origin].openCdRecoveryAttempts[0].state,'confirmed_current_day');
  assert.equal(pendingOpenCdSubmission(args.target,reconciled.state,args.previousReport,{now:new Date('2026-10-07T01:00:00Z')}),null);
});

test('a new business day supersedes the old active recovery before authorizing its own current claim',async t=>{
  const args=await fixture(t,{legacy:true});
  args.save(receipt(args,args.now.toISOString(),'not_signed'));
  const first=await claimPtUnsignedRecovery(args);assert.equal(first.allowed,true);
  const firstUnknownAt=new Date(args.now.getTime()+1000),firstUnknown={origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:first.recovery};
  const oldState=updateSiteState(first.state,[firstUnknown],firstUnknownAt,args.config);fs.writeFileSync(args.file,JSON.stringify(oldState));
  const nextDay=new Date('2026-10-08T00:12:00Z');args.save(receipt(args,'2026-10-08T00:11:00Z','not_signed'));
  assert.ok(freshPtUnsignedObservation(args.root,args.target,args.config,{now:nextDay,profileBinding:args.binding.profileBinding,
    after:Date.parse(oldState.sites[origin].pendingOpenCdAt)}));
  const second=await claimPtUnsignedRecovery({...args,state:oldState,now:nextDay});assert.equal(second.allowed,true);
  assert.equal(second.state.sites[origin].openCdRecoveryAttempts[0].state,'superseded_for_new_business_day');
  const secondUnknownAt=new Date(nextDay.getTime()+1000),secondUnknown={origin,accountKey:'site-default',profileBinding:args.binding.profileBinding,
    status:'needs_attention',failureCode:'submission_outcome_unknown',submissionAttempted:true,ptRecovery:second.recovery};
  const secondState=updateSiteState(second.state,[secondUnknown],secondUnknownAt,args.config);
  const completed=receipt(args,'2026-10-08T00:14:00Z');
  const final=updateSiteState(secondState,[{...completed,ptRecovery:second.recovery}],new Date('2026-10-08T00:15:00Z'),args.config);
  assert.equal(final.sites[origin].openCdRecoveryAttempts[0].state,'superseded_for_new_business_day');
  assert.equal(final.sites[origin].openCdRecoveryAttempts[1].state,'confirmed_current_day');
  assert.equal(final.sites[origin].openCdSubmissionResolutions.at(-1).businessDate,'2026-10-08');
});
