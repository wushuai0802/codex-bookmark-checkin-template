import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardServer} from '../src/dashboard-server.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {taskStatusLabel,taskStatusSummary,matchesTask} from '../public/dashboard-model.mjs';

test('live task APIs show current maintenance after midnight while keeping the original uncertain execution and operation guards',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-maintenance-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const current=new Date(),today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(current);
  const yesterday=new Date(Date.parse(today+'T00:00:00Z')-86_400_000).toISOString().slice(0,10);
  const origin='https://fixture.example',taskId='task_cccccccccccccccccccccccc',observedAt=current.toISOString();
  const task={taskId,businessDate:yesterday,origin,logicalSiteKey:origin,observedStatus:'needs_attention',
    condition:'submission_outcome_unknown',failureCode:'submission_outcome_unknown',submissionAttempted:true};
  const receipt={taskId,status:'needs_attention',observedAt:yesterday+'T14:00:00Z',
    evidence:{source:'none',authoritative:false,verification:'submission_outcome_unknown',summary:'签到动作已发出但结果未确认'}};
  const snapshot={snapshotId:'snap_aaaaaaaaaaaaaaaaaaaaaaaa',generatedAt:observedAt,businessDate:yesterday,mode:'shadow_read_only',
    planHash:'a'.repeat(64),counts:{logicalSites:1,executionUnits:1,status:{needs_attention:1}},tasks:[task],receipts:[receipt],
    ptStatus:{businessDate:today,generatedAt:observedAt,sites:[{origin,effective:{source:'execution-supplement',status:'needs_attention',
      siteCondition:'site_maintenance',fresh:true,observedAt,authoritative:false,
      evidence:{source:'page_text',authoritative:false,summary:'站点公告正在维护，等待恢复'}}}]}};
  const file=path.join(root,'shadow-beta-snapshot.json'),save=()=>fs.writeFileSync(file,JSON.stringify(snapshot));save();
  const instance=createDashboardServer({dataDir:root,bind:'127.0.0.1',port:0});await new Promise(resolve=>instance.server.listen(0,resolve));
  t.after(()=>new Promise(resolve=>instance.server.close(resolve)));
  const base='http://127.0.0.1:'+instance.server.address().port;
  for(const endpoint of ['/api/overview','/api/tasks']){
    const before=fs.readFileSync(file,'utf8');
    const body=await(await fetch(base+endpoint)).json(),shown=body.tasks[0];
    assert.equal(taskStatusLabel(shown),'站点维护');assert.match(taskStatusSummary(shown),/维护/);
    assert.equal(shown.businessDate,yesterday);assert.equal(shown.observedStatus,'needs_attention');
    assert.equal(shown.condition,'submission_outcome_unknown');assert.equal(shown.failureCode,'submission_outcome_unknown');
    assert.equal(shown.submissionAttempted,true);assert.equal(shown.evidence.authoritative,false);
    assert.equal(shown.evidence.summary,receipt.evidence.summary);assert.equal(shown.availability.businessDate,today);
    assert.equal(matchesTask(shown,{status:'external'}),true);assert.equal(matchesTask(shown,{status:'verification'}),false);
    assert.equal(fs.readFileSync(file,'utf8'),before);
    if(body.operationTargets){assert.equal(body.operationTargets[0].actions.retry,false);assert.equal(body.operationTargets[0].actions.login,false);}
  }
  const apiTask=async()=>(await(await fetch(base+'/api/tasks')).json()).tasks[0];
  for(const [status,total] of [['external',1],['verification',0],['attention',0],['pending',1],['needs_attention',1],['constructor',0]]){
    const response=await fetch(base+'/api/tasks?status='+status);
    assert.equal(response.status,200);assert.equal((await response.json()).total,total);
  }
  snapshot.ptStatus.sites[0].effective.observedAt=yesterday+'T14:00:00Z';save();
  assert.equal((await apiTask()).availability,undefined);
  snapshot.ptStatus.sites[0].effective.observedAt=new Date(current.getTime()+120_000).toISOString();save();
  assert.equal((await apiTask()).availability,undefined);
  snapshot.ptStatus.sites[0].effective.observedAt=observedAt;
  snapshot.ptStatus.sites[0].origin='https://other.example';save();
  assert.equal((await apiTask()).availability,undefined);
  snapshot.ptStatus.sites[0].origin=origin;
  for(const status of ['signed','already_signed','not_available']){
    snapshot.tasks[0].observedStatus=status;save();assert.equal((await apiTask()).availability,undefined);
  }
});

test('dashboard overview overlays a successful V2 result onto snapshot task ownership and status',async()=>{
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-live-overlay-'));const id='task_cccccccccccccccccccccccc';
  fs.writeFileSync(path.join(root,'shadow-beta-snapshot.json'),JSON.stringify({snapshotId:'snap_aaaaaaaaaaaaaaaaaaaaaaaa',generatedAt:'2026-09-16T00:00:00Z',businessDate:'2026-09-16',mode:'shadow_read_only',planHash:'a'.repeat(64),counts:{logicalSites:1,executionUnits:1,status:{not_started:1}},tasks:[{taskId:id,planUnitId:'unit_aaaaaaaaaaaaaaaaaaaaaaaa',businessDate:'2026-09-16',origin:'https://fixture.example',logicalSiteKey:'https://fixture.example',accountRef:'acct_aaaaaaaaaaaaaaaa',displayName:'Fixture',identity:{userId:'7',source:'configuration'},actionType:'checkin',scheduleOccurrence:'daily',executionOwner:'legacy-checkin',executionMode:'observe_only',observedStatus:'not_started'}],health:{healthy:true,sourceCheckedAt:'2026-09-16T00:00:00Z',freshness:{maxAgeHours:26}},source:{executionComplete:false}}));
  fs.writeFileSync(path.join(root,`canary-result-acct-2026-09-16.json`),JSON.stringify({taskId:id,accountKey:'acct',origin:'https://fixture.example',businessDate:'2026-09-16',mode:'canary_execute',stage:'succeeded',phase:'succeeded',mutationCount:1,evidence:{source:'new_api_checkin_calendar',authoritative:true,summary:''},completedAt:'2026-09-16T00:01:00Z'}));
  const instance=createDashboardServer({dataDir:root,bind:'127.0.0.1',port:0});await new Promise(resolve=>instance.server.listen(0,resolve));const address=instance.server.address();
  try{const body=await (await fetch(`http://127.0.0.1:${address.port}/api/overview`)).json();assert.equal(body.status.signed,1);assert.equal(body.tasks[0].executionOwner,'v2-worker');assert.equal(body.tasks[0].observedStatus,'signed');}finally{await new Promise(resolve=>instance.server.close(resolve));}
});
