import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishEngineReport} from '../src/legacy-engine.mjs';
import {readLedger} from '../src/shadow-ledger.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'engine-publication-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const legacyRoot=path.join(root,'legacy');
  fs.cpSync(fileURLToPath(new URL('./fixtures/legacy/',import.meta.url)),legacyRoot,{recursive:true});
  const latest=JSON.parse(fs.readFileSync(path.join(legacyRoot,'logs/fixture-run-20260902/result.json'),'utf8'));
  latest.runId='20260930-fixture';latest.finishedAt='2026-09-30T02:00:00Z';
  latest.results[0]={...latest.results[0],status:'signed',evidence:{source:'page_text',authoritative:true,confirmedAt:latest.finishedAt,businessDate:'2026-09-30'}};
  fs.writeFileSync(path.join(legacyRoot,'logs/latest.json'),JSON.stringify(latest));
  return {root,legacyRoot,latest};
}
test('engine publishes matching snapshot and ledger with dated redacted evidence',t=>{
  const f=fixture(t);const report=publishEngineReport({...f,now:new Date('2026-09-30T02:00:30Z')});
  const snapshot=JSON.parse(fs.readFileSync(path.join(f.root,'outputs/shadow-beta-snapshot.json'),'utf8'));
  const ledger=readLedger(path.join(f.root,'outputs/shadow-ledger.jsonl'));
  assert.equal(ledger.at(-1).snapshotId,snapshot.snapshotId);assert.equal(ledger.at(-1).planHash,snapshot.planHash);
  assert.equal(report.results[0].evidence.authoritative,true);assert.equal(report.results[0].evidence.businessDate,'2026-09-30');
});
test('cross-midnight final receipt is retained without replacing the dashboard generation',t=>{
  const f=fixture(t);f.latest.runId='20260929-fixture';f.latest.finishedAt='2026-09-29T16:00:20Z';
  fs.writeFileSync(path.join(f.legacyRoot,'logs/latest.json'),JSON.stringify(f.latest));
  const report=publishEngineReport({...f,requireFreshSince:'2026-09-29T15:59:00Z',now:new Date('2026-09-29T16:01:00Z')});
  assert.equal(report.completedCrossDay,true);assert.equal(report.businessComplete,false);
  assert.equal(fs.existsSync(path.join(f.root,'outputs/engine-latest.json')),true);
  assert.equal(fs.existsSync(path.join(f.root,'outputs/shadow-beta-snapshot.json')),false);
});

test('explicit cancellation stays terminal and distinct across engine, snapshot, and ledger',t=>{
  const f=fixture(t),at=f.latest.finishedAt;
  f.latest.isComplete=true;
  f.latest.results=f.latest.results.map((result,index)=>({...result,status:index===0?'not_available':'signed',
    ...(index===0?{availabilityKind:'task_disabled',disabledByConfig:true,reason:'已按配置取消该站签到任务'}:{}),
    evidence:{source:index===0?'configuration':'page_text',authoritative:true,confirmedAt:at}}));
  fs.writeFileSync(path.join(f.legacyRoot,'logs/latest.json'),JSON.stringify(f.latest));
  const report=publishEngineReport({...f,now:new Date('2026-09-30T02:00:30Z')});
  assert.deepEqual(report.counts,{completed:f.latest.results.length-1,unavailable:0,cancelled:1,unresolved:0});
  assert.equal(report.businessComplete,true);assert.equal(report.results[0].status,'not_available');
  const snapshot=JSON.parse(fs.readFileSync(path.join(f.root,'outputs/shadow-beta-snapshot.json'),'utf8'));
  const task=snapshot.tasks.find(item=>item.condition==='task_disabled');
  assert.ok(task);assert.equal(task.observedStatus,'not_available');
  assert.equal(snapshot.evidenceQuality.cancelled,1);assert.equal(snapshot.evidenceQuality.unverifiedUnavailable,0);
  const ledger=readLedger(path.join(f.root,'outputs/shadow-ledger.jsonl')).at(-1);
  const archived=ledger.taskSummaries.find(item=>item.taskId===task.taskId);
  assert.equal(archived.condition,'task_disabled');assert.equal(archived.evidence.verification,'task_disabled');
});
