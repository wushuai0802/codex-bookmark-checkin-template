import test from 'node:test';
import assert from 'node:assert/strict';
import {authorizedWorkload} from '../src/workload-view.mjs';
import {overviewMetrics,overviewResultCounts,dailySummaryTitle} from '../public/overview-model.mjs';
import {matchesTask} from '../public/dashboard-model.mjs';
import {operationTargets} from '../src/dashboard-operations.mjs';
const day='2026-10-25',now=new Date(day+'T04:00:00Z');
const regular={taskId:'daily',origin:'https://regular.example',accountRef:null,observedStatus:'signed',evidence:{authoritative:true}};
function site(origin='https://www.uhddolby.com',status='not_signed'){
  return {origin,displayName:'PT',inLegacyPlan:false,fallbackEnabled:true,effective:{status,observedAt:now.toISOString(),fresh:true,authoritative:true,
    evidence:{source:'pt_page',authoritative:true,businessDate:day,confirmedAt:now.toISOString(),summary:'fixture'}}};
}
function project(sites,tasks=[regular]){
  const ptStatus={businessDate:day,sites},input={tasks,ptStatus,businessDate:day,counts:{logicalSites:tasks.length,executionUnits:tasks.length}};
  const before=JSON.stringify(input),workload=authorizedWorkload(input);assert.equal(JSON.stringify(input),before);
  return {...workload,businessDate:day,generatedAt:now.toISOString(),ptStatus};
}

test('an authorized PT-only pending site enters the same headline, metric and drill-down task set',()=>{
  const value=project([site()]),metrics=overviewMetrics(value,now.getTime()),counts=overviewResultCounts(value,now.getTime());
  assert.equal(metrics.rate,50);assert.equal(counts.actionable,1);assert.equal(metrics.allResolved,false);
  assert.match(dailySummaryTitle(metrics),/1/);assert.equal(value.tasks.filter(task=>matchesTask(task,{status:'actionable'})).length,1);
  assert.equal(value.planCounts.executionUnits,1);assert.equal(value.counts.executionUnits,2);
  assert.equal(operationTargets(value).find(t=>t.origin==='https://www.uhddolby.com').actions.retry,true);
});

test('daily PT overlap is not duplicated and pure monitoring is not silently authorized',()=>{
  const duplicate={...site(regular.origin,'already_signed'),inLegacyPlan:true},monitor={...site('https://monitor.example'),fallbackEnabled:false};
  const value=project([duplicate,monitor,site('https://cspt.top','signed')]);
  assert.equal(value.tasks.length,2);assert.equal(value.supplementTaskCount,1);assert.equal(overviewMetrics(value,now.getTime()).rate,100);
});

test('paused and external PT sites remain excluded while a local failure stays actionable',()=>{
  const paused={...site('https://paused.example'),fallbackEnabled:false,disabledByConfig:true};
  const external=site('https://external.example','unknown');external.effective.failureCode='site_server_error';
  const value=project([paused,external,site()]),metrics=overviewMetrics(value,now.getTime());
  assert.equal(metrics.cancelled,1);assert.equal(metrics.excludedSiteIssues,1);assert.equal(metrics.rate,50);
  assert.equal(overviewResultCounts(value,now.getTime()).actionable,1);
  assert.equal(operationTargets(value).find(t=>t.origin===paused.origin).actions.verify,false);
});

test('stale, conflicting and unverified PT reports cannot inflate completed work',()=>{
  for(const change of [{fresh:false},{authoritative:false,evidence:{authoritative:false}}]){
    const item=site(undefined,'signed');Object.assign(item.effective,change);
    const m=overviewMetrics(project([item]),now.getTime());assert.equal(m.verifiedSuccess,1);assert.equal(m.allResolved,false);
  }
  const conflict=site(regular.origin,'not_signed');conflict.inLegacyPlan=true;conflict.discrepancy=true;
  const value=project([conflict]);assert.equal(value.tasks.length,1);assert.equal(overviewMetrics(value,now.getTime()).verifiedSuccess,0);
});

test('PT-only auth failures retain the reason needed for a manual login action',()=>{
  const factor=site(undefined,'needs_attention');factor.effective.failureCode='two_factor_required';factor.effective.authoritative=false;
  const target=operationTargets({tasks:[],ptStatus:{sites:[factor]}})[0];assert.equal(target.actions.login,true);assert.equal(target.actions.retry,false);
  factor.effective.failureCode='submission_outcome_unknown';assert.equal(operationTargets({tasks:[],ptStatus:{sites:[factor]}})[0].actions.login,false);
});
