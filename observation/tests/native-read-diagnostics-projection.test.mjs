import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {buildSnapshot} from '../src/bridge.mjs';
import {projectPtDiagnostic,projectPtSiteResult} from '../src/pt-site-execution.mjs';

test('private native read details cannot enter PT results or dashboard/NAS snapshots through either import path',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'read-projection-fixture-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const dir of ['data','logs/fixture'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  const origin='https://tracker.example',observedAt='2026-11-01T04:00:00.000Z';
  const details={inspectionPresent:true,securityVerification:false,signedControlCount:0,unsignedControlCount:0,
    dailyTextPresent:true,dailyControlCandidateCount:4,audiencesDailyHeaderVerified:false,pathClass:'index',apiStage:'daily_fields',httpStatus:200};
  const value={origin,status:'unknown',failureCode:'authoritative_status_unavailable',observedAt,
    submissionAttempted:false,...details,nativeReadback:{stage:'readback',code:'readback_inconclusive',...details},
    inspection:{bodyText:'PRIVATE_PAGE_MARKER',...details},evidence:{source:'none',authoritative:false}};
  const withoutDetails={origin,status:value.status,failureCode:value.failureCode,observedAt,submissionAttempted:false,evidence:value.evidence};
  assert.deepEqual(projectPtSiteResult(value,origin),projectPtSiteResult(withoutDetails,origin));
  assert.deepEqual(projectPtDiagnostic(value),projectPtDiagnostic(withoutDetails));
  const save=(file,entry)=>fs.writeFileSync(path.join(root,file),JSON.stringify(entry));
  save('data/scheduler-state.json',{lastRunId:'fixture',lastRunDate:'2026-11-01'});
  save('data/last-valid-bookmark-plan.json',{generatedAt:observedAt,sources:[],targets:[{origin,title:'Synthetic',folderNames:['PT']}]});
  save('health.json',{healthy:true,checkedAt:observedAt,failedChecks:[]});
  const report={runId:'fixture',finishedAt:observedAt,executionComplete:true,businessComplete:false};
  save('logs/fixture/result.json',{...report,results:[value]});
  const actual=buildSnapshot({legacyRoot:root,generatedAt:observedAt});
  save('logs/fixture/result.json',{...report,results:[withoutDetails]});
  assert.deepEqual(actual,buildSnapshot({legacyRoot:root,generatedAt:observedAt}));
  for(const key of [...Object.keys(details),'nativeReadback','inspection','PRIVATE_PAGE_MARKER'])
    assert.equal(JSON.stringify(actual).includes(key),false,key);
});
