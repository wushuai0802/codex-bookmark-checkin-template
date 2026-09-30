import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSnapshot,writeSnapshot} from '../src/bridge.mjs';
import {createLedgerRecord,appendLedgerRecord} from '../src/shadow-ledger.mjs';
import {commitDashboardGeneration,readDashboardGeneration,createDashboardGenerationReader} from '../src/dashboard-generation.mjs';
const legacyRoot=fileURLToPath(new URL('./fixtures/legacy/',import.meta.url));
test('generation commit pins the snapshot and ledger prefix; restart can recover previous publication',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'paired-generation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const snapshotFile=path.join(root,'shadow-beta-snapshot.json'),ledgerFile=path.join(root,'shadow-ledger.jsonl');
  const first=buildSnapshot({legacyRoot,generatedAt:'2026-09-02T14:00:00Z'});
  const second=buildSnapshot({legacyRoot,generatedAt:'2026-09-03T14:00:00Z'});
  const append=snapshot=>appendLedgerRecord(ledgerFile,createLedgerRecord(snapshot,{recordedAt:snapshot.generatedAt}),{legacyRoot});
  append(first);writeSnapshot(first,snapshotFile,legacyRoot);commitDashboardGeneration({snapshot:first,snapshotFile,ledgerFile});
  append(second);writeSnapshot(second,snapshotFile,legacyRoot);
  assert.equal(readDashboardGeneration(root).current.snapshot.snapshotId,first.snapshotId);
  assert.equal(readDashboardGeneration(root).ledger.records.length,1);
  commitDashboardGeneration({snapshot:second,snapshotFile,ledgerFile});
  assert.equal(readDashboardGeneration(root).current.snapshot.snapshotId,second.snapshotId);
  fs.writeFileSync(path.join(root,'dashboard-generation.json'),'{');
  const recovered=readDashboardGeneration(root);assert.equal(recovered.stale,true);
  assert.equal(recovered.current.snapshot.snapshotId,first.snapshotId);assert.equal(recovered.ledger.records.length,1);
  fs.appendFileSync(ledgerFile,'truncated JSON');
  assert.equal(readDashboardGeneration(root).current.snapshot.snapshotId,first.snapshotId);
  fs.writeFileSync(ledgerFile,'{}');
  assert.throws(()=>readDashboardGeneration(root),/no complete/);
});

test('generation cache is invalidated by publication or ledger changes and cannot be mutated by a reader',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'generation-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const snapshotFile=path.join(root,'shadow-beta-snapshot.json'),ledgerFile=path.join(root,'shadow-ledger.jsonl');
  const first=buildSnapshot({legacyRoot,generatedAt:'2026-09-02T14:00:00Z'});
  appendLedgerRecord(ledgerFile,createLedgerRecord(first,{recordedAt:first.generatedAt}),{legacyRoot});
  writeSnapshot(first,snapshotFile,legacyRoot);commitDashboardGeneration({snapshot:first,snapshotFile,ledgerFile});
  let reads=0;const read=createDashboardGenerationReader({read:directory=>{reads++;return readDashboardGeneration(directory);}});
  const value=read(root);value.current.snapshot.businessDate='1999-01-01';
  assert.equal(read(root).current.snapshot.businessDate,'2026-09-02');assert.equal(reads,1);
  fs.appendFileSync(ledgerFile,'\n');assert.equal(read(root).ledger.records.length,1);assert.equal(reads,2);
  fs.writeFileSync(ledgerFile,'{}');assert.throws(()=>read(root),/no complete/);assert.equal(reads,3);
});

test('a later concurrent receipt cannot make the calendar newer than the committed snapshot',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'generation-concurrent-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const snapshotFile=path.join(root,'shadow-beta-snapshot.json'),ledgerFile=path.join(root,'shadow-ledger.jsonl');
  const first=buildSnapshot({legacyRoot,generatedAt:'2026-09-02T14:00:00Z'}),second=buildSnapshot({legacyRoot,generatedAt:'2026-09-03T14:00:00Z'});
  for(const snapshot of [first,second])appendLedgerRecord(ledgerFile,createLedgerRecord(snapshot,{recordedAt:snapshot.generatedAt}),{legacyRoot});
  writeSnapshot(first,snapshotFile,legacyRoot);commitDashboardGeneration({snapshot:first,snapshotFile,ledgerFile});
  const generation=readDashboardGeneration(root);assert.equal(generation.ledger.records.length,1);
  assert.equal(generation.ledger.records[0].snapshotId,generation.current.snapshot.snapshotId);
});
