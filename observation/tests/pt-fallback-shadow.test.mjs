import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildSnapshot} from '../src/bridge.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const legacyRoot=path.join(root,'tests/fixtures/legacy');

test('shadow import displays a PT-only receipt without changing daily task counts',t=>{
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'pt-shadow-import-'));
  t.after(()=>fs.rmSync(work,{recursive:true,force:true}));
  const day='2026-09-02',generatedAt='2026-09-02T14:00:00Z',origin='https://pt.example';
  const catalog=path.join(work,'catalog.json'),receipt=path.join(work,'receipt.json'),out=path.join(work,'snapshot.json');
  fs.writeFileSync(catalog,JSON.stringify({sites:[{origin,entryUrl:`${origin}/attendance`}]}));
  fs.writeFileSync(receipt,JSON.stringify({source:'execution-supplement',businessDate:day,sites:[{origin,status:'already_signed',observedAt:'2026-09-02T03:00:00Z',evidence:{source:'page_text',authoritative:true,summary:'done'}}]}));
  execFileSync(process.execPath,[path.join(root,'src/shadow-run.mjs'),'--legacy-root',legacyRoot,'--generated-at',generatedAt,
    '--monitor-catalog',catalog,'--pt-fallback-file',receipt,'--out',out],{cwd:root,encoding:'utf8'});
  const imported=JSON.parse(fs.readFileSync(out,'utf8'));
  const before=buildSnapshot({legacyRoot,generatedAt});
  assert.equal(imported.planHash,before.planHash);
  assert.equal(imported.counts.executionUnits,before.counts.executionUnits);
  assert.equal(imported.ptStatus.sites.find(site=>site.origin===origin).effective.source,'execution-supplement');
  const source=fs.readFileSync(path.join(root,'src/shadow-run.mjs'),'utf8');
  assert.match(source,/pt-fallback-results-\$\{businessDate\}\.json/);
});
