import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadSameDayHarvestCache} from '../src/shadow-run.mjs';

test('same-day Harvest display cache preserves proof and rejects stale, future, or invalid input', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harvest-display-cache-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'report.json'),now=new Date('2026-09-29T04:00:00Z');
  const good={schemaVersion:1,source:'harvest',businessDate:'2026-09-29',generatedAt:'2026-09-29T01:30:00Z',
    sites:[{origin:'https://pt.example',status:'signed',observedAt:'2026-09-29T01:20:00Z'}]};
  fs.writeFileSync(file,JSON.stringify(good));
  assert.deepEqual(loadSameDayHarvestCache(file,now),good);
  for(const changed of [
    {businessDate:'2026-09-28'}, {generatedAt:'2026-09-28T01:30:00Z'},
    {generatedAt:'2026-09-29T04:02:00Z'}, {generatedAt:'invalid'},
    {source:'untrusted'}, {schemaVersion:2}, {sites:{}},
  ]){fs.writeFileSync(file,JSON.stringify({...good,...changed}));assert.equal(loadSameDayHarvestCache(file,now),undefined);}
  fs.writeFileSync(file,'invalid json');
  assert.equal(loadSameDayHarvestCache(file,now),undefined);
  assert.equal(loadSameDayHarvestCache(path.join(dir,'missing.json'),now),undefined);
  assert.equal(loadSameDayHarvestCache(undefined,now),undefined);
});
