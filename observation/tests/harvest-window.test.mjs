import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHarvestWindow,siteHarvestWait,waitingTask,harvestNotificationSyncPending} from '../public/harvest-window.mjs';
import {buildPtStatus} from '../src/pt-status.mjs';
import {authorizedWorkload} from '../src/workload-view.mjs';
import {overviewMetrics,overviewResultCounts,dailySummaryTitle} from '../public/overview-model.mjs';
import {matchesTask} from '../public/dashboard-model.mjs';
import {calendarPtSummaries,dailyRecords,dayTotals} from '../public/calendar-model.mjs';
import {pendingNotices} from '../public/notice-state.mjs';

const at='2026-10-27T00:45:00Z',now=Date.parse(at),day='2026-10-27';
const report=()=>({schemaVersion:1,source:'harvest',businessDate:day,generatedAt:at,checkinInventoryComplete:true,
  taskSchedule:{businessDate:day,scheduledAt:day+'T01:05:00Z'},taskCompletion:null,sites:[
    {origin:'https://waiting.example',checkinEnabled:true,status:'unknown',observedAt:null},
    {origin:'https://independent.example',checkinEnabled:false,status:'unknown',observedAt:null},
    {origin:'https://failed.example',checkinEnabled:true,status:'failed',observedAt:at,evidence:{source:'harvest',authoritative:false}}]});
function fixture(input=report()){
  const catalog={sites:input.sites.map(site=>({origin:site.origin,entryUrl:site.origin+'/attendance.php'}))};
  return buildPtStatus({externalReport:input,monitorCatalog:catalog,fallbackOnlyEnabled:true,businessDate:day,generatedAt:at});
}

test('a scheduled Harvest-only unknown is waiting while independent and explicitly failed sites remain actionable',()=>{
  const ptStatus=fixture(),before=JSON.stringify(ptStatus),view=authorizedWorkload({tasks:[],ptStatus,businessDate:day,now});
  const data={...view,businessDate:day,generatedAt:at};
  assert.deepEqual(overviewResultCounts(data,now),{verified:0,proof:0,actionable:2,waiting:1,excluded:0});
  assert.equal(overviewMetrics(data,now).eligible,3);assert.equal(overviewMetrics(data,now).rate,0);
  assert.equal(overviewMetrics(data,now).allResolved,false);assert.match(dailySummaryTitle(overviewMetrics(data,now)),/1 项等待 Harvest/);
  assert.equal(view.tasks.filter(task=>matchesTask(task,{status:'waiting',now})).length,1);
  assert.equal(view.tasks.filter(task=>matchesTask(task,{status:'actionable',now})).length,2);
  assert.equal(pendingNotices(view.tasks,now).length,2);
  assert.equal(JSON.stringify(ptStatus),before);
});

test('daily verdict keeps Harvest waiting inside verifying with matching cards and task filters',()=>{
  const view=authorizedWorkload({tasks:[],ptStatus:fixture(),businessDate:day,now});
  const tasks=view.tasks.filter(task=>task.origin!=='https://failed.example').map(task=>({...task,dayClass:'verifying'}));
  const data={counts:{executionUnits:2},tasks,businessDate:day,generatedAt:at,
    dayVerdict:{total:2,settled:false,counts:{done:0,verifying:2,actionNeeded:0,external:0,paused:0,noFeature:0}}};
  const original=JSON.stringify(data),metrics=overviewMetrics(data,now),counts=overviewResultCounts(data,now);
  assert.equal(metrics.waiting,1);assert.equal(metrics.pending,2);assert.equal(metrics.eligible,2);
  assert.deepEqual(counts,{verified:0,proof:1,actionable:0,waiting:1,excluded:0});
  assert.equal(counts.proof+counts.waiting,data.dayVerdict.counts.verifying);
  assert.equal(dailySummaryTitle(metrics),'1 项等待 Harvest · 1 项核验中');
  assert.equal(dailySummaryTitle({...metrics,verdict:{...data.dayVerdict,counts:{...data.dayVerdict.counts,actionNeeded:1}}}),
    '1 项需要处理 · 1 项等待 Harvest · 1 项核验中');
  for(const kind of ['proof','waiting','actionable']){
    assert.equal(tasks.filter(task=>matchesTask(task,{status:kind,now})).length,counts[kind]);
  }
  const later=Date.parse(day+'T01:35:00Z');
  assert.deepEqual(overviewResultCounts(data,later),{verified:0,proof:2,actionable:0,waiting:0,excluded:0});
  assert.equal(tasks.filter(task=>matchesTask(task,{status:'waiting',now:later})).length,0);
  assert.equal(tasks.filter(task=>matchesTask(task,{status:'proof',now:later})).length,2);
  for(const dayClass of ['done','actionNeeded','external','paused','noFeature']){
    assert.equal(matchesTask({...tasks.find(task=>task.waiting),dayClass},{status:'waiting',now}),false);
  }
  assert.equal(JSON.stringify(data),original);
});

test('the waiting window ends after the scheduled start grace period and never becomes a success or a write permission',()=>{
  const pt=fixture(),site=pt.sites.find(s=>s.origin==='https://waiting.example'),window=pt.harvestWindow;
  const later={...window,observedAt:day+'T01:30:00Z'};
  assert.ok(siteHarvestWait(site,later,Date.parse(day+'T01:34:59Z')));
  assert.equal(siteHarvestWait(site,later,Date.parse(day+'T01:35:00Z')),null);
  assert.equal(site.effective.status,'unknown');assert.equal(site.effective.authoritative,false);
  assert.equal(later.executable,undefined);
});

test('current active work gets a bounded run window; completed or failed Harvest never hides unresolved sites',()=>{
  const r=report();r.generatedAt=day+'T01:15:00Z';r.taskCompletion={status:'running',resultId:7,activeTaskCount:1,startedAt:day+'T01:12:00Z'};
  const window=projectHarvestWindow(r,Date.parse(r.generatedAt)),site=fixture().sites.find(s=>s.origin==='https://waiting.example');
  assert.equal(window.phase,'running');assert.ok(siteHarvestWait(site,window,Date.parse(r.generatedAt)));
  assert.equal(siteHarvestWait(site,{...window,observedAt:day+'T01:40:00Z'},Date.parse(day+'T01:43:00Z')),null);
  for(const status of ['completed','failed']){r.taskCompletion.status=status;assert.equal(projectHarvestWindow(r,Date.parse(r.generatedAt)),null);}
});

test('stale, foreign-day, future, disabled, ambiguous, unowned and submitted states cannot suppress attention',()=>{
  const pt=fixture(),base=pt.sites.find(s=>s.origin==='https://waiting.example');
  for(const kind of ['stale','future','date','disabled','conflict','unowned','submitted','login','unsigned','failure','uncertain']){
    const site=structuredClone(base),window=structuredClone(pt.harvestWindow);
    if(kind==='stale')window.observedAt=day+'T00:00:00Z';
    if(kind==='future')window.observedAt=day+'T01:00:00Z';
    if(kind==='date')window.businessDate='2026-10-26';
    if(kind==='disabled')site.disabledByConfig=true;
    if(kind==='conflict')site.discrepancy=true;
    if(kind==='unowned')site.harvestManaged=false;
    if(kind==='submitted')site.effective.submissionAttempted=true;
    if(kind==='login')site.effective.status='login_required';
    if(kind==='unsigned')site.effective.status='not_signed';
    if(kind==='failure')site.effective.failureCode='network_error';
    if(kind==='uncertain')site.recovery={code:'submission_outcome_unknown'};
    assert.equal(siteHarvestWait(site,window,now),null,kind);
  }
});

test('registered legacy uncertainty is never hidden and missing verified schedule remains visible',()=>{
  const pt=fixture(),site=pt.sites.find(s=>s.origin==='https://waiting.example');site.inLegacyPlan=true;
  assert.equal(siteHarvestWait(site,pt.harvestWindow,now),null);
  const r=report();delete r.taskSchedule;assert.equal(projectHarvestWindow(r,now),null);
  r.taskSchedule=report().taskSchedule;r.schemaVersion=2;assert.equal(projectHarvestWindow(r,now),null);
  const task=authorizedWorkload({ptStatus:fixture(),businessDate:day,now}).tasks.find(t=>t.origin==='https://waiting.example');
  assert.equal(waitingTask(task,now),true);
  assert.equal(waitingTask(task,Date.parse('2026-10-28T00:01:00Z')),false);
});

test('calendar waiting is separate from pending and expires as a historical unconfirmed record',()=>{
  const pt=fixture(),summaries=calendarPtSummaries(pt,now);
  const entry=dailyRecords({ledger:[{businessDate:day,recordedAt:at,taskSummaries:[],ptSummaries:summaries}],now}).get(day);
  const totals=dayTotals(entry,now);assert.equal(totals.waiting,1);assert.equal(totals.pending,2);assert.equal(totals.completed,0);
  const later=dayTotals(entry,Date.parse('2026-10-28T00:01:00Z'));
  assert.equal(later.waiting,0);assert.equal(later.pending,3);
});

test('deadline crossing requires a newer observation, with a bounded publication handoff rather than new site failures',()=>{
  const r=report();r.generatedAt=day+'T01:10:00Z';
  const pt=fixture(r),deadline=Date.parse(day+'T01:35:00Z');
  assert.equal(harvestNotificationSyncPending(pt,deadline-1),null);
  const pending=harvestNotificationSyncPending(pt,deadline);
  assert.deepEqual(pending.origins,['https://waiting.example']);assert.equal(pending.overdue,false);
  assert.equal(harvestNotificationSyncPending(pt,deadline+5*60000).overdue,true);
  // Display/execution waiting has still expired; a notification handoff does
  // not extend the Harvest deadline or erase independent/failed tasks.
  assert.equal(siteHarvestWait(pt.sites[0],pt.harvestWindow,deadline),null);
  r.generatedAt=day+'T01:36:00Z';assert.equal(harvestNotificationSyncPending(fixture(r),deadline+60000),null);
  assert.equal(harvestNotificationSyncPending(pt,Date.parse('2026-10-28T01:35:00Z')),null);
  const broken=structuredClone(pt);broken.harvestWindow.deadlineAt=day+'T02:35:00Z';
  assert.equal(harvestNotificationSyncPending(broken,deadline+60000),null);
  const running=structuredClone(pt);running.harvestWindow.phase='running';
  assert.equal(harvestNotificationSyncPending(running,deadline).origins.length,1);
});
