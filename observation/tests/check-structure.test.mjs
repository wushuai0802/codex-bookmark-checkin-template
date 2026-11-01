import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {checkStructure,readModuleStatuses,historicalImportErrors} from '../scripts/check-structure.mjs';

function fixture(t,statement){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'structure-history-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'observation/src'),{recursive:true});fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'observation/src/dashboard-server.mjs'),statement);
  fs.writeFileSync(path.join(root,'observation/src/ownership-transition.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(root,'docs/module-status.md'),[
    '| 文件 | 类别 | 依据 |','| --- | --- | --- |',
    '| `observation/src/dashboard-server.mjs` | 现役 | fixture |',
    '| `observation/src/ownership-transition.mjs` | 历史审计 | reviewed fixture |',
  ].join('\n'));
  return root;
}

for(const statement of ["import './ownership-transition.mjs';", "await import('./ownership-transition.mjs');", "export {value} from './ownership-transition.mjs';", 'await import(pathFromConfig);', "await import('./'+moduleName+'.mjs');"]){
  test('new production import of a reviewed historical module fails: '+statement,t=>{
    const root=fixture(t,statement),result=checkStructure({repositoryRoot:root});
    assert.ok(result.errors.some(error=>/active code cannot import historical module|unresolved active import may reference historical module/.test(error)));
  });
}

test('a reasoned exact-edge whitelist permits only that historical dependency',t=>{
  const root=fixture(t,"import './ownership-transition.mjs';");
  const exception={from:'observation/src/dashboard-server.mjs',to:'observation/src/ownership-transition.mjs',reason:'Fixture compatibility reader requires the audited historical model.'};
  assert.deepEqual(checkStructure({repositoryRoot:root,exceptions:[exception]}).errors,[]);
  assert.ok(checkStructure({repositoryRoot:root,exceptions:[{...exception,from:'observation/src/other.mjs'}]}).errors.length);
  assert.ok(checkStructure({repositoryRoot:root,exceptions:[{...exception,reason:''}]}).errors.length);
});

test('history fence covers a new intermediate production caller and both packages',()=>{
  const report={entrypoints:[{file:'execution/src/main.mjs'}],records:[],edges:[
    {from:'execution/src/main.mjs',to:'observation/scripts/new-helper.mjs',kind:'esm-dynamic',line:1},
    {from:'observation/scripts/new-helper.mjs',to:'observation/src/old.mjs',kind:'esm-static',line:2},
  ]};
  assert.match(historicalImportErrors(report,new Map([['observation/src/old.mjs','历史审计']]))[0],/new-helper/);
});

test('missing or duplicate reviewed status cannot silently disable the fence',t=>{
  const root=fixture(t,'');fs.unlinkSync(path.join(root,'docs/module-status.md'));
  assert.ok(checkStructure({repositoryRoot:root}).errors.some(error=>error.includes('module history fence')));
  assert.throws(()=>readModuleStatuses(''),/missing/);
  const row='| `observation/src/old.mjs` | 历史审计 | fixture |';
  assert.throws(()=>readModuleStatuses(row+'\n'+row),/duplicate/);
});
