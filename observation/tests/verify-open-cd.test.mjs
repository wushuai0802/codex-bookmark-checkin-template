import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recordReadOnlyOpenCd} from '../scripts/verify-open-cd.mjs';

test('only a same-day read-only OpenCD receipt enters the separate PT report',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'open-cd-verification-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const now=new Date('2026-09-29T00:46:00Z');
  const result={origin:'https://open.cd',status:'already_signed',observedAt:now.toISOString(),
    operationMode:'safe_history_page',readSafety:'reviewed_passive',submissionAttempted:false,
    profileBinding:'a'.repeat(64),accountKey:'site-default',businessDate:'2026-09-29',
    evidence:{source:'pt_page',authoritative:true,businessDate:'2026-09-29',confirmedAt:now.toISOString(),summary:'site control confirmed'}};
  assert.throws(()=>recordReadOnlyOpenCd(root,{...result,submissionAttempted:true},now),/not authoritative/);
  assert.throws(()=>recordReadOnlyOpenCd(root,{...result,profileBinding:null},now),/not authoritative/);
  assert.throws(()=>recordReadOnlyOpenCd(root,{...result,observedAt:'2026-09-28T00:46:00Z'},now),/not authoritative/);
  assert.throws(()=>recordReadOnlyOpenCd(root,{...result,evidence:{source:'none',authoritative:false}},now),/not authoritative/);
  const first=recordReadOnlyOpenCd(root,result,now);
  assert.equal(first.businessDate,'2026-09-29');
  const report=JSON.parse(fs.readFileSync(first.file,'utf8'));
  assert.equal(report.sites.length,1);
  assert.equal(report.sites[0].origin,'https://open.cd');
  recordReadOnlyOpenCd(root,result,now);
  assert.equal(JSON.parse(fs.readFileSync(first.file,'utf8')).sites.length,1);
});
