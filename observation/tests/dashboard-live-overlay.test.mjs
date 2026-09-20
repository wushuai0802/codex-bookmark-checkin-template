import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardServer} from '../src/dashboard-server.mjs';

test('dashboard overview overlays a successful V2 result onto snapshot task ownership and status',async()=>{
  const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-live-overlay-'));const id='task_cccccccccccccccccccccccc';
  fs.writeFileSync(path.join(root,'shadow-beta-snapshot.json'),JSON.stringify({snapshotId:'snap_aaaaaaaaaaaaaaaaaaaaaaaa',generatedAt:'2026-09-16T00:00:00Z',businessDate:'2026-09-16',mode:'shadow_read_only',planHash:'a'.repeat(64),counts:{logicalSites:1,executionUnits:1,status:{not_started:1}},tasks:[{taskId:id,planUnitId:'unit_aaaaaaaaaaaaaaaaaaaaaaaa',businessDate:'2026-09-16',origin:'https://fixture.example',logicalSiteKey:'https://fixture.example',accountRef:'acct_aaaaaaaaaaaaaaaa',displayName:'Fixture',identity:{userId:'7',source:'configuration'},actionType:'checkin',scheduleOccurrence:'daily',executionOwner:'legacy-checkin',executionMode:'observe_only',observedStatus:'not_started'}],health:{healthy:true,sourceCheckedAt:'2026-09-16T00:00:00Z',freshness:{maxAgeHours:26}},source:{executionComplete:false}}));
  fs.writeFileSync(path.join(root,`canary-result-acct-2026-09-16.json`),JSON.stringify({taskId:id,accountKey:'acct',origin:'https://fixture.example',businessDate:'2026-09-16',mode:'canary_execute',stage:'succeeded',phase:'succeeded',mutationCount:1,evidence:{source:'new_api_checkin_calendar',authoritative:true,summary:''},completedAt:'2026-09-16T00:01:00Z'}));
  const instance=createDashboardServer({dataDir:root,bind:'127.0.0.1',port:0});await new Promise(resolve=>instance.server.listen(0,resolve));const address=instance.server.address();
  try{const body=await (await fetch(`http://127.0.0.1:${address.port}/api/overview`)).json();assert.equal(body.status.signed,1);assert.equal(body.tasks[0].executionOwner,'v2-worker');assert.equal(body.tasks[0].observedStatus,'signed');}finally{await new Promise(resolve=>instance.server.close(resolve));}
});
