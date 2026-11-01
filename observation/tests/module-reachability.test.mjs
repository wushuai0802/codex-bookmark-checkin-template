import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {analyzeRepository,renderModuleStatus} from '../../tools/module-reachability.mjs';

function fixture(t,contents){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'module-reachability-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [file,source] of Object.entries(contents)){
    const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,source);
  }
  return root;
}
const analyze=(root,entry='observation/src/main.mjs')=>analyzeRepository({root,entrypoints:[entry]});
const status=(report,file)=>report.records.find(record=>record.file===file)?.status;
const edge=(report,from,to,kind)=>report.edges.some(item=>item.from===from&&item.to===to&&item.kind===kind);

test('static imports, side effects and re-exports form a cyclic graph without executing it',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':"throw Error('must never execute'); import './a.mjs'; export {b} from './b.mjs';",
    'observation/src/a.mjs':"import './main.mjs';",'observation/src/b.mjs':'export const b=1;',
  });
  const report=analyze(root);
  assert.deepEqual(report.records.map(record=>record.status),['现役','现役','现役']);
  assert.ok(edge(report,'observation/src/main.mjs','observation/src/b.mjs','esm-static'));
});

test('dynamic literal import is reachable, comments, strings and regexes are not imports',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':[
      "await import('./live.mjs');", "// import('./ghost.mjs')", "const text=\"import('./ghost.mjs')\";",
      "const regex=/import\\('ghost'\\)/;", "const object={import(value){return value;}};",
    ].join('\n'),
    'observation/src/live.mjs':'','observation/src/ghost.mjs':'',
  });
  const report=analyze(root);
  assert.ok(edge(report,'observation/src/main.mjs','observation/src/live.mjs','esm-dynamic'));
  assert.equal(status(report,'observation/src/ghost.mjs'),'待确认');
  assert.equal(report.unresolved.length,0);
});

test('computed imports resolve role-bound URL/path wrappers without importing the target',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':"await import(pathToFileURL(path.join(legacyRoot,'src','live.mjs')).href);",
    'execution/src/live.mjs':"throw Error('do not load');",
  });
  const report=analyze(root);
  assert.ok(edge(report,'observation/src/main.mjs','execution/src/live.mjs','esm-dynamic'));
});

test('Join-Path and PowerShell dot-sourcing through a variable follow the script directory',t=>{
  const root=fixture(t,{
    'execution/scripts/main.ps1':"$helper = Join-Path $PSScriptRoot 'helper.ps1'\n. $helper\n. (Join-Path $PSScriptRoot 'other.ps1')\n. \"$PSScriptRoot/direct.ps1\"\n. ./bare.ps1\n. $PSScriptRoot/bound.ps1",
    'execution/scripts/helper.ps1':'','execution/scripts/other.ps1':'','execution/scripts/direct.ps1':'',
    'execution/scripts/bare.ps1':'','execution/scripts/bound.ps1':'',
  });
  const report=analyze(root,'execution/scripts/main.ps1');
  for(const name of ['helper','other','direct','bare','bound'])assert.equal(status(report,`execution/scripts/${name}.ps1`),'现役');
  assert.ok(edge(report,'execution/scripts/main.ps1','execution/scripts/helper.ps1','ps-call'));
});

test('PowerShell member access is not a dot-source; comments do not create edges',t=>{
  const root=fixture(t,{
    'execution/scripts/main.ps1':"$value = (Get-Date).ToString()\n# . (Join-Path $PSScriptRoot 'ghost.ps1')\n$value.Length",
    'execution/scripts/ghost.ps1':'',
  });
  const report=analyze(root,'execution/scripts/main.ps1');
  assert.equal(report.edges.length,0);assert.equal(report.unresolved.length,0);
});

test('a path.join variable and conditional spawn/execFile targets are both reachable',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':"const cli=path.join(legacyRoot,'scripts',scheduled?'one.ps1':'two.ps1'); spawn('pwsh',['-File',cli]); execFile('pwsh',['-File',cli]);",
    'execution/scripts/one.ps1':'','execution/scripts/two.ps1':'',
  });
  const report=analyze(root);
  for(const name of ['one','two'])assert.equal(status(report,`execution/scripts/${name}.ps1`),'现役');
});

test('unresolved dynamic import retains candidates rather than proving they are unused',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':'await import(moduleFromConfig);',
    'observation/src/ownership-transition.mjs':'',
  });
  const report=analyze(root);
  assert.equal(report.unresolved[0].kind,'esm-dynamic');
  assert.ok(report.unresolved[0].candidates.includes('observation/src/ownership-transition.mjs'));
  assert.equal(status(report,'observation/src/ownership-transition.mjs'),'待确认');
});

test('unknown reassignment invalidates an earlier literal and JS bindings retain case',t=>{
  const root=fixture(t,{
    'observation/src/main.mjs':"let target='./live.mjs'; target=config.module; await import(target); const Target='./other.mjs'; await import(Target);",
    'observation/src/live.mjs':'','observation/src/other.mjs':'','observation/src/ownership-transition.mjs':'',
  });
  const report=analyze(root);
  assert.ok(report.unresolved.some(item=>item.kind==='esm-dynamic'&&item.candidates.includes('observation/src/ownership-transition.mjs')));
  assert.ok(edge(report,'observation/src/main.mjs','observation/src/other.mjs','esm-dynamic'));
  assert.equal(status(report,'observation/src/ownership-transition.mjs'),'待确认');
});

test('unbounded Join-Path and process paths are explicitly unresolved',t=>{
  const root=fixture(t,{
    'execution/scripts/main.ps1':'. (Join-Path $PSScriptRoot $scriptName)',
    'observation/src/main.mjs':"const cli=path.join(base,name); spawn(process.execPath,[cli]);",
  });
  const report=analyzeRepository({root,entrypoints:['execution/scripts/main.ps1','observation/src/main.mjs']});
  assert.ok(report.unresolved.some(item=>item.kind==='ps-call'));
  assert.ok(report.unresolved.some(item=>item.kind==='node-process'));
});

test('npm runnable scripts are manual entries and syntax checks never revive historical modules',t=>{
  const root=fixture(t,{
    'observation/package.json':JSON.stringify({scripts:{'simulate:candidate':'node src/candidate-simulator.mjs','lint:domain':'node --check src/ownership-transition.mjs && node src/real-command.mjs'}}),
    'observation/src/candidate-simulator.mjs':'','observation/src/ownership-transition.mjs':'',
    'observation/src/real-command.mjs':'',
  });
  const report=analyzeRepository({root});
  assert.equal(status(report,'observation/src/candidate-simulator.mjs'),'运维手动');
  assert.equal(status(report,'observation/src/ownership-transition.mjs'),'历史审计');
  assert.equal(status(report,'observation/src/real-command.mjs'),'运维手动');
  assert.equal(report.npmScripts.find(script=>script.name==='lint:domain').targets[0].checkOnly,true);
});

test('Harvest Python scripts and their local Python dependencies are reachable',t=>{
  const root=fixture(t,{
    'observation/scripts/main.ps1':"$script = Join-Path $PSScriptRoot 'harvest-observe.py'",
    'observation/scripts/harvest-observe.py':'import json\nfrom helper import observe\n',
    'observation/scripts/helper.py':'def observe(): pass\n',
  });
  const report=analyze(root,'observation/scripts/main.ps1');
  assert.equal(status(report,'observation/scripts/harvest-observe.py'),'现役');
  assert.equal(status(report,'observation/scripts/helper.py'),'现役');
});

test('release destinations are mappings, not execution edges to all shipped files',t=>{
  const root=fixture(t,{
    'tools/release-lib.mjs':"const map=new Map([['operations/scripts/unused.ps1','observation/scripts/unused.ps1']]);",
    'observation/scripts/unused.ps1':'','observation/src/ownership-transition.mjs':'',
  });
  const report=analyzeRepository({root});
  assert.equal(report.deploymentMappings.length,1);
  assert.equal(status(report,'observation/src/ownership-transition.mjs'),'历史审计');
  assert.notEqual(status(report,'observation/scripts/unused.ps1'),'现役');
});

test('missing runtime hook stays unresolved without reading private runtime/configuration',t=>{
  const root=fixture(t,{
    'observation/scripts/main.ps1':"$script=Join-Path $opsRoot 'scripts/Private-Hook.ps1'",
    'observation/config/runtime.local.json':'private marker',
    'observation/data/profile/Local State':'private marker',
  });
  const hashTree=()=>{
    const result=[];
    const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else result.push([path.relative(root,file),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);}};
    walk(root);return result;
  };
  const before=hashTree(),report=analyze(root,'observation/scripts/main.ps1');
  assert.deepEqual(hashTree(),before);
  assert.ok(report.unresolved.some(item=>item.candidates.includes('observation/scripts/Private-Hook.ps1')));
  assert.ok(!JSON.stringify(report).includes('private marker'));
  assert.equal(report.records.length,1);
  assert.equal(renderModuleStatus(report),renderModuleStatus(analyze(root,'observation/scripts/main.ps1')));
});
