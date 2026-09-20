import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('syntax checker scans source, scripts and public modules',()=>{
  const source=fs.readFileSync(new URL('../scripts/check-js-syntax.mjs',import.meta.url),'utf8');
  assert.match(source,/directories=\['src','scripts','public'\]/);assert.match(source,/--check/);
});
